// Ankündigungen der Hauptwebseite - 1:1 gleiches System wie bei der Team-
// Website (api/team/announcements.js dort): Titel/Inhalt/Farbe, Erstellen
// postet zusätzlich zu Discord (siehe lib/_discord.js). Anders als dort ist
// das GET hier öffentlich (jeder Besucher sieht die "Ankündigungen"-Seite,
// auch als Gast) - nur Erstellen/Bearbeiten/Löschen ist auf Teamler mit
// Ankündigungsrecht beschränkt (siehe requireAnnouncementCreator).
const crypto = require('crypto');
const { getJSON, setJSON } = require('../lib/_kv');
const { getAccountIdFromRequest, loadUsers, loadTeamRoster } = require('../lib/_account');
const { ANNOUNCEMENT_CREATOR_ROLES } = require('../lib/_teamRoles');
const {
  postAnnouncementToDiscord,
  updateAnnouncementOnDiscord,
  deleteAnnouncementFromDiscord,
} = require('../lib/_discord');

const KEY = 'drp_main:announcements';
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = '#6d64f2';
// Discord-Limits für Embeds: Titel max. 256, Beschreibung max. 4096 Zeichen
// (inkl. der Fußzeile, die wir anhängen). Ohne diese Grenzen lehnt Discord zu
// lange Ankündigungen ab und sie landen nie im Kanal.
const MAX_TITLE = 250;
const MAX_CONTENT = 3500;

function str(v) {
  return typeof v === 'string' ? v : '';
}

// Die Discord-Nachrichten-ID ist intern (für die Synchronisierung) und geht
// nicht ans Frontend.
function publicAnnouncement(a) {
  const { discordMessageId, ...rest } = a;
  return rest;
}

// Nur eingeloggte Teamler-Konten, deren AKTUELLER Team-Rang (live aus der
// geteilten Teamliste, nicht zwischengespeichert) zu den Rängen mit
// "announcementCreate"-Recht gehört, dürfen Ankündigungen erstellen/
// bearbeiten/löschen - siehe ANNOUNCEMENT_CREATOR_ROLES in lib/_teamRoles.js.
async function requireAnnouncementCreator(req, res) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return null;
  }
  const users = await loadUsers();
  const account = users.find((u) => u.id === accountId);
  if (!account || !account.linkedTeamDiscordId) {
    res.status(403).json({ error: 'Nur Teammitglieder mit Ankündigungsrecht können das.' });
    return null;
  }
  const roster = await loadTeamRoster();
  const teamEntry = roster.find((r) => r.discordId === account.linkedTeamDiscordId);
  if (!teamEntry || !ANNOUNCEMENT_CREATOR_ROLES.includes(teamEntry.roleId)) {
    res.status(403).json({ error: 'Dein Team-Rang darf keine Ankündigungen erstellen.' });
    return null;
  }
  return { account, teamEntry };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const list = (await getJSON(KEY)) || [];
      list.sort((a, b) => b.createdAt - a.createdAt);
      return res.status(200).json({ announcements: list.map(publicAnnouncement) });
    }

    if (req.method === 'POST') {
      const ctx = await requireAnnouncementCreator(req, res);
      if (!ctx) return;
      const { title, content, color } = req.body || {};
      const cleanTitle = str(title).trim();
      const cleanContent = str(content).trim();
      if (!cleanTitle || !cleanContent) {
        return res.status(400).json({ error: 'Titel und Inhalt sind erforderlich.' });
      }
      if (cleanTitle.length > MAX_TITLE) {
        return res.status(400).json({ error: `Der Titel darf höchstens ${MAX_TITLE} Zeichen haben.` });
      }
      if (cleanContent.length > MAX_CONTENT) {
        return res.status(400).json({ error: `Der Inhalt darf höchstens ${MAX_CONTENT} Zeichen haben.` });
      }
      const cleanColor = HEX_COLOR_RE.test(color) ? color : DEFAULT_COLOR;
      const list = (await getJSON(KEY)) || [];
      const entry = {
        id: crypto.randomUUID(),
        title: cleanTitle,
        content: cleanContent,
        color: cleanColor,
        createdByName: ctx.account.name,
        createdAt: Date.now(),
      };
      // Erst in Discord posten (liefert die Nachrichten-ID für die spätere
      // Synchronisierung), dann speichern. Schlägt das Speichern fehl, wird
      // die Discord-Nachricht wieder entfernt, damit dort nichts "verwaist".
      const messageId = await postAnnouncementToDiscord(entry);
      if (messageId) entry.discordMessageId = messageId;
      list.push(entry);
      try {
        await setJSON(KEY, list);
      } catch (err) {
        await deleteAnnouncementFromDiscord(entry);
        throw err;
      }
      return res.status(200).json({ ok: true, announcement: publicAnnouncement(entry) });
    }

    if (req.method === 'PUT') {
      const ctx = await requireAnnouncementCreator(req, res);
      if (!ctx) return;
      const { id, title, content, color } = req.body || {};
      const list = (await getJSON(KEY)) || [];
      const idx = list.findIndex((a) => a.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Ankündigung nicht gefunden.' });
      const cleanTitle = str(title).trim();
      const cleanContent = str(content).trim();
      if (cleanTitle.length > MAX_TITLE) {
        return res.status(400).json({ error: `Der Titel darf höchstens ${MAX_TITLE} Zeichen haben.` });
      }
      if (cleanContent.length > MAX_CONTENT) {
        return res.status(400).json({ error: `Der Inhalt darf höchstens ${MAX_CONTENT} Zeichen haben.` });
      }
      if (cleanTitle) list[idx].title = cleanTitle;
      if (cleanContent) list[idx].content = cleanContent;
      if (color !== undefined && HEX_COLOR_RE.test(color)) list[idx].color = color;
      list[idx].updatedByName = ctx.account.name;
      list[idx].updatedAt = Date.now();
      await setJSON(KEY, list);
      // Änderung auch in Discord nachziehen (nur für Ankündigungen, die
      // bereits mit Nachrichten-ID gepostet wurden).
      await updateAnnouncementOnDiscord(list[idx]);
      return res.status(200).json({ ok: true, announcement: publicAnnouncement(list[idx]) });
    }

    if (req.method === 'DELETE') {
      const ctx = await requireAnnouncementCreator(req, res);
      if (!ctx) return;
      const { id } = req.body || {};
      const list = (await getJSON(KEY)) || [];
      const removed = list.find((a) => a.id === id);
      if (!removed) return res.status(404).json({ error: 'Ankündigung nicht gefunden.' });
      await setJSON(KEY, list.filter((a) => a.id !== id));
      // Erst nach erfolgreichem Speichern in Discord löschen.
      await deleteAnnouncementFromDiscord(removed);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};

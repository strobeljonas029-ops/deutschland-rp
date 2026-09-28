// Partnerserver-Liste der Hauptwebseite ("Partner"-Seite). Anzeigen ist
// öffentlich (auch als Gast), Hinzufügen/Bearbeiten/Entfernen ist auf
// Partnerschaft Verwaltung + die komplette Höhere Ebene beschränkt (siehe
// PARTNER_MANAGER_ROLES in lib/_teamRoles.js) - live anhand des aktuellen
// Team-Rangs geprüft, nicht zwischengespeichert (gleiches Muster wie
// requireAnnouncementCreator in api/announcements.js).
//
// Jeder Partner gehört zu einer Kategorie (Klein/Mittel/Groß/Sonder, siehe
// lib/_partnerCategories.js). Nach JEDER Änderung wird die Partnerliste
// zusätzlich in Discord aktualisiert (siehe syncPartnersToDiscord in
// lib/_discord.js).
const crypto = require('crypto');
const { getJSON, setJSON } = require('../lib/_kv');
const { getAccountIdFromRequest, loadUsers, loadTeamRoster } = require('../lib/_account');
const { PARTNER_MANAGER_ROLES } = require('../lib/_teamRoles');
const { PARTNER_CATEGORIES, isValidCategory, categoryOf } = require('../lib/_partnerCategories');
const { syncPartnersToDiscord } = require('../lib/_discord');

const KEY = 'drp_main:partners';
const MAX_NAME = 60;
const MAX_LINK = 300;

async function requirePartnerManager(req, res) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return null;
  }
  const users = await loadUsers();
  const account = users.find((u) => u.id === accountId);
  if (!account || !account.linkedTeamDiscordId) {
    res.status(403).json({ error: 'Nur Teammitglieder mit Partnerschafts-Recht können das.' });
    return null;
  }
  const roster = await loadTeamRoster();
  const entry = roster.find((r) => r.discordId === account.linkedTeamDiscordId);
  if (!entry || !PARTNER_MANAGER_ROLES.includes(entry.roleId)) {
    res.status(403).json({ error: 'Dein Team-Rang darf keine Partner verwalten.' });
    return null;
  }
  return { account, entry };
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

// Gibt den Link zurück oder null, wenn er ungültig ist (kein http(s), Leerzeichen).
function cleanInviteLink(v) {
  const link = str(v).trim().slice(0, MAX_LINK);
  if (!/^https?:\/\/\S+$/i.test(link)) return null;
  return link;
}

// Alte Einträge ohne Kategorie werden als "Klein Partner" ausgeliefert.
function publicPartner(p) {
  return { ...p, category: categoryOf(p) };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const list = (await getJSON(KEY)) || [];
      list.sort((a, b) => b.createdAt - a.createdAt);
      return res.status(200).json({
        partners: list.map(publicPartner),
        categories: PARTNER_CATEGORIES.map(({ id, label }) => ({ id, label })),
      });
    }

    if (req.method === 'POST') {
      const ctx = await requirePartnerManager(req, res);
      if (!ctx) return;
      const { name, inviteLink, category } = req.body || {};
      const cleanName = str(name).trim().slice(0, MAX_NAME);
      const cleanLink = cleanInviteLink(inviteLink);
      if (!cleanName || !str(inviteLink).trim()) {
        return res.status(400).json({ error: 'Name und Invite-Link sind erforderlich.' });
      }
      if (!cleanLink) {
        return res.status(400).json({ error: 'Bitte einen gültigen Link (http:// oder https://, ohne Leerzeichen) angeben.' });
      }
      if (!isValidCategory(category)) {
        return res.status(400).json({ error: 'Bitte eine Partner-Kategorie auswählen.' });
      }
      const list = (await getJSON(KEY)) || [];
      const partner = {
        id: crypto.randomUUID(),
        name: cleanName,
        inviteLink: cleanLink,
        category,
        addedByName: ctx.account.name,
        createdAt: Date.now(),
      };
      list.push(partner);
      await setJSON(KEY, list);
      await syncPartnersToDiscord(list);
      return res.status(200).json({ ok: true, partner });
    }

    // Bearbeiten (Name, Link, Kategorie). Alte Partner ohne Kategorie lassen
    // sich hierüber einer Kategorie zuordnen.
    if (req.method === 'PUT') {
      const ctx = await requirePartnerManager(req, res);
      if (!ctx) return;
      const { id, name, inviteLink, category } = req.body || {};
      const list = (await getJSON(KEY)) || [];
      const idx = list.findIndex((p) => p.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Partner nicht gefunden.' });

      if (name !== undefined) {
        const cleanName = str(name).trim().slice(0, MAX_NAME);
        if (!cleanName) return res.status(400).json({ error: 'Name darf nicht leer sein.' });
        list[idx].name = cleanName;
      }
      if (inviteLink !== undefined) {
        const cleanLink = cleanInviteLink(inviteLink);
        if (!cleanLink) {
          return res.status(400).json({ error: 'Bitte einen gültigen Link (http:// oder https://, ohne Leerzeichen) angeben.' });
        }
        list[idx].inviteLink = cleanLink;
      }
      if (category !== undefined) {
        if (!isValidCategory(category)) {
          return res.status(400).json({ error: 'Ungültige Partner-Kategorie.' });
        }
        list[idx].category = category;
      }
      list[idx].updatedByName = ctx.account.name;
      list[idx].updatedAt = Date.now();
      await setJSON(KEY, list);
      await syncPartnersToDiscord(list);
      return res.status(200).json({ ok: true, partner: publicPartner(list[idx]) });
    }

    if (req.method === 'DELETE') {
      const ctx = await requirePartnerManager(req, res);
      if (!ctx) return;
      const { id } = req.body || {};
      const list = (await getJSON(KEY)) || [];
      const next = list.filter((p) => p.id !== id);
      if (next.length === list.length) return res.status(404).json({ error: 'Partner nicht gefunden.' });
      await setJSON(KEY, next);
      await syncPartnersToDiscord(next);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};

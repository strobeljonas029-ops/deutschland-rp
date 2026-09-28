const crypto = require('crypto');
const { requirePerm, getSessionFromRequest } = require('../../lib/team/_session');
const { resolveAccountName } = require('../../lib/team/_account');
const { getJSON, setJSON } = require('../../lib/_kv');
const { cleanPings, postAnnouncementToDiscord } = require('../../lib/team/_discord');
const { blockIfLockedOut } = require('../../lib/team/_lockdown');

// createdByRole/updatedByRole enthalten trotz des Feldnamens (aus
// Kompatibilitätsgründen unverändert gelassen) den KONTONAMEN des
// Erstellers/Bearbeiters, nicht dessen Rang.
const KEY = 'test_team:announcements'; // array of { id, title, content, color, pings, eventId?, createdByRole, createdAt }
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = '#22c55e';

// Optionale Verknüpfung mit einem Kalender-Event (siehe extra/calendar.js).
// Auf der Team-Website erscheint dann ein "Zum Event"-Button.
function cleanEventId(v) {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null;
}

module.exports = async function handler(req, res) {
  try {
    // Lockdown: schreibende Zugriffe sind während eines aktiven Lockdowns
    // gesperrt, außer für die Ränge, die ihn selbst aufheben dürfen.
    if (await blockIfLockedOut(req, res, getSessionFromRequest(req))) return;

    if (req.method === 'GET') {
      const session = getSessionFromRequest(req);
      if (!session) {
        return res.status(401).json({ error: 'Nicht angemeldet.' });
      }
      const list = (await getJSON(KEY)) || [];
      list.sort((a, b) => b.createdAt - a.createdAt);
      return res.status(200).json({ announcements: list });
    }

    if (req.method === 'POST') {
      const session = requirePerm(req, res, 'announcementCreate');
      if (!session) return;
      const { title, content, color, pings, eventId } = req.body || {};
      if (!title || !content) {
        return res.status(400).json({ error: 'Titel und Inhalt sind erforderlich.' });
      }
      const cleanColor = HEX_COLOR_RE.test(color) ? color : DEFAULT_COLOR;
      const list = (await getJSON(KEY)) || [];
      const entry = {
        id: crypto.randomUUID(),
        title,
        content,
        color: cleanColor,
        pings: cleanPings(pings),
        eventId: cleanEventId(eventId),
        createdByRole: await resolveAccountName(session),
        createdAt: Date.now(),
      };
      list.push(entry);
      await setJSON(KEY, list);
      await postAnnouncementToDiscord(entry);
      return res.status(200).json({ ok: true, announcement: entry });
    }

    if (req.method === 'PUT') {
      const session = requirePerm(req, res, 'announcementCreate');
      if (!session) return;
      const { id, title, content, color, pings, eventId } = req.body || {};
      const list = (await getJSON(KEY)) || [];
      const idx = list.findIndex((a) => a.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Ankündigung nicht gefunden.' });
      if (title !== undefined) list[idx].title = title;
      if (content !== undefined) list[idx].content = content;
      if (color !== undefined && HEX_COLOR_RE.test(color)) list[idx].color = color;
      if (pings !== undefined) list[idx].pings = cleanPings(pings);
      if (eventId !== undefined) list[idx].eventId = cleanEventId(eventId); // null/'' = Verknüpfung entfernen
      list[idx].updatedByRole = await resolveAccountName(session);
      list[idx].updatedAt = Date.now();
      await setJSON(KEY, list);
      return res.status(200).json({ ok: true, announcement: list[idx] });
    }

    if (req.method === 'DELETE') {
      const session = requirePerm(req, res, 'announcementCreate');
      if (!session) return;
      const { id } = req.body || {};
      const list = (await getJSON(KEY)) || [];
      const next = list.filter((a) => a.id !== id);
      await setJSON(KEY, next);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};

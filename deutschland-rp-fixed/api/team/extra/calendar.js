// Kalender: einfacher Team-Kalender. Lesen darf jedes angemeldete Mitglied,
// Events erstellen/bearbeiten/löschen nur die komplette Höhere Ebene und
// Team Verwaltung (requireHigherOrTeamVerwaltung). Ankündigungen können mit
// einem Event verknüpft werden (announcement.eventId, siehe announcements.js).
//
// Eigene Datei (statt neuer Resource in [resource].js) - eine statische
// Route hat in Vercel Vorrang vor dem dynamischen [resource]-Segment.
// Damit bleiben wir mit 11 Functions unter dem Hobby-Limit von 12.
const crypto = require('crypto');
const { getSessionFromRequest, requireHigherOrTeamVerwaltung } = require('../../../lib/team/_session');
const { resolveAccountName } = require('../../../lib/team/_account');
const { getJSON, setJSON } = require('../../../lib/_kv');
const { blockIfLockedOut } = require('../../../lib/team/_lockdown');

const KEY = 'test_team:calendar';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

function canManage(session) {
  return Boolean(session && (session.tier === 3 || session.roleId === 'team_verwaltung'));
}

function clean(body) {
  const title = (body.title || '').trim().slice(0, 120);
  const description = (body.description || '').trim().slice(0, 2000);
  const date = (body.date || '').trim();
  const startTime = (body.startTime || '').trim();
  const endTime = (body.endTime || '').trim();
  if (!title) return { error: 'Bitte einen Titel angeben.' };
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) return { error: 'Bitte ein gültiges Datum angeben.' };
  if (startTime && !TIME_RE.test(startTime)) return { error: 'Ungültige Startzeit.' };
  if (endTime && !TIME_RE.test(endTime)) return { error: 'Ungültige Endzeit.' };
  const color = HEX_COLOR_RE.test(body.color) ? body.color : '#6d64f2';
  return { value: { title, description, date, startTime: startTime || null, endTime: endTime || null, color } };
}

module.exports = async function handler(req, res) {
  try {
    if (await blockIfLockedOut(req, res, getSessionFromRequest(req))) return;

    if (req.method === 'GET') {
      const session = getSessionFromRequest(req);
      if (!session) return res.status(401).json({ error: 'Nicht angemeldet.' });
      const list = (await getJSON(KEY)) || [];
      list.sort((a, b) => (a.date + (a.startTime || '')).localeCompare(b.date + (b.startTime || '')));
      return res.status(200).json({ items: list, canManage: canManage(session) });
    }

    if (req.method === 'POST') {
      const session = requireHigherOrTeamVerwaltung(req, res);
      if (!session) return;
      const parsed = clean(req.body || {});
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      const list = (await getJSON(KEY)) || [];
      const entry = {
        id: crypto.randomUUID(),
        ...parsed.value,
        createdByName: await resolveAccountName(session),
        createdAt: Date.now(),
      };
      list.push(entry);
      await setJSON(KEY, list);
      return res.status(200).json({ ok: true, item: entry });
    }

    if (req.method === 'PUT') {
      const session = requireHigherOrTeamVerwaltung(req, res);
      if (!session) return;
      const body = req.body || {};
      const list = (await getJSON(KEY)) || [];
      const idx = list.findIndex((e) => e.id === body.id);
      if (idx === -1) return res.status(404).json({ error: 'Event nicht gefunden.' });
      const parsed = clean(body);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      list[idx] = { ...list[idx], ...parsed.value, updatedByName: await resolveAccountName(session), updatedAt: Date.now() };
      await setJSON(KEY, list);
      return res.status(200).json({ ok: true, item: list[idx] });
    }

    if (req.method === 'DELETE') {
      const session = requireHigherOrTeamVerwaltung(req, res);
      if (!session) return;
      const { id } = req.body || {};
      const list = (await getJSON(KEY)) || [];
      await setJSON(KEY, list.filter((e) => e.id !== id));
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};

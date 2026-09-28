// Schichtensystem (On Duty / Off Duty): jedes Teammitglied kann sich On Duty
// setzen; beim Off Duty wird die Schichtzeit gespeichert. Eigene Statistik +
// Leaderboard aller Teammitglieder. Zeiten manuell hinzufügen/bearbeiten/
// löschen dürfen nur die komplette Höhere Ebene und Team Verwaltung.
//
// Datenmodell:
//   test_team:shift_active   { [accountId]: { startedAt } }      laufende Schichten
//   test_team:shift_entries  [{ id, accountId, name, start, end, ms, type, note, byName }]
//   type: 'shift' (Off Duty) | 'manual' (manuell hinzugefügt, ms darf negativ sein = Korrektur)
// Die Gesamtzeit eines Kontos ist immer die Summe seiner Einträge (kein
// separater Zähler, der aus dem Takt geraten könnte).
const crypto = require('crypto');
const { getSessionFromRequest } = require('../../../lib/team/_session');
const { getRoleDef } = require('../../../lib/team/_ranks');
const { resolveAccountName } = require('../../../lib/team/_account');
const { getJSON, setJSON } = require('../../../lib/_kv');
const { blockIfLockedOut } = require('../../../lib/team/_lockdown');

const ACTIVE_KEY = 'test_team:shift_active';
const ENTRIES_KEY = 'test_team:shift_entries';
const ROSTER_KEY = 'test_team:roster';
const MAX_MANUAL_MINUTES = 100000;
const MIN_SHIFT_MS = 1000; // kürzere "Schichten" (versehentlicher Doppelklick) werden verworfen

function canManage(session) {
  return Boolean(session && (session.tier === 3 || session.roleId === 'team_verwaltung'));
}

function parseMinutes(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > MAX_MANUAL_MINUTES) return null;
  return n;
}

module.exports = async function handler(req, res) {
  try {
    const session = getSessionFromRequest(req);
    if (!session) return res.status(401).json({ error: 'Nicht angemeldet.' });
    if (!session.accountId) return res.status(400).json({ error: 'Kein Konto mit dieser Sitzung verknüpft.' });
    if (await blockIfLockedOut(req, res, session)) return;

    const manage = canManage(session);
    const active = (await getJSON(ACTIVE_KEY)) || {};
    const entries = (await getJSON(ENTRIES_KEY)) || [];
    const now = Date.now();

    if (req.method === 'GET') {
      const roster = (await getJSON(ROSTER_KEY)) || [];
      const totals = {};
      entries.forEach((e) => { totals[e.accountId] = (totals[e.accountId] || 0) + e.ms; });
      // Versteckte Konten (Master-Zugang) tauchen nur für die Inhaber-Ebene auf.
      const leaderboard = roster
        .filter((r) => { const d = getRoleDef(r.roleId); return session.isAdmin || !(d && d.hidden); })
        .map((r) => {
          const d = getRoleDef(r.roleId);
          return {
            accountId: r.id,
            name: r.name,
            roleName: d ? d.name : '–',
            totalMs: totals[r.id] || 0,
            activeSince: active[r.id] ? active[r.id].startedAt : null,
          };
        })
        .sort((a, b) => (b.totalMs + (b.activeSince ? now - b.activeSince : 0)) - (a.totalMs + (a.activeSince ? now - a.activeSince : 0)));
      const out = {
        now,
        me: {
          accountId: session.accountId,
          activeSince: active[session.accountId] ? active[session.accountId].startedAt : null,
          totalMs: totals[session.accountId] || 0,
          shiftCount: entries.filter((e) => e.accountId === session.accountId && e.type === 'shift').length,
        },
        leaderboard,
        canManage: manage,
      };
      if (manage) {
        out.entries = entries.slice().sort((a, b) => b.end - a.end).slice(0, 100);
      }
      return res.status(200).json(out);
    }

    if (req.method === 'POST') {
      const { action } = req.body || {};

      if (action === 'start') {
        if (active[session.accountId]) return res.status(400).json({ error: 'Du bist bereits On Duty.' });
        active[session.accountId] = { startedAt: now };
        await setJSON(ACTIVE_KEY, active);
        return res.status(200).json({ ok: true, now, activeSince: now });
      }

      if (action === 'stop' || action === 'force-stop') {
        let accountId = session.accountId;
        if (action === 'force-stop') {
          if (!manage) return res.status(403).json({ error: 'Keine Berechtigung.' });
          accountId = (req.body || {}).accountId;
        }
        const run = active[accountId];
        if (!run) return res.status(400).json({ error: 'Keine laufende Schicht.' });
        const ms = now - run.startedAt;
        delete active[accountId];
        await setJSON(ACTIVE_KEY, active);
        let saved = null;
        if (ms >= MIN_SHIFT_MS) {
          const roster = (await getJSON(ROSTER_KEY)) || [];
          const acc = roster.find((r) => r.id === accountId);
          saved = {
            id: crypto.randomUUID(),
            accountId,
            name: acc ? acc.name : await resolveAccountName(session),
            start: run.startedAt,
            end: now,
            ms,
            type: 'shift',
            note: action === 'force-stop' ? `Von ${await resolveAccountName(session)} beendet` : null,
          };
          entries.push(saved);
          await setJSON(ENTRIES_KEY, entries);
        }
        return res.status(200).json({ ok: true, ms, saved: Boolean(saved) });
      }

      if (action === 'add') {
        if (!manage) return res.status(403).json({ error: 'Nur Höhere Ebene und Team Verwaltung dürfen Zeiten hinzufügen.' });
        const { accountId, minutes, note } = req.body || {};
        const roster = (await getJSON(ROSTER_KEY)) || [];
        const acc = roster.find((r) => r.id === accountId);
        if (!acc) return res.status(404).json({ error: 'Teammitglied nicht gefunden.' });
        const mins = parseMinutes(minutes);
        if (mins == null) return res.status(400).json({ error: 'Bitte eine Minutenzahl angeben (auch negativ zum Abziehen, nicht 0).' });
        const entry = {
          id: crypto.randomUUID(),
          accountId,
          name: acc.name,
          start: now,
          end: now,
          ms: mins * 60000,
          type: 'manual',
          note: (note || '').trim().slice(0, 200) || null,
          byName: await resolveAccountName(session),
        };
        entries.push(entry);
        await setJSON(ENTRIES_KEY, entries);
        return res.status(200).json({ ok: true, item: entry });
      }

      return res.status(400).json({ error: 'Unbekannte Aktion.' });
    }

    if (req.method === 'PUT') {
      if (!manage) return res.status(403).json({ error: 'Nur Höhere Ebene und Team Verwaltung dürfen Zeiten bearbeiten.' });
      const { id, minutes, note } = req.body || {};
      const idx = entries.findIndex((e) => e.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
      if (minutes !== undefined) {
        const mins = parseMinutes(minutes);
        if (mins == null) return res.status(400).json({ error: 'Bitte eine gültige Minutenzahl angeben.' });
        entries[idx].ms = mins * 60000;
      }
      if (note !== undefined) entries[idx].note = (note || '').trim().slice(0, 200) || null;
      entries[idx].editedByName = await resolveAccountName(session);
      await setJSON(ENTRIES_KEY, entries);
      return res.status(200).json({ ok: true, item: entries[idx] });
    }

    if (req.method === 'DELETE') {
      if (!manage) return res.status(403).json({ error: 'Nur Höhere Ebene und Team Verwaltung dürfen Zeiten löschen.' });
      const { id } = req.body || {};
      await setJSON(ENTRIES_KEY, entries.filter((e) => e.id !== id));
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};

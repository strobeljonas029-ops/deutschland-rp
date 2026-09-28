// Lockdown - EIGENE Datei statt Teil von [resource].js.
//
// Warum getrennt: [resource].js lädt sehr viele Module (Teamlog, Discord,
// Ränge, ...). Scheitert eines davon beim Laden, stürzt die GANZE Funktion
// ab (FUNCTION_INVOCATION_FAILED) - und mit ihr der Lockdown, obwohl der
// gerade im Ernstfall funktionieren muss. Diese Datei lädt bewusst nur vier
// Module, die schon vor dem Update existierten (_session, _account, _kv,
// _lockdown). Eine konkrete Datei hat in Vercel Vorrang vor dem dynamischen
// [resource].js - der alte lockdown-Zweig dort wird dadurch nicht mehr
// aufgerufen (er darf stehen bleiben, er stört nicht).
//
// Zwei Ziele, gleiche Rechte (LOCKDOWN_MANAGER_ROLE_IDS in _lockdown.js:
// Stv. Inhaber, Inhaber, Projektleitung, Master):
//   - ohne Parameter:  Lockdown der TEAM-Website (wie bisher)
//   - ?target=main  /  Body { target: 'main' }:  Fernsteuerung des Lockdowns
//     der HAUPTWEBSEITE. Beide Projekte teilen sich dieselbe Upstash-
//     Datenbank; die Hauptwebseite liest den Zustand aus dem Key
//     "drp_main:lockdown" (Feld-Namen müssen exakt so bleiben, siehe
//     lib/_lockdown.js dort).
const { getSessionFromRequest } = require('../../../lib/team/_session');
const { resolveAccountName } = require('../../../lib/team/_account');
const { getJSON, setJSON } = require('../../../lib/_kv');
const { getLockdownState, setLockdownState, isLockdownExempt } = require('../../../lib/team/_lockdown');

const MAIN_LOCKDOWN_KEY = 'drp_main:lockdown';
const MAX_MESSAGE = 500;

function cleanMessage(message) {
  return (typeof message === 'string' ? message : '').trim().slice(0, MAX_MESSAGE);
}

module.exports = async function handler(req, res) {
  try {
    const target = (req.query && req.query.target) || (req.body && req.body.target) || 'team';
    const isMain = target === 'main';

    if (req.method === 'GET') {
      if (!isMain) {
        // Team-Lockdown: bewusst öffentlich, damit die Meldung schon vor dem
        // Einloggen angezeigt werden kann (wie bisher).
        return res.status(200).json(await getLockdownState());
      }
      // Status der Hauptwebseite: nur für die Lockdown-Verwalter.
      const session = getSessionFromRequest(req);
      if (!session) return res.status(401).json({ error: 'Nicht angemeldet.' });
      if (!isLockdownExempt(session.roleId)) {
        return res.status(403).json({ error: 'Nur Stv. Inhaber, Inhaber und Projektleitung dürfen den Lockdown steuern.' });
      }
      return res.status(200).json((await getJSON(MAIN_LOCKDOWN_KEY)) || { active: false });
    }

    if (req.method === 'POST') {
      const session = getSessionFromRequest(req);
      if (!session) return res.status(401).json({ error: 'Nicht angemeldet.' });
      if (!isLockdownExempt(session.roleId)) {
        return res.status(403).json({ error: 'Nur Stv. Inhaber, Inhaber und Projektleitung dürfen den Lockdown setzen/aufheben.' });
      }
      const { active, message } = req.body || {};
      const byName = await resolveAccountName(session);

      if (isMain) {
        const state = active
          ? { active: true, message: cleanMessage(message), activatedByName: byName, activatedAt: Date.now() }
          : { active: false };
        await setJSON(MAIN_LOCKDOWN_KEY, state);
        return res.status(200).json(state);
      }

      const state = await setLockdownState(Boolean(active), { message: cleanMessage(message), byRole: byName });
      return res.status(200).json(state);
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};

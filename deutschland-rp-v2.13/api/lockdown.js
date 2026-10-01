// Lockdown-Status der Hauptwebseite. GET ist bewusst öffentlich (jeder
// Besucher - auch ausgeloggt - muss den aktuellen Status abfragen können,
// um die Sperr-Overlay zu zeigen). Setzen/Aufheben ist auf die Ränge in
// LOCKDOWN_MANAGER_ROLES beschränkt (siehe lib/_lockdown.js) - live anhand
// des aktuellen Team-Rangs geprüft, nicht zwischengespeichert (gleiches
// Muster wie requireAnnouncementCreator in api/announcements.js).
const { getAccountIdFromRequest, loadUsers, loadTeamRoster } = require('../lib/_account');
const { isLockdownManager, getLockdownState, setLockdownState } = require('../lib/_lockdown');

const MAX_MESSAGE = 500;

async function requireLockdownManager(req, res) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return null;
  }
  const users = await loadUsers();
  const account = users.find((u) => u.id === accountId);
  if (!account || !account.linkedTeamDiscordId) {
    res.status(403).json({ error: 'Nur Teammitglieder mit Lockdown-Recht können das.' });
    return null;
  }
  const roster = await loadTeamRoster();
  const entry = roster.find((r) => r.discordId === account.linkedTeamDiscordId);
  if (!entry || !isLockdownManager(entry.roleId)) {
    res.status(403).json({ error: 'Dein Team-Rang darf den Lockdown nicht steuern.' });
    return null;
  }
  return { account, entry };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const state = await getLockdownState();
      return res.status(200).json(state);
    }

    if (req.method === 'POST') {
      const ctx = await requireLockdownManager(req, res);
      if (!ctx) return;
      const { active, message } = req.body || {};
      if (active) {
        const cleanMessage = (typeof message === 'string' ? message : '').trim().slice(0, MAX_MESSAGE);
        await setLockdownState({
          active: true,
          message: cleanMessage,
          activatedByName: ctx.account.name,
          activatedAt: Date.now(),
        });
      } else {
        await setLockdownState({ active: false });
      }
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};

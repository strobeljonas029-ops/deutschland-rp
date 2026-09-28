// EINMALIGE Setup-Route: legt den Master-Account an.
// WICHTIG: Diese Datei nach dem ersten Aufruf sofort aus dem Projekt löschen!
const crypto = require('crypto');
const { getJSON, setJSON } = require('../lib/_kv');

const USERS_KEY = 'drp_main:users';
const TEAM_ROSTER_KEY = 'test_team:roster';
const SECRET = process.env.SETUP_SECRET;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

module.exports = async function handler(req, res) {
  // Nur GET erlaubt, mit geheimem Token als Schutz
  const { token, password } = req.query;

  if (!SECRET || token !== SECRET) {
    return res.status(403).json({ error: 'Nicht erlaubt.' });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Passwort fehlt oder zu kurz.' });
  }

  try {
    const discordId = 'master-internal';
    const username = 'master';
    const pwHash = hashPassword(password);

    // 1. Teamliste: Master-Eintrag anlegen/aktualisieren
    const roster = (await getJSON(TEAM_ROSTER_KEY)) || [];
    const ri = roster.findIndex(r => r.discordId === discordId);
    const rosterEntry = {
      discordId,
      username,
      name: 'Master',
      roleId: 'master',
      passwordHash: pwHash,
    };
    if (ri >= 0) roster[ri] = rosterEntry;
    else roster.unshift(rosterEntry);
    await setJSON(TEAM_ROSTER_KEY, roster);

    // 2. Hauptwebseiten-Konto anlegen/aktualisieren
    const users = (await getJSON(USERS_KEY)) || [];
    const ui = users.findIndex(u => u.linkedTeamDiscordId === discordId);
    const userEntry = {
      id: ui >= 0 ? users[ui].id : crypto.randomUUID(),
      name: 'Master',
      username,
      passwordHash: pwHash,
      avatarColor: null,
      birthDay: null,
      birthMonth: null,
      birthYear: null,
      linkedTeamDiscordId: discordId,
      createdAt: ui >= 0 ? users[ui].createdAt : Date.now(),
    };
    if (ui >= 0) users[ui] = userEntry;
    else users.unshift(userEntry);
    await setJSON(USERS_KEY, users);

    return res.status(200).json({
      ok: true,
      message: 'Master-Account erfolgreich angelegt! Lösche jetzt api/setup-master.js aus deinem Projekt.',
      username,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Fehler: ' + err.message });
  }
};

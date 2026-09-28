// Öffentliche Teamliste für die "Unser Team"-Seite. Liest die (mit der
// Team-Website geteilte) Roster-Datenbank direkt aus - kein fetch() zu einer
// fremden Domain nötig, siehe TEAM_ROSTER_KEY/loadTeamRoster in
// lib/_account.js. Gibt bewusst NUR Anzeigename + Rang + Profilfarbe zurück -
// keine Discord-ID, kein Username, kein Passwort. Die Profilfarbe
// (avatarColor) ist dasselbe Feld, das auch auf der Team-Website selbst
// gepflegt/angezeigt wird (siehe dort api/team/auth/[action].js), damit ein
// Teammitglied auf beiden Seiten mit der gleichen Avatar-Farbe auftaucht.
const { loadTeamRoster } = require('../lib/_account');
const { ROLE_NAMES, ROLE_TIERS, DISPLAY_ORDER, TIER_NAMES } = require('../lib/_teamRoles');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  }
  try {
    const roster = await loadTeamRoster();
    const items = roster
      .map((r) => {
        const roleName = ROLE_NAMES[r.roleId];
        const tier = ROLE_TIERS[r.roleId];
        if (!roleName || !tier) return null; // unbekannte/versteckte Rollen (z.B. Master-Zugang) tauchen hier nicht auf
        return { name: r.name, roleId: r.roleId, roleName, tier, tierName: TIER_NAMES[tier] || '', avatarColor: r.avatarColor || null };
      })
      .filter(Boolean)
      .sort((a, b) => (a.tier - b.tier) || (DISPLAY_ORDER.indexOf(a.roleId) - DISPLAY_ORDER.indexOf(b.roleId)));
    return res.status(200).json({ items });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};

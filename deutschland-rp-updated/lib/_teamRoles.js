// Minimale Kopie der Rang-Anzeigedaten aus der Team-Website
// (team-test-site/lib/team/_ranks.js) - NUR was für die öffentliche
// Teamliste auf der Hauptwebseite zur Anzeige gebraucht wird (Anzeigename +
// Ebene). Beide Projekte teilen sich zwar dieselbe Datenbank, aber NICHT
// denselben Code, deshalb kann diese Zuordnung hier nicht importiert werden
// und wird bewusst redundant gepflegt. Der versteckte "Master-Zugang"-Rang
// ist absichtlich NICHT enthalten - er soll auch auf der Hauptwebseite
// nirgends auftauchen.
const ROLE_NAMES = {
  // Niedrigere Ebene
  test_mod: 'Test Mod',
  junior_mod: 'Junior Mod',
  mod: 'Mod',
  senior_mod: 'Senior Mod',
  head_mod: 'Head Mod',
  // Mittlere Ebene
  team_verwaltung: 'Team Verwaltung',
  serversecurity: 'Serversecurity',
  bot_verwaltung: 'Bot Verwaltung',
  website_verwaltung: 'Website Verwaltung',
  social_verwaltung: 'Social Verwaltung',
  partnerschaft_verwaltung: 'Partnerschaft Verwaltung',
  // Höhere Ebene
  gruender: 'Gründer',
  stv_projektleitung: 'Stv. Projektleitung',
  web_stv_inhaber: 'Stv. Inhaber',
  web_inhaber: 'Inhaber',
  projektleitung: 'Projektleitung',
};

const ROLE_TIERS = {
  test_mod: 1, junior_mod: 1, mod: 1, senior_mod: 1, head_mod: 1,
  team_verwaltung: 2, serversecurity: 2, bot_verwaltung: 2, website_verwaltung: 2, social_verwaltung: 2, partnerschaft_verwaltung: 2,
  gruender: 3, stv_projektleitung: 3, web_stv_inhaber: 3, web_inhaber: 3, projektleitung: 3,
};

// Gleiche Reihenfolge wie DISPLAY_ORDER auf der Team-Website: "Projektleitung"
// steht bewusst am ENDE der Höheren Ebene statt am Anfang.
const DISPLAY_ORDER = [
  'web_inhaber', 'web_stv_inhaber', 'stv_projektleitung', 'gruender', 'projektleitung',
  'team_verwaltung', 'serversecurity', 'bot_verwaltung', 'website_verwaltung', 'social_verwaltung', 'partnerschaft_verwaltung',
  'head_mod', 'senior_mod', 'mod', 'junior_mod', 'test_mod',
];

const TIER_NAMES = { 1: 'Niedrigere Ebene', 2: 'Mittlere Ebene', 3: 'Höhere Ebene' };

// Ränge mit "announcementCreate"-Recht auf der Team-Website (FULL_TEAM_PERMS
// in team-test-site/lib/team/_ranks.js) - dieselben dürfen auch auf der
// Hauptwebseite Ankündigungen erstellen/bearbeiten/löschen. "master" (der
// versteckte Master-Zugang) ist bewusst mit dabei, obwohl er - wie überall
// sonst auf der Hauptwebseite - nirgends sichtbar/mit Namen auftaucht (siehe
// ROLE_NAMES oben, dort fehlt er absichtlich weiterhin): so kann er zwar
// Ankündigungen erstellen, bleibt dabei aber unsichtbar (Anzeigename zeigt
// mangels Eintrag in ROLE_NAMES weiterhin "@username" statt eines Rangs).
const ANNOUNCEMENT_CREATOR_ROLES = ['team_verwaltung', 'stv_projektleitung', 'web_stv_inhaber', 'web_inhaber', 'projektleitung', 'master'];

// Ränge, die auf der "Partner"-Seite neue Partnerserver hinzufügen dürfen:
// Partnerschaft Verwaltung + die komplette Höhere Ebene (tier 3) + der
// versteckte Master-Zugang (wie bei den Ankündigungen: er darf, bleibt aber
// auf der Seite ohne Rangnamen unsichtbar).
const PARTNER_MANAGER_ROLES = ['partnerschaft_verwaltung', 'gruender', 'stv_projektleitung', 'web_stv_inhaber', 'web_inhaber', 'projektleitung', 'master'];

// Server Security (tier 2) soll überall dort Zugriff haben, wo die Niedrigere
// Ebene (tier 1) Rechte hat. Neue Funktionen, die sich an der Niedrigeren
// Ebene orientieren, prüfen deshalb hasLowTierRights() statt nur tier === 1.
const LOW_TIER_EXTRA_ROLES = ['serversecurity'];
function hasLowTierRights(roleId) {
  return ROLE_TIERS[roleId] === 1 || LOW_TIER_EXTRA_ROLES.includes(roleId);
}

// User Liste (Konten einsehen + mit Grund löschen): Niedrigere Ebene, Höhere
// Ebene und Server Security. Der versteckte Master-Zugang ist wie bei den
// Ankündigungen mit dabei (ohne auf der Seite sichtbar zu werden).
function canManageUsers(roleId) {
  return hasLowTierRights(roleId) || ROLE_TIERS[roleId] === 3 || roleId === 'master';
}

module.exports = {
  ROLE_NAMES, ROLE_TIERS, DISPLAY_ORDER, TIER_NAMES,
  ANNOUNCEMENT_CREATOR_ROLES, PARTNER_MANAGER_ROLES,
  LOW_TIER_EXTRA_ROLES, hasLowTierRights, canManageUsers,
};

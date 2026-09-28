// Lockdown der HAUPTWEBSEITE (nicht zu verwechseln mit dem Lockdown der
// Team-Website - das ist ein eigenes, unabhängiges Feature mit eigenem
// KV-Key). Sperrt für alle außer den Rängen in LOCKDOWN_MANAGER_ROLES
// (dieselben Ränge, die auch die Team-Website sperren dürfen - siehe
// LOCKDOWN_MANAGER_ROLE_IDS dort) die komplette Hauptwebseite.
//
// WICHTIG für die Team-Website-Seite: Sie soll laut Absprache ein ZWEITES
// Lockdown-Panel bekommen, das DIESEN Lockdown fernsteuert. Dafür auf der
// Team-Website denselben Upstash-Key (LOCKDOWN_KEY unten) lesen/schreiben -
// beide Projekte teilen sich dieselbe Datenbank (siehe TEAM_ROSTER_KEY in
// lib/_account.js). Der Code dieser Datei kann NICHT 1:1 auf der
// Team-Website verwendet werden (andere lib/_kv.js-Instanz dort), aber
// Feld-Namen/Struktur des gespeicherten Objekts sind hier bewusst simpel
// gehalten, damit sie sich dort leicht nachbauen lassen.
const { getJSON, setJSON } = require('./_kv');

const LOCKDOWN_KEY = 'drp_main:lockdown';

// Dieselben Ränge wie LOCKDOWN_MANAGER_ROLE_IDS auf der Team-Website (siehe
// lib/team/_lockdown.js dort) - so kann, wer die Team-Website sperren darf,
// auch die Hauptwebseite sperren/entsperren, ohne dass es zwei getrennte
// Berechtigungskonzepte gibt.
const LOCKDOWN_MANAGER_ROLES = ['web_stv_inhaber', 'web_inhaber', 'projektleitung', 'master'];

function isLockdownManager(roleId) {
  return LOCKDOWN_MANAGER_ROLES.includes(roleId);
}

async function getLockdownState() {
  return (await getJSON(LOCKDOWN_KEY)) || { active: false };
}

async function setLockdownState(state) {
  await setJSON(LOCKDOWN_KEY, state);
}

module.exports = { LOCKDOWN_KEY, LOCKDOWN_MANAGER_ROLES, isLockdownManager, getLockdownState, setLockdownState };

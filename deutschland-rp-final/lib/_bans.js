// Verwaltung gesperrter Kennungen (IP-Adressen und Discord-IDs) - Teil der
// "Ban"-Funktion in der User Liste (Sicherheits-Update): ein normales
// "Löschen" entfernt nur das Konto, verhindert aber nicht, dass sich
// dieselbe Person sofort mit einem neuen Benutzernamen erneut anmeldet. Ban
// merkt sich zusätzlich, WOHER (IP) und ggf. WELCHES Discord-Konto
// gesperrt wurde, und blockiert damit neue Konten von dort.
//
// Liegt bewusst unter dem "drp_main:"-Präfix, das laut Absprache auch die
// Team-Website aus derselben Datenbank lesen kann (siehe Kommentar bei
// TEAM_ROSTER_KEY in lib/_account.js) - so kann ein dortiger Discord-Login
// später denselben Sperrstatus prüfen.
const { getJSON, setJSON } = require('./_kv');

const BANNED_IPS_KEY = 'drp_main:banned_ips';
const BANNED_DISCORD_KEY = 'drp_main:banned_discord_ids';
const MAX_BAN_ENTRIES = 2000; // älteste fallen raus, damit die Liste nicht endlos wächst

async function loadBannedIps() {
  return (await getJSON(BANNED_IPS_KEY)) || [];
}
async function loadBannedDiscordIds() {
  return (await getJSON(BANNED_DISCORD_KEY)) || [];
}

async function isIpBanned(ip) {
  if (!ip || ip === 'unknown') return false;
  const list = await loadBannedIps();
  return list.some((b) => b.ip === ip);
}
async function isDiscordBanned(discordId) {
  if (!discordId) return false;
  const list = await loadBannedDiscordIds();
  return list.some((b) => b.discordId === discordId);
}

// Fügt neue Kennungen zur Sperrliste hinzu (dedupliziert, bereits gesperrte
// Einträge werden nicht doppelt angelegt). ips/discordIds dürfen leer/
// undefined sein.
async function addBan({ ips, discordIds, reason, bannedByName }) {
  const now = Date.now();
  if (ips && ips.length) {
    const list = await loadBannedIps();
    for (const ip of ips) {
      if (!ip || ip === 'unknown' || list.some((b) => b.ip === ip)) continue;
      list.push({ ip, reason, bannedAt: now, bannedByName });
    }
    await setJSON(BANNED_IPS_KEY, list.slice(-MAX_BAN_ENTRIES));
  }
  if (discordIds && discordIds.length) {
    const list = await loadBannedDiscordIds();
    for (const id of discordIds) {
      if (!id || list.some((b) => b.discordId === id)) continue;
      list.push({ discordId: id, reason, bannedAt: now, bannedByName });
    }
    await setJSON(BANNED_DISCORD_KEY, list.slice(-MAX_BAN_ENTRIES));
  }
}

async function unbanIp(ip) {
  const list = await loadBannedIps();
  await setJSON(BANNED_IPS_KEY, list.filter((b) => b.ip !== ip));
}
async function unbanDiscordId(discordId) {
  const list = await loadBannedDiscordIds();
  await setJSON(BANNED_DISCORD_KEY, list.filter((b) => b.discordId !== discordId));
}

module.exports = { loadBannedIps, loadBannedDiscordIds, isIpBanned, isDiscordBanned, addBan, unbanIp, unbanDiscordId };

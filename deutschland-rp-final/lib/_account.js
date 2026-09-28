// Konto-System für die öffentliche Hauptwebseite (V2). Jeder Besucher kann
// sich selbst ein Konto anlegen (kein Discord-Login/keine Team-Zugehörigkeit
// nötig). Ohne Konto ist man automatisch "Gast" (kein Zwang zum
// Registrieren/Einloggen nur um die Seite zu benutzen) - ein Konto schaltet
// später Rechte wie Bewerten/Kommentieren frei.
//
// Teamler (Team-Website) brauchen KEIN separates Login mehr: der normale
// "login" unten prüft automatisch auch gegen die geteilte Teamliste, falls
// kein passendes normales Konto existiert (siehe findTeamAccount/
// findOrCreateLinkedAccount + "login" in api/auth/[action].js).
const crypto = require('crypto');
const { getJSON, setJSON } = require('./_kv');

const USERS_KEY = 'drp_main:users';
// Gelöschte Konten ("Grabsteine"): damit sich ein gelöschter Nutzer beim
// erneuten Anmelden nicht einfach nur "Passwort falsch" anschauen muss,
// sondern das Pop-up mit dem Löschgrund bekommt. Enthält bewusst den
// Passwort-Hash des gelöschten Kontos - nur so lässt sich beim Login prüfen,
// dass wirklich der frühere Besitzer davorsitzt (und nicht jemand, der nur
// den Benutzernamen kennt und so den Löschgrund auslesen könnte).
const DELETED_USERS_KEY = 'drp_main:deleted_users';
const MAX_DELETED_USERS = 1000; // älteste fallen raus, damit die Liste nicht endlos wächst
const COOKIE_NAME = 'drp_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage

// Muss exakt mit dem Roster-Key der Team-Website übereinstimmen (siehe
// ROSTER_KEY in api/team/setup.js / KEYS.roster in
// api/team/extra/[resource].js dort) - beide Projekte nutzen laut Absprache
// dieselbe Upstash-Datenbank, deshalb kann hier direkt gelesen werden, ohne
// die Team-Website per HTTP anzufragen.
const TEAM_ROSTER_KEY = 'test_team:roster';

function secret() {
  const s = process.env.DRP_SESSION_SECRET;
  if (!s) throw new Error('DRP_SESSION_SECRET fehlt');
  return s;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

// Wirft nie: ein kaputter/fehlender Hash im Speicher (oder ein Nicht-String als
// Passwort) führt zu "false" statt zu einem 500er.
function verifyPassword(password, salt, hash) {
  try {
    if (typeof password !== 'string' || !salt || !hash) return false;
    const check = crypto.scryptSync(password, salt, 64);
    const stored = Buffer.from(hash, 'hex');
    if (check.length !== stored.length) return false;
    return crypto.timingSafeEqual(check, stored);
  } catch {
    return false;
  }
}

async function loadUsers() {
  return (await getJSON(USERS_KEY)) || [];
}

async function saveUsers(users) {
  await setJSON(USERS_KEY, users);
}

async function loadDeletedUsers() {
  return (await getJSON(DELETED_USERS_KEY)) || [];
}

async function saveDeletedUsers(list) {
  await setJSON(DELETED_USERS_KEY, list.slice(-MAX_DELETED_USERS));
}

// Findet ein gelöschtes Konto anhand von Benutzername + Passwort (Login-
// Versuch mit den alten Zugangsdaten). Bei mehreren Treffern (gelöscht,
// neu registriert, wieder gelöscht) gewinnt der neueste.
async function findDeletedByCredentials(username, password) {
  const clean = (username || '').trim().toLowerCase();
  if (!clean || typeof password !== 'string') return null;
  const list = await loadDeletedUsers();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const d = list[i];
    if ((d.username || '').toLowerCase() !== clean) continue;
    if (d.passwordHash && verifyPassword(password, d.passwordHash.salt, d.passwordHash.hash)) return d;
  }
  return null;
}

async function findDeletedById(id) {
  const list = await loadDeletedUsers();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].id === id) return list[i];
  }
  return null;
}

function findByUsername(users, username) {
  const clean = (username || '').trim().toLowerCase();
  return users.find((u) => (u.username || '').toLowerCase() === clean) || null;
}

// Für den automatischen Teamler-Fallback beim normalen Login (siehe "login"
// in api/auth/[action].js): liest die Team-Roster-Liste direkt aus der
// (geteilten) Datenbank. Enthält u.a. passwordHash - wird NIE ans Frontend
// durchgereicht, nur hier serverseitig zum Prüfen verwendet.
async function loadTeamRoster() {
  return (await getJSON(TEAM_ROSTER_KEY)) || [];
}

// Für den Passwort-Sync (siehe "change-password" in api/auth/[action].js):
// schreibt die (geteilte) Teamliste zurück. Nur das passwordHash-Feld eines
// bestehenden Eintrags wird dabei angefasst, alles andere (Rang, Name usw.)
// bleibt unverändert.
async function saveTeamRoster(roster) {
  await setJSON(TEAM_ROSTER_KEY, roster);
}

// Nur noch Benutzername (kein Discord-ID-Feld mehr nötig) - der Benutzername
// ist in der Teamliste eindeutig (siehe Team-Website), das reicht zusammen
// mit dem Passwort zur Identifikation.
function findTeamAccount(roster, username) {
  const cleanUsername = (username || '').trim().toLowerCase();
  return roster.find((x) => (x.username || '').toLowerCase() === cleanUsername) || null;
}

// Findet ein bereits verknüpftes Hauptwebseiten-Konto für eine Team-Discord-
// ID, oder legt es beim ersten erfolgreichen Login mit Teamler-Zugangsdaten
// automatisch an (Name/Username vom Team-Konto übernommen, KEIN eigenes
// Passwort - das Konto bleibt bis zur freiwilligen Passwort-Vergabe nur über
// die Teamliste erreichbar).
async function findOrCreateLinkedAccount(teamAccount) {
  const users = await loadUsers();
  let account = users.find((u) => u.linkedTeamDiscordId === teamAccount.discordId);
  if (account) return account;

  let baseUsername = (teamAccount.username || 'teamler').trim();
  let candidate = baseUsername;
  let n = 1;
  while (findByUsername(users, candidate)) {
    n += 1;
    candidate = `${baseUsername}${n}`;
  }

  account = {
    id: crypto.randomUUID(),
    name: teamAccount.name || teamAccount.username || 'Teamler',
    username: candidate,
    passwordHash: null,
    avatarColor: null,
    birthDay: null,
    birthMonth: null,
    birthYear: null,
    linkedTeamDiscordId: teamAccount.discordId,
    createdAt: Date.now(),
  };
  users.push(account);
  await saveUsers(users);
  return account;
}

function sign(payloadStr) {
  return crypto.createHmac('sha256', secret()).update(payloadStr).digest('hex');
}

function encodePayload(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function decodePayload(str) {
  try {
    return JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

function makeToken(accountId) {
  const payload = { accountId, iat: Date.now() };
  const encoded = encodePayload(payload);
  const sig = sign(encoded);
  return `${encoded}.${sig}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [encoded, sig] = token.split('.');
  let expected;
  try {
    expected = sign(encoded);
  } catch {
    return null;
  }
  const a = Buffer.from(sig || '', 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const payload = decodePayload(encoded);
  if (!payload || !payload.iat || !payload.accountId) return null;
  if (Date.now() - payload.iat > SESSION_TTL_MS) return null;
  return payload;
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    // Ein kaputtes Cookie (z.B. "%E0%A4%A") darf nicht jede Anfrage mit einem
    // 500er abstürzen lassen - dann gilt der Wert einfach als nicht vorhanden.
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      /* ignorieren */
    }
  });
  return out;
}

function setSessionCookie(res, accountId) {
  const token = makeToken(accountId);
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
}

// Liest nur die Konto-ID aus dem Cookie (ohne die Teamliste zu laden) - für
// Endpunkte, die das ROHE Konto (inkl. passwordHash, für z.B. Passwort-
// Änderung) selbst nachladen müssen.
function getAccountIdFromRequest(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;
  const payload = verifyToken(token);
  return payload ? payload.accountId : null;
}

// Liefert das eingeloggte Konto (ohne passwordHash) oder null (= Gast).
async function getAccountFromRequest(req) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) return null;
  const users = await loadUsers();
  const account = users.find((u) => u.id === accountId);
  if (!account) return null;
  const { passwordHash, ...safe } = account;
  // Teamler-verknüpfte Konten haben zwar lokal KEINEN eigenen Hash (das
  // Passwort ist mit der Teamliste synchronisiert, siehe change-password),
  // haben aber trotzdem schon ein Passwort (das der Teamliste) - deshalb
  // zählt hier zusätzlich linkedTeamDiscordId.
  safe.hasPassword = !!(passwordHash && passwordHash.hash) || !!account.linkedTeamDiscordId;
  return safe;
}

// Wie getAccountFromRequest, unterscheidet aber zusätzlich "Gast" von "Konto
// wurde gelöscht": ist die Sitzung gültig, das Konto aber weg und als gelöscht
// vermerkt, kommt { deleted } (mit Grund) zurück. Der Aufrufer löscht dann das
// Sitzungs-Cookie, damit das Pop-up nicht bei jedem Seitenaufruf wieder kommt.
async function resolveSession(req) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) return {};
  const users = await loadUsers();
  const account = users.find((u) => u.id === accountId);
  if (account) {
    const { passwordHash, ...safe } = account;
    safe.hasPassword = !!(passwordHash && passwordHash.hash) || !!account.linkedTeamDiscordId;
    return { account: safe };
  }
  const deleted = await findDeletedById(accountId);
  return deleted ? { deleted } : {};
}

module.exports = {
  USERS_KEY,
  DELETED_USERS_KEY,
  TEAM_ROSTER_KEY,
  COOKIE_NAME,
  hashPassword,
  verifyPassword,
  loadUsers,
  saveUsers,
  loadDeletedUsers,
  saveDeletedUsers,
  findDeletedByCredentials,
  findDeletedById,
  findByUsername,
  loadTeamRoster,
  saveTeamRoster,
  findTeamAccount,
  findOrCreateLinkedAccount,
  setSessionCookie,
  clearSessionCookie,
  getAccountIdFromRequest,
  getAccountFromRequest,
  resolveSession,
};

// Konto-System der öffentlichen Hauptwebseite (Registrieren/Einloggen/
// Ausloggen/Status/Kontoeinstellungen). Der normale "login" prüft
// automatisch auch Teamler-Zugangsdaten (siehe dort) - dafür gibt es keine
// eigene Aktion/keinen eigenen Tab mehr. Läuft über EINE Datei mit
// dynamischem Pfadsegment statt vielen eigenen Dateien, um Serverless-
// Functions zu sparen (siehe review.js/visit.js - gleiches Prinzip).
const crypto = require('crypto');
const {
  hashPassword,
  verifyPassword,
  loadUsers,
  saveUsers,
  findByUsername,
  loadTeamRoster,
  saveTeamRoster,
  findTeamAccount,
  findOrCreateLinkedAccount,
  findDeletedByCredentials,
  setSessionCookie,
  clearSessionCookie,
  getAccountIdFromRequest,
  resolveSession,
} = require('../../lib/_account');
const { get: kvGet, incr: kvIncr, expire: kvExpire, del: kvDel } = require('../../lib/_kv');
const { ROLE_NAMES, ROLE_TIERS, ANNOUNCEMENT_CREATOR_ROLES, PARTNER_MANAGER_ROLES, canManageUsers } = require('../../lib/_teamRoles');
const { isLockdownManager } = require('../../lib/_lockdown');
const { checkText } = require('../../lib/_automod');
const { postAutomodLog } = require('../../lib/_discord');
const { isIpBanned, isDiscordBanned } = require('../../lib/_bans');

// Prüft Name/User Name auf Automod-Treffer (siehe lib/_automod.js). Bei
// "blocked" wird sofort mit einer Fehlermeldung geantwortet (return true)
// und geloggt - der Aufrufer muss dann selbst "return" ohne weitere Antwort
// auslösen. "uncertain" blockiert NICHT, wird aber ebenfalls geloggt. Beide
// Fälle feuern das Log erst NACHDEM feststeht, ob es sich um Name oder User
// Name handelt, damit der Log-Eintrag eindeutig ist.
async function checkAccountText(res, area, text, actor) {
  const result = checkText(text);
  if (result.verdict === 'clean') return false;
  await postAutomodLog({ area, verdict: result.verdict, matched: result.matched, text, actor });
  if (result.verdict === 'blocked') {
    res.status(400).json({ error: 'Bitte wähle einen anderen Namen - dieser enthält nicht erlaubte Inhalte.' });
    return true;
  }
  return false;
}

// Längenlimits (Passwörter werden mit scrypt gehasht - ohne Obergrenze könnte
// jemand mit riesigen "Passwörtern" den Server ausbremsen).
const MAX_NAME = 40;
const MAX_USERNAME = 32;
const MAX_PASSWORD = 128;

// Login-Sperre gegen Passwort-Raten: nach LOGIN_MAX_FAILS Fehlversuchen für
// dieselbe Kombination aus IP + Benutzername ist für LOGIN_WINDOW_S Sekunden
// Pause (der Zähler läuft danach von selbst ab). Nach einem erfolgreichen
// Login wird der Zähler zurückgesetzt.
const LOGIN_MAX_FAILS = 10;
const LOGIN_WINDOW_S = 15 * 60;

// Nur Strings durchlassen - alles andere (Zahl, Objekt, Array aus einem
// manipulierten Request) wird zu '' statt später bei .trim() zu crashen.
function str(v) {
  return typeof v === 'string' ? v : '';
}

function clientIp(req) {
  const xf = req.headers && req.headers['x-forwarded-for'];
  const first = typeof xf === 'string' ? xf.split(',')[0].trim() : '';
  return first || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function loginFailKey(req, username) {
  return `drp_main:loginfail:${clientIp(req)}:${username.trim().toLowerCase().slice(0, 64)}`;
}

function publicAccount(account) {
  if (!account) return null;
  const { passwordHash, ...safe } = account;
  // hasPassword sagt dem Frontend, ob beim Passwort-Ändern ein "Altes
  // Passwort" verlangt werden muss. Teamler-verknüpfte Konten haben zwar
  // lokal keinen eigenen Hash (Passwort ist mit der Teamliste
  // synchronisiert, siehe change-password unten), haben aber trotzdem schon
  // ein Passwort (das der Teamliste) - deshalb zählt hier zusätzlich
  // linkedTeamDiscordId.
  safe.hasPassword = !!(passwordHash && passwordHash.hash) || !!account.linkedTeamDiscordId;
  return safe;
}

// Ergänzt bei Teamler-verknüpften Konten den aktuellen Team-Rang (live aus
// der geteilten Teamliste gelesen, nicht zwischengespeichert - ein Uprank/
// Downrank auf der Team-Website wirkt sich also sofort aus). Wird für die
// Anzeige ("Inhaber" statt "@username", siehe Frontend) und dafür gebraucht,
// ob das Konto Ankündigungen erstellen darf.
async function withTeamInfo(account) {
  if (!account || !account.linkedTeamDiscordId) return account;
  // Master-Account steht bewusst nicht im Roster, wird aber direkt erkannt
  // und bekommt alle Berechtigungen (inkl. canManagePartners).
  if (account.linkedTeamDiscordId === 'master-internal') {
    account.teamRoleName = null;
    account.canManageAnnouncements = true;
    account.canModerateReviews = true;
    account.canDeleteReviews = true;
    account.canManagePartners = true;
    account.canManageUsers = true;
    account.canManageLockdown = true;
    account.isMaster = true;
    return account;
  }
  try {
    const roster = await loadTeamRoster();
    const entry = roster.find((r) => r.discordId === account.linkedTeamDiscordId);
    account.teamRoleName = entry ? (ROLE_NAMES[entry.roleId] || null) : null;
    account.canManageAnnouncements = !!(entry && ANNOUNCEMENT_CREATOR_ROLES.includes(entry.roleId));
    // Bewertungs-Moderation: JEDE Team-Ebene (1-3) darf einen Kommentar
    // zensieren (nur der Text verschwindet, die Sterne bleiben), nur die
    // Höhere Ebene (tier 3) darf die komplette Bewertung entfernen.
    const reviewTier = entry ? (ROLE_TIERS[entry.roleId] || 0) : 0;
    account.canModerateReviews = reviewTier >= 1;
    account.canDeleteReviews = reviewTier === 3;
    account.canManagePartners = !!(entry && PARTNER_MANAGER_ROLES.includes(entry.roleId));
    // User Liste: Niedrigere Ebene, Höhere Ebene und Server Security.
    account.canManageUsers = !!(entry && canManageUsers(entry.roleId));
    account.canManageLockdown = !!(entry && isLockdownManager(entry.roleId));
    account.isMaster = false;
  } catch (e) {
    account.teamRoleName = null;
    account.canManageAnnouncements = false;
    account.canModerateReviews = false;
    account.canDeleteReviews = false;
    account.canManagePartners = false;
    account.canManageUsers = false;
    account.canManageLockdown = false;
    account.isMaster = false;
  }
  return account;
}

// Lädt das ROHE (eingeloggte) Konto inkl. passwordHash + seinen Index in der
// Liste - für Endpunkte, die das Konto selbst ändern müssen. Schreibt bei
// fehlender/ungültiger Sitzung direkt die 401-Antwort und gibt null zurück.
async function requireRawAccount(req, res) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return null;
  }
  const users = await loadUsers();
  const idx = users.findIndex((u) => u.id === accountId);
  if (idx === -1) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return null;
  }
  return { users, idx };
}

module.exports = async function handler(req, res) {
  try {
    const { action } = req.query || {};

    // ---------- Status: eingeloggtes Konto ODER Gast ----------
    if (action === 'status') {
      if (req.method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return res.status(405).json({ error: 'Methode nicht erlaubt.' });
      }
      const session = await resolveSession(req);
      if (session.deleted) {
        // Eingeloggt gewesen, Konto inzwischen gelöscht: Cookie entfernen und
        // dem Frontend den Grund für das Pop-up mitgeben (kommt so nur EINMAL).
        clearSessionCookie(res);
        return res.status(200).json({ loggedIn: false, deleted: true, reason: session.deleted.reason });
      }
      if (!session.account) return res.status(200).json({ loggedIn: false });
      return res.status(200).json({ loggedIn: true, account: await withTeamInfo(session.account) });
    }

    // ---------- Registrieren ----------
    if (action === 'register') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Methode nicht erlaubt.' });
      }
      const body = req.body || {};
      const cleanName = str(body.name).trim();
      const cleanUsername = str(body.username).trim();
      const password = str(body.password);
      const passwordConfirm = str(body.passwordConfirm);
      if (!cleanName || !cleanUsername || !password || !passwordConfirm) {
        return res.status(400).json({ error: 'Bitte Name, User Name, Passwort und Passwort-Bestätigung ausfüllen.' });
      }
      if (cleanUsername.length < 3) {
        return res.status(400).json({ error: 'User Name muss mindestens 3 Zeichen haben.' });
      }
      if (cleanName.length > MAX_NAME || cleanUsername.length > MAX_USERNAME) {
        return res.status(400).json({ error: `Name darf höchstens ${MAX_NAME} und User Name höchstens ${MAX_USERNAME} Zeichen haben.` });
      }
      if (password.length < 4) {
        return res.status(400).json({ error: 'Passwort muss mindestens 4 Zeichen haben.' });
      }
      if (password.length > MAX_PASSWORD) {
        return res.status(400).json({ error: `Passwort darf höchstens ${MAX_PASSWORD} Zeichen haben.` });
      }
      if (password !== passwordConfirm) {
        return res.status(400).json({ error: 'Die Passwörter stimmen nicht überein.' });
      }

      const users = await loadUsers();
      if (findByUsername(users, cleanUsername)) {
        return res.status(400).json({ error: 'Dieser User Name ist bereits vergeben.' });
      }

      // Ban-Sperre: verhindert, dass sich jemand nach einem Ban einfach mit
      // einem neuen Benutzernamen von derselben IP-Adresse neu registriert
      // (siehe lib/_bans.js). Bewusst vor dem Automod-Check, damit kein
      // gebannter Besucher unnötig Automod-Anfragen auslösen kann.
      const registerIp = clientIp(req);
      if (await isIpBanned(registerIp)) {
        return res.status(403).json({ error: 'Von dieser Verbindung aus wurde ein Konto gesperrt - eine neue Registrierung ist nicht möglich.' });
      }
      // Der normale Login prüft bei fehlendem Konto-Treffer automatisch auch
      // gegen die geteilte Teamliste (Teamler-Fallback, siehe "login" unten) -
      // ein Username-Namensraum, der sich mit einer Teamliste ein Login teilt,
      // muss deshalb auch bei der Vergabe eindeutig über BEIDE Listen sein.
      // Sonst könnte sich jemand vorab den Username eines Teamlers sichern:
      // der Teamler bekäme beim Login zwar weiterhin sein eigenes (verknüpftes)
      // Konto, könnte diesen Namen auf der Hauptwebseite aber nie mehr selbst
      // führen, und zwei Konten mit demselben Anzeigenamen wären verwirrend.
      const teamRosterForUsername = await loadTeamRoster();
      if (findTeamAccount(teamRosterForUsername, cleanUsername)) {
        return res.status(400).json({ error: 'Dieser User Name ist bereits vergeben.' });
      }

      // Automod: Name UND User Name auf nicht jugendfreie/beleidigende
      // Inhalte prüfen, bevor das Konto angelegt wird (siehe lib/_automod.js).
      if (await checkAccountText(res, 'Konto erstellen - Name', cleanName, cleanUsername)) return;
      if (await checkAccountText(res, 'Konto erstellen - User Name', cleanUsername, cleanUsername)) return;

      const account = {
        id: crypto.randomUUID(),
        name: cleanName,
        username: cleanUsername,
        passwordHash: hashPassword(password),
        avatarColor: null,
        birthDay: null,
        birthMonth: null,
        birthYear: null,
        linkedTeamDiscordId: null,
        lastIp: registerIp,
        createdAt: Date.now(),
      };
      users.push(account);
      await saveUsers(users);

      setSessionCookie(res, account.id);
      return res.status(200).json({ ok: true, account: await withTeamInfo(publicAccount(account)) });
    }

    // ---------- Einloggen ----------
    // Prüft zuerst gegen normale Hauptwebseiten-Konten; findet sich dort
    // kein passendes (Passwort-)Match, wird automatisch gegen die geteilte
    // Teamliste der Team-Website geprüft ("Teamler-Konto" braucht dadurch
    // keinen eigenen Login-Tab mehr - nur noch User Name + Passwort, genauso
    // wie beim normalen Konto). Bei erstem erfolgreichen Teamler-Login wird
    // automatisch ein verknüpftes Hauptwebseiten-Konto angelegt/wiederverwendet
    // (siehe findOrCreateLinkedAccount in lib/_account.js).
    if (action === 'login') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Methode nicht erlaubt.' });
      }
      const body = req.body || {};
      const username = str(body.username);
      const password = str(body.password);
      if (!username || !password) {
        return res.status(400).json({ error: 'Bitte User Name und Passwort eingeben.' });
      }
      if (password.length > MAX_PASSWORD) {
        return res.status(400).json({ error: 'User Name oder Passwort falsch.' });
      }

      const failKey = loginFailKey(req, username);
      const fails = Number(await kvGet(failKey)) || 0;
      if (fails >= LOGIN_MAX_FAILS) {
        return res.status(429).json({ error: 'Zu viele Fehlversuche. Bitte warte ein paar Minuten und versuche es dann erneut.' });
      }

      const users = await loadUsers();
      const account = findByUsername(users, username);
      if (account && account.passwordHash && verifyPassword(password, account.passwordHash.salt, account.passwordHash.hash)) {
        await kvDel(failKey);
        const ip = clientIp(req);
        if (account.lastIp !== ip) {
          account.lastIp = ip;
          await saveUsers(users);
        }
        setSessionCookie(res, account.id);
        return res.status(200).json({ ok: true, account: await withTeamInfo(publicAccount(account)) });
      }

      const roster = await loadTeamRoster();
      const teamAccount = findTeamAccount(roster, username);
      if (teamAccount && teamAccount.passwordHash && verifyPassword(password, teamAccount.passwordHash.salt, teamAccount.passwordHash.hash)) {
        // Ban-Sperre gilt auch hier: ein gebannter Discord-Account (falls
        // dessen ID mal gebannt wurde) bekommt kein neues/verknüpftes Konto.
        if (await isDiscordBanned(teamAccount.discordId)) {
          return res.status(403).json({ error: 'Dieses Discord-Konto ist gesperrt.' });
        }
        const linkedAccount = await findOrCreateLinkedAccount(teamAccount);
        const ip = clientIp(req);
        if (linkedAccount.lastIp !== ip) {
          const freshUsers = await loadUsers();
          const idx = freshUsers.findIndex((u) => u.id === linkedAccount.id);
          if (idx !== -1) { freshUsers[idx].lastIp = ip; await saveUsers(freshUsers); }
        }
        await kvDel(failKey);
        setSessionCookie(res, linkedAccount.id);
        return res.status(200).json({ ok: true, account: await withTeamInfo(publicAccount(linkedAccount)) });
      }

      // Kein aktives Konto passt - vielleicht ein GELÖSCHTES? Dann bekommt der
      // frühere Besitzer (Benutzername + Passwort stimmen) statt "falsch" den
      // Löschgrund fürs Pop-up. Zählt nicht als Fehlversuch (die Zugangsdaten
      // waren ja korrekt), es wird aber auch keine Sitzung erstellt.
      const deleted = await findDeletedByCredentials(username, password);
      if (deleted) {
        return res.status(403).json({
          error: 'Dein Konto wurde gelöscht.',
          deleted: true,
          reason: deleted.reason,
        });
      }

      const failCount = await kvIncr(failKey);
      if (failCount === 1) await kvExpire(failKey, LOGIN_WINDOW_S);
      return res.status(400).json({ error: 'User Name oder Passwort falsch.' });
    }

    // ---------- Ausloggen ----------
    if (action === 'logout') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Methode nicht erlaubt.' });
      }
      clearSessionCookie(res);
      return res.status(200).json({ ok: true });
    }

    // ---------- Kontoeinstellungen (nur eingeloggt) ----------
    if (action === 'update-name') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Methode nicht erlaubt.' });
      }
      const ctx = await requireRawAccount(req, res);
      if (!ctx) return;
      const cleanName = str((req.body || {}).name).trim();
      if (!cleanName) return res.status(400).json({ error: 'Name darf nicht leer sein.' });
      if (cleanName.length > MAX_NAME) return res.status(400).json({ error: `Name darf höchstens ${MAX_NAME} Zeichen haben.` });
      if (await checkAccountText(res, 'Konto - Name geändert', cleanName, ctx.users[ctx.idx].username)) return;
      ctx.users[ctx.idx].name = cleanName;
      await saveUsers(ctx.users);
      return res.status(200).json({ ok: true, account: await withTeamInfo(publicAccount(ctx.users[ctx.idx])) });
    }

    if (action === 'update-username') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Methode nicht erlaubt.' });
      }
      const ctx = await requireRawAccount(req, res);
      if (!ctx) return;
      const cleanUsername = str((req.body || {}).username).trim();
      if (cleanUsername.length < 3) {
        return res.status(400).json({ error: 'User Name muss mindestens 3 Zeichen haben.' });
      }
      if (cleanUsername.length > MAX_USERNAME) {
        return res.status(400).json({ error: `User Name darf höchstens ${MAX_USERNAME} Zeichen haben.` });
      }
      if (ctx.users.some((u, i) => i !== ctx.idx && (u.username || '').toLowerCase() === cleanUsername.toLowerCase())) {
        return res.status(400).json({ error: 'Dieser User Name ist bereits vergeben.' });
      }
      // Gleicher Grund wie bei "register" oben: auch beim Umbenennen darf kein
      // in der Teamliste vergebener Username übernommen werden. Ausnahme: das
      // EIGENE verknüpfte Teamler-Konto darf weiterhin seinen eigenen
      // Teamlisten-Namen behalten/erneut setzen.
      const ownTeamDiscordId = ctx.users[ctx.idx].linkedTeamDiscordId;
      const teamRosterForRename = await loadTeamRoster();
      const teamClash = findTeamAccount(teamRosterForRename, cleanUsername);
      if (teamClash && teamClash.discordId !== ownTeamDiscordId) {
        return res.status(400).json({ error: 'Dieser User Name ist bereits vergeben.' });
      }
      if (await checkAccountText(res, 'Konto - User Name geändert', cleanUsername, ctx.users[ctx.idx].username)) return;
      ctx.users[ctx.idx].username = cleanUsername;
      await saveUsers(ctx.users);
      return res.status(200).json({ ok: true, account: await withTeamInfo(publicAccount(ctx.users[ctx.idx])) });
    }

    // Geburtstag ist bewusst NICHT Teil von publicAccount()s Einschränkung -
    // er wird zwar im eigenen Status/Konto mitgeliefert (damit man ihn in den
    // Einstellungen sieht/ändern kann), aber es gibt aktuell nirgends eine
    // Ansicht, die fremde Konten/Geburtstage aufzählt oder anzeigt.
    if (action === 'update-birthday') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Methode nicht erlaubt.' });
      }
      const ctx = await requireRawAccount(req, res);
      if (!ctx) return;
      const { day, month, year } = req.body || {};
      const d = Number(day);
      const m = Number(month);
      const y = Number(year);
      const thisYear = new Date().getFullYear();
      if (!Number.isInteger(d) || d < 1 || d > 31 || !Number.isInteger(m) || m < 1 || m > 12) {
        return res.status(400).json({ error: 'Bitte Tag und Monat auswählen.' });
      }
      if (!Number.isInteger(y) || y < 1900 || y > thisYear) {
        return res.status(400).json({ error: 'Bitte ein gültiges Geburtsjahr auswählen.' });
      }
      // Grobe Gültigkeitsprüfung (z.B. 31. Februar) ohne Zeitzonen-Fallstricke.
      const daysInMonth = new Date(y, m, 0).getDate();
      if (d > daysInMonth) {
        return res.status(400).json({ error: 'Dieses Datum gibt es nicht.' });
      }
      ctx.users[ctx.idx].birthDay = d;
      ctx.users[ctx.idx].birthMonth = m;
      ctx.users[ctx.idx].birthYear = y;
      await saveUsers(ctx.users);
      return res.status(200).json({ ok: true, account: await withTeamInfo(publicAccount(ctx.users[ctx.idx])) });
    }

    if (action === 'update-avatar-color') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Methode nicht erlaubt.' });
      }
      const ctx = await requireRawAccount(req, res);
      if (!ctx) return;
      const { color } = req.body || {};
      if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
        return res.status(400).json({ error: 'Ungültige Farbe (Format: #RRGGBB).' });
      }
      ctx.users[ctx.idx].avatarColor = color || null;
      await saveUsers(ctx.users);
      return res.status(200).json({ ok: true, account: await withTeamInfo(publicAccount(ctx.users[ctx.idx])) });
    }

    if (action === 'change-password') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: 'Methode nicht erlaubt.' });
      }
      const ctx = await requireRawAccount(req, res);
      if (!ctx) return;
      const body = req.body || {};
      const oldPassword = str(body.oldPassword);
      const newPassword = str(body.newPassword);
      const newPasswordConfirm = str(body.newPasswordConfirm);
      const account = ctx.users[ctx.idx];
      if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ error: 'Neues Passwort muss mindestens 4 Zeichen haben.' });
      }
      if (newPassword.length > MAX_PASSWORD) {
        return res.status(400).json({ error: `Neues Passwort darf höchstens ${MAX_PASSWORD} Zeichen haben.` });
      }
      if (newPassword !== newPasswordConfirm) {
        return res.status(400).json({ error: 'Die neuen Passwörter stimmen nicht überein.' });
      }

      // Teamler-verknüpfte Konten haben KEIN eigenes lokales Passwort - ihr
      // Passwort ist mit der Team-Website synchronisiert (egal wo man es
      // ändert, gilt es auf beiden Seiten). Deshalb wird hier direkt der
      // Eintrag in der geteilten Teamliste geändert statt lokal, und der
      // lokale Hash bleibt bewusst null (siehe login-Fallback oben, der bei
      // fehlendem lokalem Hash automatisch gegen die Teamliste prüft).
      if (account.linkedTeamDiscordId) {
        const roster = await loadTeamRoster();
        const idx = roster.findIndex((r) => r.discordId === account.linkedTeamDiscordId);
        if (idx === -1) {
          return res.status(400).json({ error: 'Dein Teamlisten-Eintrag wurde nicht gefunden.' });
        }
        const teamEntry = roster[idx];
        if (teamEntry.passwordHash) {
          if (!oldPassword || !verifyPassword(oldPassword, teamEntry.passwordHash.salt, teamEntry.passwordHash.hash)) {
            return res.status(400).json({ error: 'Altes Passwort ist falsch.' });
          }
        }
        roster[idx].passwordHash = hashPassword(newPassword);
        await saveTeamRoster(roster);
        return res.status(200).json({ ok: true });
      }

      if (account.passwordHash) {
        if (!oldPassword || !verifyPassword(oldPassword, account.passwordHash.salt, account.passwordHash.hash)) {
          return res.status(400).json({ error: 'Altes Passwort ist falsch.' });
        }
      }
      account.passwordHash = hashPassword(newPassword);
      await saveUsers(ctx.users);
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Unbekannte Aktion.' });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};

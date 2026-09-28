// "User Liste" der Hauptwebseite: zeigt alle Konten (neueste zuerst) und
// erlaubt das Löschen - aber NUR mit Angabe eines Löschgrundes.
//
// Zugriff: Niedrigere Ebene, Höhere Ebene und Server Security (siehe
// canManageUsers in lib/_teamRoles.js) - live anhand des aktuellen Team-Rangs
// geprüft, nicht zwischengespeichert (gleiches Muster wie in den anderen APIs).
//
// Was ein gelöschter Nutzer davon merkt: Beim nächsten Anmelden (oder wenn er
// noch eingeloggt war, beim nächsten Seitenaufruf) bekommt er das Pop-up
// "Dein Konto wurde aufgrund von [Grund] gelöscht." - siehe "login"/"status"
// in api/auth/[action].js und DELETED_USERS_KEY in lib/_account.js.
const {
  getAccountIdFromRequest,
  loadUsers,
  saveUsers,
  loadDeletedUsers,
  saveDeletedUsers,
  loadTeamRoster,
} = require('../lib/_account');
const { canManageUsers } = require('../lib/_teamRoles');
const { loadBannedIps, loadBannedDiscordIds, addBan, unbanIp, unbanDiscordId } = require('../lib/_bans');

const MAX_LIST = 1000;
const MIN_REASON = 3;
const MAX_REASON = 300;

async function requireUserManager(req, res) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return null;
  }
  const users = await loadUsers();
  const account = users.find((u) => u.id === accountId);
  if (!account || !account.linkedTeamDiscordId) {
    res.status(403).json({ error: 'Nur Teammitglieder mit Zugriff auf die User Liste können das.' });
    return null;
  }
  const roster = await loadTeamRoster();
  const entry = roster.find((r) => r.discordId === account.linkedTeamDiscordId);
  if (!entry || !canManageUsers(entry.roleId)) {
    res.status(403).json({ error: 'Dein Team-Rang hat keinen Zugriff auf die User Liste.' });
    return null;
  }
  return { account, entry, users };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const ctx = await requireUserManager(req, res);
      if (!ctx) return;
      // Bewusst nur das Nötigste: kein Passwort-Hash, kein Geburtstag, keine
      // Discord-ID (Datensparsamkeit - die Liste sehen viele Teammitglieder).
      const list = ctx.users
        .map((u) => ({
          id: u.id,
          name: u.name,
          username: u.username,
          createdAt: u.createdAt || 0,
          isTeam: !!u.linkedTeamDiscordId,
          isSelf: u.id === ctx.account.id,
        }))
        .sort((a, b) => b.createdAt - a.createdAt);
      // Gesperrte Kennungen: NUR für Personen mit Zugriff auf die User Liste
      // sichtbar (Sicherheits-Update "Ban") - erlaubt das spätere Entsperren.
      const [bannedIps, bannedDiscordIds] = await Promise.all([loadBannedIps(), loadBannedDiscordIds()]);
      return res.status(200).json({
        users: list.slice(0, MAX_LIST),
        total: list.length,
        bannedIps,
        bannedDiscordIds,
      });
    }

    if (req.method === 'DELETE') {
      const ctx = await requireUserManager(req, res);
      if (!ctx) return;
      const body = req.body || {};
      const id = typeof body.id === 'string' ? body.id : '';
      const reason = (typeof body.reason === 'string' ? body.reason : '').trim();

      if (reason.length < MIN_REASON) {
        return res.status(400).json({ error: `Bitte einen Löschgrund angeben (mindestens ${MIN_REASON} Zeichen).` });
      }
      if (reason.length > MAX_REASON) {
        return res.status(400).json({ error: `Der Löschgrund darf höchstens ${MAX_REASON} Zeichen haben.` });
      }

      const idx = ctx.users.findIndex((u) => u.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Konto nicht gefunden.' });
      const target = ctx.users[idx];
      if (target.id === ctx.account.id) {
        return res.status(400).json({ error: 'Du kannst dein eigenes Konto hier nicht löschen.' });
      }
      if (target.linkedTeamDiscordId) {
        // Team-Konten hängen an der Teamliste der Team-Website (Login läuft
        // darüber) - ein Löschen hier würde nur ein leeres Konto entfernen,
        // das sich beim nächsten Login sofort neu anlegt.
        return res.status(403).json({ error: 'Team-Konten können hier nicht gelöscht werden (Verwaltung über die Team-Website).' });
      }

      // Erst den "Grabstein" speichern, dann das Konto entfernen: geht beim
      // zweiten Schritt etwas schief, bleibt das Konto einfach bestehen.
      const deleted = await loadDeletedUsers();
      deleted.push({
        id: target.id,
        name: target.name,
        username: target.username,
        passwordHash: target.passwordHash || null,
        reason,
        deletedAt: Date.now(),
        deletedByName: ctx.account.name,
      });
      await saveDeletedUsers(deleted);

      ctx.users.splice(idx, 1);
      await saveUsers(ctx.users);
      return res.status(200).json({ ok: true });
    }

    // ---------- Ban (Sicherheits-Update) ----------
    // Wie Löschen, aber zusätzlich: die bekannte IP-Adresse (und, falls
    // vorhanden, verknüpfte Discord-ID) des Kontos landen auf der Sperrliste
    // (siehe lib/_bans.js) - damit kann sich dieselbe Person NICHT einfach
    // mit einem neuen Benutzernamen neu registrieren.
    if (req.method === 'POST') {
      const ctx = await requireUserManager(req, res);
      if (!ctx) return;
      const body = req.body || {};
      const id = typeof body.id === 'string' ? body.id : '';
      const reason = (typeof body.reason === 'string' ? body.reason : '').trim();

      if (reason.length < MIN_REASON) {
        return res.status(400).json({ error: `Bitte einen Sperrgrund angeben (mindestens ${MIN_REASON} Zeichen).` });
      }
      if (reason.length > MAX_REASON) {
        return res.status(400).json({ error: `Der Sperrgrund darf höchstens ${MAX_REASON} Zeichen haben.` });
      }

      const idx = ctx.users.findIndex((u) => u.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Konto nicht gefunden.' });
      const target = ctx.users[idx];
      if (target.id === ctx.account.id) {
        return res.status(400).json({ error: 'Du kannst dein eigenes Konto hier nicht sperren.' });
      }
      if (target.linkedTeamDiscordId) {
        return res.status(403).json({ error: 'Team-Konten können hier nicht gesperrt werden (Verwaltung über die Team-Website).' });
      }

      await addBan({
        ips: target.lastIp ? [target.lastIp] : [],
        discordIds: target.linkedTeamDiscordId ? [target.linkedTeamDiscordId] : [],
        reason,
        bannedByName: ctx.account.name,
      });

      const deleted = await loadDeletedUsers();
      deleted.push({
        id: target.id,
        name: target.name,
        username: target.username,
        passwordHash: target.passwordHash || null,
        reason: `[Gebannt] ${reason}`,
        deletedAt: Date.now(),
        deletedByName: ctx.account.name,
      });
      await saveDeletedUsers(deleted);

      ctx.users.splice(idx, 1);
      await saveUsers(ctx.users);
      return res.status(200).json({ ok: true, ipBanned: !!target.lastIp });
    }

    // ---------- Entsperren ----------
    if (req.method === 'PATCH') {
      const ctx = await requireUserManager(req, res);
      if (!ctx) return;
      const body = req.body || {};
      const type = body.type === 'ip' || body.type === 'discordId' ? body.type : '';
      const value = typeof body.value === 'string' ? body.value : '';
      if (!type || !value) {
        return res.status(400).json({ error: 'Ungültige Anfrage.' });
      }
      if (type === 'ip') await unbanIp(value);
      else await unbanDiscordId(value);
      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};

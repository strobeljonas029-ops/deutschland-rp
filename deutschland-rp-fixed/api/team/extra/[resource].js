const crypto = require('crypto');
const { getSessionFromRequest, requireAdmin, requirePerm, requireHigherOrTeamVerwaltung } = require('../../../lib/team/_session');
const { hashPassword, getRoleDef, rankIndex } = require('../../../lib/team/_ranks');

const { resolveAccountName } = require('../../../lib/team/_account');
const { getJSON, setJSON } = require('../../../lib/_kv');
const { postPollToDiscord, editPollDiscordMessage, deletePollDiscordMessage, syncTeamListEmbed, cleanPings } = require('../../../lib/team/_discord');
const { postTeamLog, fmtDateTime } = require('../../../lib/team/_teamlog');
const { getLockdownState, setLockdownState, isLockdownExempt, blockIfLockedOut } = require('../../../lib/team/_lockdown');

// Sucht die Discord-ID des Kontos hinter einer accountId in einer bereits
// geladenen Teamliste (spart einen zusätzlichen KV-Read).
function findDiscordId(list, accountId) {
  if (!accountId) return null;
  const entry = list.find((x) => x.id === accountId);
  return entry ? entry.discordId : null;
}

// Teamliste/Abwesenheiten/Kummerkasten/Verwarnungen/Umfragen/Lockdown laufen
// bewusst über EINE Datei mit dynamischem Pfadsegment statt eigener Dateien –
// Vercel Hobby-Plan erlaubt maximal 12 Serverless Functions pro Deployment.
// (Kalender und Schichten liegen als eigene Dateien daneben: calendar.js und
// shifts.js - zusammen weiterhin unter dem Limit.)
//
// Beim Kummerkasten wird bewusst GAR KEIN Name/Rolle gespeichert, damit
// Einträge wirklich anonym bleiben – auch für Admins.

const KEYS = {
  roster: 'test_team:roster',
  absences: 'test_team:absences',
  kummerkasten: 'test_team:kummerkasten',
  warnings: 'test_team:staff_warnings',
  polls: 'test_team:polls',
};
// Suspendierungen (ehemals "Kick"): solange eine Suspendierung aktiv ist,
// kann mit der betroffenen Discord-ID kein neues Team-Konto angelegt werden.
const SUSPENSIONS_KEY = 'test_team:suspensions';
const MAX_SUSPEND_DAYS = 365;

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_POLL_COLOR = '#22c55e';

async function loadList(key) {
  return (await getJSON(key)) || [];
}

function suspensionActive(s) {
  return s.until == null || s.until > Date.now();
}
function untilText(until) {
  return until == null ? 'dauerhaft' : fmtDateTime(until);
}
function durationText(days) {
  if (days == null) return 'Dauerhaft';
  return days === 1 ? '1 Tag' : `${days} Tage`;
}

module.exports = async function handler(req, res) {
  try {
    const { resource } = req.query || {};

    // ---------- Website-Lockdown ----------
    // GET ist bewusst öffentlich (auch ohne Login abrufbar), damit die
    // Lockdown-Meldung schon vor dem Einloggen angezeigt werden kann. Nur
    // Stv. Inhaber, Inhaber & Projektleitung dürfen den Lockdown
    // setzen/aufheben (siehe LOCKDOWN_MANAGER_ROLE_IDS in _lockdown.js).
    if (resource === 'lockdown') {
      if (req.method === 'GET') {
        return res.status(200).json(await getLockdownState());
      }
      if (req.method === 'POST') {
        const session = getSessionFromRequest(req);
        if (!session) return res.status(401).json({ error: 'Nicht angemeldet.' });
        if (!isLockdownExempt(session.roleId)) {
          return res.status(403).json({ error: 'Nur Stv. Inhaber, Inhaber und Projektleitung dürfen den Lockdown setzen/aufheben.' });
        }
        const { active, message } = req.body || {};
        const state = await setLockdownState(Boolean(active), { message, byRole: await resolveAccountName(session) });
        return res.status(200).json(state);
      }
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({ error: 'Methode nicht erlaubt.' });
    }

    // Lockdown: schreibende Zugriffe (POST/PUT/DELETE) auf alle übrigen
    // Ressourcen sind während eines aktiven Lockdowns gesperrt, außer für
    // die beiden Ränge, die ihn selbst aufheben dürfen.
    if (await blockIfLockedOut(req, res, getSessionFromRequest(req))) return;

    const key = KEYS[resource];
    if (!key) {
      return res.status(404).json({ error: 'Unbekannte Ressource.' });
    }

    // ---------- Teamliste (= Konten für den Konto-Login) ----------
    if (resource === 'roster') {
      if (req.method === 'GET') {
        const session = getSessionFromRequest(req);
        if (!session) return res.status(401).json({ error: 'Nicht angemeldet.' });
        // passwordHash niemals ans Frontend schicken. Die Detaildaten (User
        // ID/Discord-ID, wer/wann hinzugefügt) sieht nur, wer auch Teamler
        // hinzufügen darf (Auge-Button ist nur für diese Personen sichtbar).
        const canSeeDetails = Boolean(session.isAdmin || (session.perms && session.perms.rosterAdd));
        // Versteckte Konten (z.B. der Master-Zugang) werden aus der
        // Teamliste für die normale Mannschaft herausgefiltert - sichtbar
        // bleiben sie nur für die Inhaber-Ebene (alle mit isAdmin).
        const canSeeHidden = session.isAdmin;
        const items = (await loadList(key))
          .filter((x) => { const d = getRoleDef(x.roleId); return canSeeHidden || !(d && d.hidden); })
          .map(({ passwordHash, discordId, addedByRole, addedAt, ...rest }) => {
            return canSeeDetails ? { ...rest, discordId, addedByRole, addedAt } : rest;
          });
        const out = { items, canManage: canSeeDetails };
        if (canSeeDetails) {
          // Aktive Suspendierungen (für die Liste "Suspendiert" + Aufheben).
          out.suspensions = (await loadList(SUSPENSIONS_KEY)).filter(suspensionActive);
        }
        return res.status(200).json(out);
      }
      if (req.method === 'POST') {
        const session = requirePerm(req, res, 'rosterAdd');
        if (!session) return;
        const { name, username, discordId, password, roleId } = req.body || {};
        const cleanName = (name || '').trim();
        const cleanUsername = (username || '').trim();
        const cleanDiscordId = (discordId || '').trim();
        if (!cleanName || !cleanUsername || !cleanDiscordId || !password || !roleId) {
          return res.status(400).json({ error: 'Name, Benutzername, Discord-ID, Passwort und Rang sind erforderlich.' });
        }
        if (password.length < 4) {
          return res.status(400).json({ error: 'Passwort muss mindestens 4 Zeichen haben.' });
        }
        const roleDef = getRoleDef(roleId);
        if (!roleDef) {
          return res.status(400).json({ error: 'Unbekannter Rang.' });
        }

        // Suspendierung: solange sie läuft, darf mit dieser Discord-ID kein
        // Konto angelegt werden.
        const activeSuspension = (await loadList(SUSPENSIONS_KEY)).find((s) => s.discordId === cleanDiscordId && suspensionActive(s));
        if (activeSuspension) {
          return res.status(403).json({
            error: `Diese User ID ist suspendiert (${activeSuspension.until == null ? 'dauerhaft' : 'bis ' + untilText(activeSuspension.until)}). Bis dahin kann kein Konto damit erstellt werden.`,
          });
        }

        const list = await loadList(key);
        if (list.some((x) => (x.username || '').toLowerCase() === cleanUsername.toLowerCase())) {
          return res.status(400).json({ error: 'Dieser Benutzername ist bereits vergeben.' });
        }

        // Rang-Hierarchie: auch beim ANLEGEN eines neuen Kontos darf nur ein
        // Rang vergeben werden, der unterhalb des eigenen liegt. Ausnahme
        // (Bootstrap): der noch unbesetzte Eigentümer-Rang darf einmalig von
        // der Höheren Ebene vergeben werden.
        const ownerSlotFree = roleDef.isOwner && !list.some((x) => x.roleId === roleDef.id);
        if (roleDef.hidden) {
          // Versteckte Ränge (aktuell nur "master") laufen nicht über die
          // normale Hierarchie-Prüfung: nur die Projektleitung selbst darf
          // sie anlegen, und nur ein einziges Mal (Singleton).
          if (session.roleId !== 'projektleitung') {
            return res.status(403).json({ error: 'Diesen Zugang darf nur die Projektleitung selbst anlegen.' });
          }
          if (list.some((x) => x.roleId === roleDef.id)) {
            return res.status(400).json({ error: 'Dieser versteckte Zugang existiert bereits.' });
          }
        } else if (session.roleId === 'master') {
          // Der Master-Zugang darf jeden normalen (nicht versteckten) Rang vergeben.
        } else if (!ownerSlotFree) {
          const myIdx = rankIndex(session.roleId);
          const targetIdx = rankIndex(roleDef.id);
          if (myIdx === -1 || targetIdx === -1 || targetIdx <= myIdx) {
            return res.status(403).json({ error: 'Du kannst nur Ränge unterhalb deines eigenen Rangs vergeben.' });
          }
        } else if (!session.isAdmin) {
          return res.status(403).json({ error: 'Nur die Höhere Ebene darf diesen Rang vergeben.' });
        }

        const entry = {
          id: crypto.randomUUID(),
          name: cleanName,
          username: cleanUsername,
          discordId: cleanDiscordId,
          passwordHash: hashPassword(password),
          roleId: roleDef.id,
          addedByRole: await resolveAccountName(session),
          addedAt: Date.now(),
        };
        list.push(entry);
        await setJSON(key, list);
        // Die "ist beigetreten"-Meldung bleibt auch bei versteckten Konten
        // (Master-Zugang) bewusst AN, damit das Anlegen eines Vollzugriff-
        // Kontos nicht spurlos passiert.
        const joinActorDiscordId = findDiscordId(list, session.accountId);
        await syncTeamListEmbed(list);
        await postTeamLog({ kind: 'join', userDiscordId: entry.discordId, userName: entry.name, actorDiscordId: joinActorDiscordId, actorName: await resolveAccountName(session) });
        const { passwordHash, ...safeEntry } = entry;
        return res.status(200).json({ ok: true, item: safeEntry });
      }
      if (req.method === 'PUT') {
        // Teammitglied bearbeiten: Anzeigename/Username/Profilfarbe/Passwort
        // zurücksetzen braucht "rosterAdd". Den Rang zu ändern ist ein eigenes
        // Recht ("roleChange"): Team Verwaltung + komplette Höhere Ebene.
        const { id, name, username, avatarColor, resetPassword, roleId, reason } = req.body || {};
        const wantsOtherEdit = name !== undefined || username !== undefined || avatarColor !== undefined || Boolean(resetPassword);
        const wantsRoleChange = roleId !== undefined;

        let session = null;
        if (wantsOtherEdit) {
          session = requirePerm(req, res, 'rosterAdd');
          if (!session) return;
        }
        if (wantsRoleChange) {
          const s2 = requirePerm(req, res, 'roleChange');
          if (!s2) return;
          session = session || s2;
        }
        if (!session) {
          session = requirePerm(req, res, 'rosterAdd');
          if (!session) return;
        }

        const list = await loadList(key);
        const idx = list.findIndex((x) => x.id === id);
        if (idx === -1) return res.status(404).json({ error: 'Teammitglied nicht gefunden.' });

        // Versteckte Konten (Master-Zugang) dürfen NUR von der Projektleitung
        // oder vom Konto selbst bearbeitet werden.
        {
          const targetDefBefore = getRoleDef(list[idx].roleId);
          const isSelfAccount = Boolean(session && session.accountId) && list[idx].id === session.accountId;
          if (targetDefBefore && targetDefBefore.hidden && session.roleId !== 'projektleitung' && !isSelfAccount) {
            return res.status(403).json({ error: 'Dieses Konto kann nur von der Projektleitung oder dem Konto selbst bearbeitet werden.' });
          }
        }

        const changes = []; // für das Team-UPD-Log
        if (wantsRoleChange) {
          // Der Rang des exklusiven Top-Rangs (isOwner, "Projektleitung") ist
          // geschützt: den darf NIEMAND SONST ändern.
          var cleanReason = (reason || '').trim();
          if (!cleanReason) {
            return res.status(400).json({ error: 'Bitte einen Grund für die Rang-Änderung angeben.' });
          }
          const currentDef = getRoleDef(list[idx].roleId);
          var oldRoleId = list[idx].roleId;
          const isSelf = Boolean(session.accountId) && list[idx].id === session.accountId;
          if (currentDef && currentDef.isOwner && !isSelf) {
            return res.status(403).json({ error: 'Der Rang des Eigentümers kann nur vom Eigentümer selbst geändert werden.' });
          }
          const roleDef = getRoleDef(roleId);
          if (!roleDef) return res.status(400).json({ error: 'Unbekannter Rang.' });
          // Versteckte Ränge können NICHT nachträglich per Rang-Änderung
          // vergeben werden, nur beim Anlegen eines eigenen Kontos.
          if (roleDef.hidden) {
            return res.status(400).json({ error: 'Dieser Rang kann nicht per Rang-Änderung vergeben werden.' });
          }

          // Rang-Hierarchie: nur Ränge unterhalb des eigenen Rangs (RANK_ORDER).
          // Ausnahme (Bootstrap): unbesetzter Eigentümer-Rang darf einmalig
          // von einem Admin vergeben werden. Master darf jeden normalen Rang.
          const ownerSlotFree = roleDef.isOwner && !list.some((x) => x.roleId === roleDef.id);
          if (session.roleId === 'master') {
            // erlaubt
          } else if (!ownerSlotFree) {
            const myIdx = rankIndex(session.roleId);
            const targetIdx = rankIndex(roleDef.id);
            if (myIdx === -1 || targetIdx === -1 || targetIdx <= myIdx) {
              return res.status(403).json({ error: 'Du kannst nur Ränge unterhalb deines eigenen Rangs vergeben.' });
            }
          } else if (!session.isAdmin) {
            return res.status(403).json({ error: 'Nur die Höhere Ebene darf diesen Rang vergeben.' });
          }

          list[idx].roleId = roleDef.id;
          // roleVersion hochzählen -> offene Sitzung dieses Kontos wird beim
          // nächsten Status-Check automatisch ausgeloggt.
          list[idx].roleVersion = (list[idx].roleVersion || 0) + 1;
        }
        if (name !== undefined) {
          const cleanName = (name || '').trim();
          if (!cleanName) return res.status(400).json({ error: 'Anzeigename darf nicht leer sein.' });
          if (cleanName !== list[idx].name) changes.push(`Anzeigename: ${list[idx].name} → ${cleanName}`);
          list[idx].name = cleanName;
        }
        if (username !== undefined) {
          const cleanUsername = (username || '').trim();
          if (!cleanUsername) return res.status(400).json({ error: 'Username darf nicht leer sein.' });
          if (list.some((x) => x.id !== id && (x.username || '').toLowerCase() === cleanUsername.toLowerCase())) {
            return res.status(400).json({ error: 'Dieser Benutzername ist bereits vergeben.' });
          }
          if (cleanUsername !== list[idx].username) changes.push(`Benutzername: ${list[idx].username} → ${cleanUsername}`);
          list[idx].username = cleanUsername;
        }
        if (avatarColor !== undefined) {
          if (avatarColor && !/^#[0-9a-fA-F]{6}$/.test(avatarColor)) {
            return res.status(400).json({ error: 'Ungültige Farbe (Format: #RRGGBB).' });
          }
          if ((avatarColor || null) !== (list[idx].avatarColor || null)) changes.push('Profilfarbe geändert');
          list[idx].avatarColor = avatarColor || null;
        }
        if (resetPassword) {
          if (resetPassword.length < 4) {
            return res.status(400).json({ error: 'Neues Passwort muss mindestens 4 Zeichen haben.' });
          }
          list[idx].passwordHash = hashPassword(resetPassword);
          changes.push('Passwort zurückgesetzt');
        }

        await setJSON(key, list);
        const actorDiscordId = findDiscordId(list, session.accountId);
        const actorName = await resolveAccountName(session);
        if (wantsRoleChange) {
          const oldIdx = rankIndex(oldRoleId);
          const newIdx = rankIndex(list[idx].roleId);
          // Niedrigerer Index in RANK_ORDER = mächtigerer Rang, also Uprank.
          if (oldIdx !== -1 && newIdx !== -1 && oldIdx !== newIdx) {
            const kind = newIdx < oldIdx ? 'uprank' : 'downrank';
            const oldRoleDefForEvent = getRoleDef(oldRoleId);
            const newRoleDefForEvent = getRoleDef(list[idx].roleId);
            await postTeamLog({
              kind,
              userDiscordId: list[idx].discordId,
              userName: list[idx].name,
              actorDiscordId,
              actorName,
              reason: cleanReason,
              oldRoleName: oldRoleDefForEvent ? oldRoleDefForEvent.name : null,
              newRoleName: newRoleDefForEvent ? newRoleDefForEvent.name : null,
            });
          }
        }
        // Jede Bearbeitung an einem Team-Konto (Name/Username/Farbe/Passwort)
        // wird ebenfalls im Team-UPD geloggt.
        if (changes.length) {
          await postTeamLog({ kind: 'edit', userDiscordId: list[idx].discordId, userName: list[idx].name, actorDiscordId, actorName, changes });
        }
        await syncTeamListEmbed(list);
        const { passwordHash, ...safeEntry } = list[idx];
        return res.status(200).json({ ok: true, item: safeEntry });
      }
      if (req.method === 'DELETE') {
        const session = requirePerm(req, res, 'rosterAdd');
        if (!session) return;
        const { id, reason, duration, liftSuspension } = req.body || {};
        const actorName = await resolveAccountName(session);

        // ---- Suspendierung vorzeitig aufheben ----
        if (liftSuspension) {
          const susp = await loadList(SUSPENSIONS_KEY);
          const target = susp.find((s) => s.id === liftSuspension);
          if (!target) return res.status(404).json({ error: 'Suspendierung nicht gefunden.' });
          await setJSON(SUSPENSIONS_KEY, susp.filter((s) => s.id !== liftSuspension));
          const rosterNow = await loadList(key);
          await postTeamLog({ kind: 'lift', userDiscordId: target.discordId, userName: target.name, actorDiscordId: findDiscordId(rosterNow, session.accountId), actorName });
          return res.status(200).json({ ok: true });
        }

        // ---- Suspendieren (ehemals Kick) ----
        const cleanReason = (reason || '').trim();
        if (!cleanReason) {
          return res.status(400).json({ error: 'Bitte einen Grund für die Suspendierung angeben.' });
        }
        let days = null; // null = dauerhaft
        if (duration === 'permanent') {
          days = null;
        } else {
          days = parseInt(duration, 10);
          if (!Number.isFinite(days) || days < 1 || days > MAX_SUSPEND_DAYS) {
            return res.status(400).json({ error: `Bitte auswählen, wie lange suspendiert wird (1-${MAX_SUSPEND_DAYS} Tage oder dauerhaft).` });
          }
        }
        const list = await loadList(key);
        const removed = list.find((x) => x.id === id);
        // Versteckte Konten (Master-Zugang) dürfen nur von der Projektleitung
        // oder vom Konto selbst entfernt werden.
        if (removed) {
          const removedDef = getRoleDef(removed.roleId);
          const isSelfAccount = Boolean(session.accountId) && removed.id === session.accountId;
          if (removedDef && removedDef.hidden && session.roleId !== 'projektleitung' && !isSelfAccount) {
            return res.status(403).json({ error: 'Dieses Konto kann nur von der Projektleitung oder dem Konto selbst suspendiert werden.' });
          }
        }
        const nextList = list.filter((x) => x.id !== id);
        await setJSON(key, nextList);
        if (removed) {
          const until = days == null ? null : Date.now() + days * 24 * 60 * 60 * 1000;
          // Abgelaufene und ältere Einträge derselben Discord-ID entfernen.
          const susp = (await loadList(SUSPENSIONS_KEY)).filter((s) => suspensionActive(s) && s.discordId !== removed.discordId);
          susp.push({
            id: crypto.randomUUID(),
            discordId: removed.discordId,
            name: removed.name,
            username: removed.username,
            until,
            reason: cleanReason,
            byName: actorName,
            createdAt: Date.now(),
          });
          await setJSON(SUSPENSIONS_KEY, susp);
          await postTeamLog({
            kind: 'suspend',
            userDiscordId: removed.discordId,
            userName: removed.name,
            actorDiscordId: findDiscordId(list, session.accountId),
            actorName,
            reason: cleanReason,
            durationText: durationText(days),
            untilText: untilText(until),
          });
        }
        await syncTeamListEmbed(nextList);
        return res.status(200).json({ ok: true });
      }
    }

    // ---------- Abwesenheiten ----------
    if (resource === 'absences') {
      if (req.method === 'GET') {
        // Die Übersicht "aktuelle Abwesenheiten" ist nur für die komplette
        // Höhere Ebene und Team Verwaltung sichtbar.
        const session = requireHigherOrTeamVerwaltung(req, res);
        if (!session) return;
        return res.status(200).json({ items: await loadList(key) });
      }
      if (req.method === 'POST') {
        // Jedes angemeldete Team-Mitglied darf sich selbst abwesend melden.
        const session = getSessionFromRequest(req);
        if (!session) return res.status(401).json({ error: 'Nicht angemeldet.' });
        const { from, to, reason } = req.body || {};
        if (!from || !to) {
          return res.status(400).json({ error: 'Von- und Bis-Datum sind erforderlich.' });
        }
        const accountName = await resolveAccountName(session);
        const list = await loadList(key);
        const entry = {
          id: crypto.randomUUID(),
          name: accountName,
          from,
          to,
          reason: (reason || '').trim() || null,
          createdByRole: accountName,
          createdAt: Date.now(),
        };
        list.push(entry);
        await setJSON(key, list);
        return res.status(200).json({ ok: true, item: entry });
      }
      if (req.method === 'DELETE') {
        const session = requireHigherOrTeamVerwaltung(req, res);
        if (!session) return;
        const { id } = req.body || {};
        const list = await loadList(key);
        await setJSON(key, list.filter((x) => x.id !== id));
        return res.status(200).json({ ok: true });
      }
    }

    // ---------- Kummerkasten (anonym) ----------
    if (resource === 'kummerkasten') {
      if (req.method === 'GET') {
        const session = requireHigherOrTeamVerwaltung(req, res);
        if (!session) return;
        return res.status(200).json({ items: await loadList(key) });
      }
      if (req.method === 'POST') {
        // Jedes angemeldete Team-Mitglied darf einreichen. Es wird bewusst
        // NICHT gespeichert, wer es eingereicht hat.
        const session = getSessionFromRequest(req);
        if (!session) return res.status(401).json({ error: 'Nicht angemeldet.' });
        const { message } = req.body || {};
        if (!message || !message.trim()) return res.status(400).json({ error: 'Nachricht ist erforderlich.' });
        const list = await loadList(key);
        const entry = {
          id: crypto.randomUUID(),
          message: message.trim(),
          read: false,
          createdAt: Date.now(),
        };
        list.push(entry);
        await setJSON(key, list);
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'PUT') {
        const session = requireHigherOrTeamVerwaltung(req, res);
        if (!session) return;
        const { id, read } = req.body || {};
        const list = await loadList(key);
        const idx = list.findIndex((x) => x.id === id);
        if (idx === -1) return res.status(404).json({ error: 'Eintrag nicht gefunden.' });
        list[idx].read = Boolean(read);
        await setJSON(key, list);
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'DELETE') {
        const session = requireHigherOrTeamVerwaltung(req, res);
        if (!session) return;
        const { id } = req.body || {};
        const list = await loadList(key);
        await setJSON(key, list.filter((x) => x.id !== id));
        return res.status(200).json({ ok: true });
      }
    }

    // ---------- Verwarnungen (intern, für Team-Mitglieder selbst) ----------
    if (resource === 'warnings') {
      // Sucht das Roster-Konto zu einem Namen (für die Discord-Erwähnung im Log).
      const findRosterByName = async (n) => {
        const roster = await loadList(KEYS.roster);
        const entry = roster.find((r) => (r.name || '').toLowerCase() === (n || '').toLowerCase()) || null;
        return { roster, entry };
      };
      if (req.method === 'GET') {
        const session = getSessionFromRequest(req);
        if (!session) return res.status(401).json({ error: 'Nicht angemeldet.' });
        return res.status(200).json({ items: await loadList(key) });
      }
      if (req.method === 'POST') {
        // Eine Verwarnung gegen ein Team-Mitglied auszusprechen erfordert
        // das "warnTeam"-Recht.
        const session = requirePerm(req, res, 'warnTeam');
        if (!session) return;
        const { name, reason } = req.body || {};
        if (!name || !name.trim() || !reason || !reason.trim()) {
          return res.status(400).json({ error: 'Name und Grund sind erforderlich.' });
        }
        const list = await loadList(key);
        const entry = {
          id: crypto.randomUUID(),
          name: name.trim(),
          reason: reason.trim(),
          issuedByRole: await resolveAccountName(session),
          createdAt: Date.now(),
        };
        list.push(entry);
        await setJSON(key, list);
        const { roster, entry: target } = await findRosterByName(entry.name);
        await postTeamLog({
          kind: 'warn',
          userDiscordId: target ? target.discordId : null,
          userName: entry.name,
          actorDiscordId: findDiscordId(roster, session.accountId),
          actorName: entry.issuedByRole,
          reason: entry.reason,
        });
        return res.status(200).json({ ok: true, item: entry });
      }
      if (req.method === 'DELETE') {
        const session = requirePerm(req, res, 'warnTeam');
        if (!session) return;
        const { id } = req.body || {};
        const list = await loadList(key);
        const removed = list.find((x) => x.id === id);
        await setJSON(key, list.filter((x) => x.id !== id));
        if (removed) {
          const { roster, entry: target } = await findRosterByName(removed.name);
          await postTeamLog({
            kind: 'warn_remove',
            userDiscordId: target ? target.discordId : null,
            userName: removed.name,
            actorDiscordId: findDiscordId(roster, session.accountId),
            actorName: await resolveAccountName(session),
            reason: removed.reason,
          });
        }
        return res.status(200).json({ ok: true });
      }
    }

    // ---------- Umfragen (Ankündigungen: Umfrage-Variante) ----------
    // Abstimmen läuft NUR auf der Team-Website selbst. Bei anonymen Umfragen
    // wird pro Konto gespeichert, DASS es abgestimmt hat, aber NICHT wofür.
    if (resource === 'polls') {
      if (req.method === 'GET') {
        const session = getSessionFromRequest(req);
        if (!session) return res.status(401).json({ error: 'Nicht angemeldet.' });
        const list = await loadList(key);
        list.sort((a, b) => b.createdAt - a.createdAt);
        const items = list.map((p) => {
          const counts = {};
          (p.options || []).forEach((o) => { counts[o.id] = 0; });
          (p.votes || []).forEach((v) => { if (counts[v.optionId] !== undefined) counts[v.optionId]++; });
          const myVote = session.accountId ? (p.votes || []).find((v) => v.accountId === session.accountId) : null;
          const out = {
            id: p.id,
            question: p.question,
            anonymous: Boolean(p.anonymous),
            options: p.options || [],
            counts,
            totalVotes: (p.votes || []).length,
            myOptionId: myVote ? myVote.optionId : null,
            pings: p.pings || [],
            durationDays: p.durationDays || 7,
            color: p.color || DEFAULT_POLL_COLOR,
            createdByRole: p.createdByRole,
            createdAt: p.createdAt,
          };
          if (!p.anonymous) {
            out.voters = (p.votes || []).map((v) => ({ optionId: v.optionId, voterName: v.voterName }));
          }
          return out;
        });
        return res.status(200).json({ items });
      }

      if (req.method === 'POST') {
        const { mode } = req.body || {};

        // ---- Abstimmen: jedes eingeloggte Konto, ein Vote pro Umfrage ----
        if (mode === 'vote') {
          const session = getSessionFromRequest(req);
          if (!session) return res.status(401).json({ error: 'Nicht angemeldet.' });
          if (!session.accountId) return res.status(400).json({ error: 'Kein Konto mit dieser Sitzung verknüpft.' });
          const { id, optionId } = req.body || {};
          const list = await loadList(key);
          const idx = list.findIndex((p) => p.id === id);
          if (idx === -1) return res.status(404).json({ error: 'Umfrage nicht gefunden.' });
          const poll = list[idx];
          if (!(poll.options || []).some((o) => o.id === optionId)) {
            return res.status(400).json({ error: 'Ungültige Option.' });
          }
          const voterName = poll.anonymous ? null : await resolveAccountName(session);
          const votes = (poll.votes || []).filter((v) => v.accountId !== session.accountId);
          votes.push({ accountId: session.accountId, optionId, voterName });
          poll.votes = votes;
          await setJSON(key, list);
          return res.status(200).json({ ok: true });
        }

        // ---- Neue Umfrage erstellen: gleiches Recht wie Ankündigungen ----
        const session = requirePerm(req, res, 'announcementCreate');
        if (!session) return;
        const { question, anonymous, options, pings, durationDays, color } = req.body || {};
        const cleanQuestion = (question || '').trim();
        const cleanOptions = Array.isArray(options)
          ? options.map((o) => (o || '').trim()).filter(Boolean).slice(0, 25)
          : [];
        if (!cleanQuestion || cleanOptions.length < 2) {
          return res.status(400).json({ error: 'Bitte eine Frage und mindestens 2 Optionen angeben.' });
        }
        let cleanDurationDays = parseInt(durationDays, 10);
        if (!Number.isFinite(cleanDurationDays)) cleanDurationDays = 7;
        cleanDurationDays = Math.min(32, Math.max(1, cleanDurationDays));
        const cleanColor = HEX_COLOR_RE.test(color) ? color : DEFAULT_POLL_COLOR;
        const list = await loadList(key);
        const entry = {
          id: crypto.randomUUID(),
          question: cleanQuestion,
          anonymous: Boolean(anonymous),
          options: cleanOptions.map((text) => ({ id: crypto.randomUUID(), text })),
          pings: cleanPings(pings),
          durationDays: cleanDurationDays,
          color: cleanColor,
          votes: [],
          createdByRole: await resolveAccountName(session),
          createdAt: Date.now(),
        };
        // Discord-Nachricht mit "wait" erstellen, damit die Nachrichten-ID
        // für spätere Bearbeitung/Löschung gespeichert werden kann.
        const discordResult = await postPollToDiscord(entry);
        if (discordResult && discordResult.messageId) {
          entry.discordMessageId = discordResult.messageId;
        }
        list.push(entry);
        await setJSON(key, list);
        return res.status(200).json({ ok: true, poll: entry });
      }

      if (req.method === 'PUT') {
        // Bearbeiten: nur Farbe, Pings und Anonymität lassen sich nachträglich ändern.
        const session = requirePerm(req, res, 'announcementCreate');
        if (!session) return;
        const { id, color, pings, anonymous } = req.body || {};
        const list = await loadList(key);
        const idx = list.findIndex((p) => p.id === id);
        if (idx === -1) return res.status(404).json({ error: 'Umfrage nicht gefunden.' });
        if (color !== undefined && HEX_COLOR_RE.test(color)) list[idx].color = color;
        if (pings !== undefined) list[idx].pings = cleanPings(pings);
        if (anonymous !== undefined) list[idx].anonymous = Boolean(anonymous);
        await setJSON(key, list);
        await editPollDiscordMessage(list[idx]);
        return res.status(200).json({ ok: true, poll: list[idx] });
      }

      if (req.method === 'DELETE') {
        const session = requirePerm(req, res, 'announcementCreate');
        if (!session) return;
        const { id } = req.body || {};
        const list = await loadList(key);
        const removed = list.find((p) => p.id === id);
        await setJSON(key, list.filter((p) => p.id !== id));
        if (removed) await deletePollDiscordMessage(removed);
        return res.status(200).json({ ok: true });
      }
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};

// Team-UPD-Log: schreibt JEDE Interaktion mit einem Team-Konto (Beitritt,
// Uprank/Downrank, Suspendierung, Aufhebung einer Suspendierung, Verwarnung,
// Verwarnung entfernt, Konto bearbeitet) in den Team-UPD-Discord-Webhook.
//
// Webhook-URL (nur Umgebungsvariable, nie im Quellcode):
//   DISCORD_TEAM_UPD_WEBHOOK_URL  (bevorzugt, falls gesetzt)
//   DISCORD_RANK_WEBHOOK_URL      (Fallback: der bisherige Rang-Webhook)
//
// Ein Fehler beim Webhook darf die eigentliche Aktion nie blockieren.
const RANK_EVENT_PING_ROLE_ID = '1540725051853115562';
const TEAM_LOG_PING_USER_ID = '1439409063795621938'; // wird bei jedem Log mitgepingt

function webhookUrl() {
  return process.env.DISCORD_TEAM_UPD_WEBHOOK_URL || process.env.DISCORD_RANK_WEBHOOK_URL || null;
}

const mention = (id, fallback) => (id ? `<@${id}>` : (fallback || 'Unbekannt'));

function fmtDateTime(ts) {
  return new Date(ts).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

function buildEmbed(e) {
  const user = mention(e.userDiscordId, e.userName);
  const actor = mention(e.actorDiscordId, e.actorName);
  const dateStr = fmtDateTime(Date.now());
  const roleLine = (e.oldRoleName && e.newRoleName) ? `**Rolle:** ${e.oldRoleName} → ${e.newRoleName}\n` : '';
  const reason = e.reason || 'Kein Grund angegeben';
  switch (e.kind) {
    case 'uprank':
      return { title: 'Herzlichen Glückwunsch 🎉', color: 0x22c55e,
        description: `${user} Hat einen Uprank erhalten\n\n**Wer:** ${user}\n**Von:** ${actor}\n${roleLine}**Grund:**\n${reason}\n\n-# ${dateStr}` };
    case 'downrank':
      return { title: 'Leider 😔', color: 0xef4444,
        description: `${user} Hat einen Downrank erhalten\n\n**Wer:** ${user}\n**Von:** ${actor}\n${roleLine}**Grund:**\n${reason}\n\n-# ${dateStr}` };
    case 'join':
      return { title: 'Willkommen im Team 👋', color: 0x6d64f2,
        description: `${user} ist dem Team beigetreten\n\n**Wer:** ${user}\n**angenommen von:** ${actor}\n\n-# ${dateStr}` };
    case 'suspend':
      return { title: 'Team-Mitglied suspendiert ⛔', color: 0xef4444,
        description: `${user} wurde aus dem Team entfernt und suspendiert\n\n**Wer:** ${user}\n**Suspendiert von:** ${actor}\n**Dauer:** ${e.durationText || 'unbekannt'}\n**Neues Konto möglich ab:** ${e.untilText || 'unbekannt'}\n**Grund:**\n${reason}\n\n-# ${dateStr}` };
    case 'lift':
      return { title: 'Suspendierung aufgehoben ✅', color: 0x22c55e,
        description: `Die Suspendierung von ${user} wurde aufgehoben\n\n**Wer:** ${user}\n**Aufgehoben von:** ${actor}\n\n-# ${dateStr}` };
    case 'warn':
      return { title: 'Verwarnung ausgesprochen ⚠️', color: 0xf59e0b,
        description: `${user} hat eine Verwarnung erhalten\n\n**Wer:** ${user}\n**Von:** ${actor}\n**Grund:**\n${reason}\n\n-# ${dateStr}` };
    case 'warn_remove':
      return { title: 'Verwarnung entfernt 🧹', color: 0x6d64f2,
        description: `Eine Verwarnung von ${user} wurde entfernt\n\n**Wer:** ${user}\n**Entfernt von:** ${actor}\n**Ursprünglicher Grund:**\n${reason}\n\n-# ${dateStr}` };
    case 'edit':
      return { title: 'Team-Konto bearbeitet ✏️', color: 0x6d64f2,
        description: `Das Konto von ${user} wurde bearbeitet\n\n**Wer:** ${user}\n**Von:** ${actor}\n**Änderungen:**\n${(e.changes || []).map((c) => `• ${c}`).join('\n') || '–'}\n\n-# ${dateStr}` };
    default:
      return null;
  }
}

async function postTeamLog(event) {
  const url = webhookUrl();
  if (!url) return;
  const embed = buildEmbed(event);
  if (!embed) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: `||<@&${RANK_EVENT_PING_ROLE_ID}> <@${TEAM_LOG_PING_USER_ID}>||`,
        embeds: [embed],
        allowed_mentions: { parse: ['roles', 'users'] },
      }),
    });
  } catch (err) {
    // Absichtlich verschluckt: ein Webhook-Fehler darf die Aktion nicht blockieren.
  }
}

module.exports = { postTeamLog, fmtDateTime, TEAM_LOG_PING_USER_ID };

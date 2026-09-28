// Discord-Webhooks der Hauptwebseite - Ankündigungen, Bewertungen und
// Partnerliste. Alle drei sind SYNCHRONISIERT: Was auf der Website erstellt,
// geändert oder gelöscht wird, wird auch in Discord nachgezogen.
//
// So funktioniert die Synchronisierung: Beim Erstellen wird die Nachricht mit
// "?wait=true" gesendet, Discord antwortet dann mit der Nachrichten-ID. Diese
// ID wird am Eintrag gespeichert (discordMessageId). Über dieselbe Webhook-URL
// lässt sich die Nachricht später bearbeiten (PATCH) oder löschen (DELETE) -
// dafür braucht es keinen Bot.
//
// Die Webhook-URLs stehen bewusst NUR in Umgebungsvariablen (Vercel →
// Settings → Environment Variables) und niemals im Quellcode (wer die URL
// kennt, kann in den Kanal posten):
//   DRP_ANNOUNCEMENT_WEBHOOK_URL  Ankündigungen
//   DISCORD_WEBHOOK_URL           Bewertungen
//   DRP_PARTNER_WEBHOOK_URL       Partnerliste
//   DRP_AUTOMOD_WEBHOOK_URL       Automod-Log (siehe lib/_automod.js)
//
// Ein Fehler beim Webhook-Aufruf darf die eigentliche Aktion (speichern,
// löschen, ...) nie blockieren - alle Funktionen hier fangen Fehler ab und
// werfen nie.
const { getJSON, setJSON } = require('./_kv');
const { PARTNER_CATEGORIES, categoryOf } = require('./_partnerCategories');

// Die Rollen-ID ist kein Geheimnis (sie steht ohnehin sichtbar im Ping selbst),
// deshalb darf sie im Quellcode stehen.
const ANNOUNCEMENT_PING_ROLE_ID = '1540725031175323670';
const REQUEST_TIMEOUT_MS = 6000;
const PARTNER_STATE_KEY = 'drp_main:partners_discord';

// ---------- Low-Level ----------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Baut die URL für "neue Nachricht" bzw. "bestehende Nachricht". Über URL()
// statt String-Konkatenation, damit evtl. Query-Parameter der Webhook-URL
// (z.B. ?thread_id=...) erhalten bleiben.
function buildUrl(webhookUrl, { messageId, wait } = {}) {
  const u = new URL(webhookUrl);
  if (messageId) u.pathname = u.pathname.replace(/\/+$/, '') + '/messages/' + encodeURIComponent(messageId);
  if (wait) u.searchParams.set('wait', 'true');
  return u.toString();
}

// Ein Request mit Timeout (hängt Discord, blockiert das nicht die Serverless-
// Function) und EINEM Retry bei Rate-Limit (429), sofern die Wartezeit kurz ist.
async function discordRequest(method, url, payload, attempt = 0) {
  const res = await fetch(url, {
    method,
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (res.status === 429 && attempt === 0) {
    const data = await res.json().catch(() => ({}));
    const waitMs = Math.ceil((Number(data.retry_after) || 1) * 1000);
    if (waitMs <= 3000) {
      await sleep(waitMs);
      return discordRequest(method, url, payload, 1);
    }
  }
  return res;
}

// Neue Nachricht senden. Gibt die Nachrichten-ID zurück (oder null, wenn kein
// Webhook konfiguriert ist bzw. das Senden fehlgeschlagen ist).
async function webhookSend(webhookUrl, payload) {
  if (!webhookUrl) return null;
  try {
    const res = await discordRequest('POST', buildUrl(webhookUrl, { wait: true }), payload);
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    return data && data.id ? String(data.id) : null;
  } catch {
    return null;
  }
}

// Bestehende Nachricht bearbeiten. 'ok' | 'gone' (Nachricht existiert in
// Discord nicht mehr, z.B. dort manuell gelöscht) | 'error'.
async function webhookEdit(webhookUrl, messageId, payload) {
  if (!webhookUrl || !messageId) return 'error';
  try {
    const res = await discordRequest('PATCH', buildUrl(webhookUrl, { messageId }), payload);
    if (res.ok) return 'ok';
    return res.status === 404 ? 'gone' : 'error';
  } catch {
    return 'error';
  }
}

// Bestehende Nachricht löschen. 404 zählt als erfolgreich (ist ja weg).
async function webhookDelete(webhookUrl, messageId) {
  if (!webhookUrl || !messageId) return 'error';
  try {
    const res = await discordRequest('DELETE', buildUrl(webhookUrl, { messageId }));
    return res.ok || res.status === 404 ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

function colorToInt(hex, fallback) {
  const n = parseInt(String(hex || '').replace('#', ''), 16);
  return Number.isFinite(n) ? n : fallback;
}

function formatDate(ts) {
  return new Date(ts).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
}

// ---------- Ankündigungen ----------

const announcementWebhook = () => process.env.DRP_ANNOUNCEMENT_WEBHOOK_URL;

function announcementEmbed(entry) {
  let footer = `${formatDate(entry.createdAt)} · ${entry.createdByName}`;
  if (entry.updatedAt) footer += ` · bearbeitet von ${entry.updatedByName || 'Team'} (${formatDate(entry.updatedAt)})`;
  return {
    title: entry.title,
    description: `${entry.content}\n\n-# ${footer}`,
    color: colorToInt(entry.color, 0x6d64f2),
  };
}

// Gibt die Discord-Nachrichten-ID zurück (oder null).
async function postAnnouncementToDiscord(entry) {
  return webhookSend(announcementWebhook(), {
    content: `||<@&${ANNOUNCEMENT_PING_ROLE_ID}>||`,
    embeds: [announcementEmbed(entry)],
    // Nur die feste Ankündigungs-Rolle darf gepingt werden - egal was im
    // Titel/Inhalt steht.
    allowed_mentions: { roles: [ANNOUNCEMENT_PING_ROLE_ID] },
  });
}

// Beim Bearbeiten bleibt der Ping-Text unverändert (Discord pingt bei
// Bearbeitungen nicht erneut), nur das Embed wird ersetzt.
async function updateAnnouncementOnDiscord(entry) {
  if (!entry.discordMessageId) return 'error';
  return webhookEdit(announcementWebhook(), entry.discordMessageId, {
    embeds: [announcementEmbed(entry)],
    allowed_mentions: { parse: [] },
  });
}

async function deleteAnnouncementFromDiscord(entry) {
  if (!entry || !entry.discordMessageId) return 'error';
  return webhookDelete(announcementWebhook(), entry.discordMessageId);
}

// ---------- Bewertungen ----------

const reviewWebhook = () => process.env.DISCORD_WEBHOOK_URL;

function reviewEmbed(review) {
  const stars = '⭐'.repeat(review.rating) + '☆'.repeat(5 - review.rating);
  const displayName = review.name || (review.guest ? 'Gast' : 'Anonym');
  let comment = '_Kein Kommentar_';
  if (review.commentCensored) comment = '_Kommentar wurde vom Team entfernt_';
  else if (review.comment) comment = review.comment;
  return {
    title: 'Neue Bewertung erhalten',
    color: 0x6d64f2,
    fields: [
      { name: 'Von', value: displayName, inline: true },
      { name: 'Sterne', value: `${stars} (${review.rating}/5)`, inline: true },
      { name: 'Kommentar', value: comment },
    ],
    timestamp: new Date(review.createdAt).toISOString(),
  };
}

async function postReviewToDiscord(review) {
  return webhookSend(reviewWebhook(), { embeds: [reviewEmbed(review)], allowed_mentions: { parse: [] } });
}

async function updateReviewOnDiscord(review) {
  if (!review.discordMessageId) return 'error';
  return webhookEdit(reviewWebhook(), review.discordMessageId, {
    embeds: [reviewEmbed(review)],
    allowed_mentions: { parse: [] },
  });
}

async function deleteReviewFromDiscord(review) {
  if (!review || !review.discordMessageId) return 'error';
  return webhookDelete(reviewWebhook(), review.discordMessageId);
}

// ---------- Partnerliste ----------
// Anders als bei Ankündigungen/Bewertungen (eine Nachricht pro Eintrag) ist
// die Partnerliste EINE gepflegte Liste: pro Kategorie eine Nachricht mit
// allen Partnern (Klein/Mittel/Groß/Sonder). Bei jeder Änderung auf der
// Website (hinzufügen, bearbeiten, entfernen) werden diese Nachrichten
// aktualisiert - die Discord-Liste entspricht also immer der Website.
// Die Nachrichten-IDs stehen in PARTNER_STATE_KEY.

const partnerWebhook = () => process.env.DRP_PARTNER_WEBHOOK_URL;
const EMBED_DESC_LIMIT = 3800; // Discord erlaubt 4096, etwas Luft für "(Fortsetzung)" usw.

// Markdown-Sonderzeichen im Namen entschärfen, damit ein Name wie "[x](y)"
// den Link im Embed nicht kapert.
function escapeMd(text) {
  return String(text).replace(/([\\*_`~|>\[\]()])/g, '\\$1');
}

function safeLinkUrl(url) {
  return String(url).replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');
}

function chunkLines(lines, limit) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    if (current && current.length + 1 + line.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + '\n' + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Immer alle vier Kategorien (auch leere) - dadurch bleibt die Nachrichten-
// Anzahl stabil und die Nachrichten können meist einfach bearbeitet werden,
// statt neu gepostet zu werden.
function buildPartnerEmbeds(partners) {
  const embeds = [];
  const now = new Date().toISOString();
  for (const cat of PARTNER_CATEGORIES) {
    // Gleiche Reihenfolge wie auf der Website: neueste zuerst.
    const items = partners
      .filter((p) => categoryOf(p) === cat.id)
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    const lines = items.map((p) => `• [${escapeMd(p.name)}](${safeLinkUrl(p.inviteLink)})`);
    const chunks = lines.length ? chunkLines(lines, EMBED_DESC_LIMIT) : ['_Noch keine Partner in dieser Kategorie_'];
    chunks.forEach((description, i) => {
      embeds.push({
        title: i === 0 ? cat.label : `${cat.label} (Fortsetzung)`,
        description,
        color: cat.color,
        footer: { text: 'Deutschland RP · Partnerliste' },
        timestamp: now,
      });
    });
  }
  return embeds;
}

// Bringt die Discord-Nachrichten auf den Stand der Website.
//  - Gleiche Nachrichtenzahl wie zuletzt: vorhandene Nachrichten bearbeiten.
//  - Nachricht in Discord fehlt (dort gelöscht) oder Anzahl hat sich geändert
//    (z.B. sehr lange Kategorie): alles löschen und in der richtigen
//    Reihenfolge neu posten.
//  - Netzwerkfehler beim Bearbeiten: nichts verändern (kein Duplikat-Risiko),
//    die nächste Änderung synchronisiert wieder.
async function syncPartnersToDiscord(partners) {
  const url = partnerWebhook();
  if (!url) return;
  try {
    const state = (await getJSON(PARTNER_STATE_KEY)) || {};
    const oldIds = Array.isArray(state.messageIds) ? state.messageIds : [];
    const embeds = buildPartnerEmbeds(partners);

    let needRepost = oldIds.length !== embeds.length;
    if (!needRepost) {
      for (let i = 0; i < embeds.length; i += 1) {
        const result = await webhookEdit(url, oldIds[i], { embeds: [embeds[i]], allowed_mentions: { parse: [] } });
        if (result === 'gone') { needRepost = true; break; }
        if (result === 'error') return;
      }
      if (!needRepost) return;
    }

    for (const id of oldIds) await webhookDelete(url, id);
    const newIds = [];
    for (const embed of embeds) {
      const id = await webhookSend(url, { embeds: [embed], allowed_mentions: { parse: [] } });
      if (id) newIds.push(id);
    }
    await setJSON(PARTNER_STATE_KEY, { messageIds: newIds, updatedAt: Date.now() });
  } catch {
    // Absichtlich verschluckt (siehe Kopfkommentar).
  }
}

// ---------- Automod-Log ----------
// Kein Ankündigungs-/Bewertungs-/Partner-Muster (kein Bearbeiten/Löschen
// nötig - jeder Treffer ist eine eigene, abgeschlossene Log-Nachricht).
// Wird von lib/_automod.js NICHT selbst aufgerufen (die Prüf-Logik dort
// kennt kein Discord) - stattdessen rufen die Endpunkte (register/
// update-name/update-username/review) nach jedem Treffer (blocked ODER
// uncertain) diese Funktion auf.

const automodWebhook = () => process.env.DRP_AUTOMOD_WEBHOOK_URL;

async function postAutomodLog({ area, verdict, matched, text, actor }) {
  const url = automodWebhook();
  if (!url) return;
  const isBlocked = verdict === 'blocked';
  await webhookSend(url, {
    embeds: [{
      title: isBlocked ? '🚫 Automod: Inhalt blockiert' : '⚠️ Automod: Unsicherer Treffer (nur geloggt)',
      color: isBlocked ? 0xef4a63 : 0xf5a623,
      fields: [
        { name: 'Bereich', value: area, inline: true },
        { name: 'Ergebnis', value: isBlocked ? 'Blockiert' : 'Unsicher (nicht blockiert)', inline: true },
        { name: 'Erkannt', value: '`' + matched + '`', inline: true },
        { name: 'Von', value: actor || 'Unbekannt' },
        { name: 'Inhalt', value: (text && String(text).slice(0, 500)) || '_leer_' },
      ],
      timestamp: new Date().toISOString(),
    }],
    allowed_mentions: { parse: [] },
  });
}

// ---------- Status-Check (für die öffentliche "Website Status"-Seite) ----------
// Prüft, ob ein Webhook erreichbar ist, OHNE etwas zu posten: Discord erlaubt
// GET auf die Webhook-URL selbst, das liefert nur die Webhook-Infos zurück
// (kein Kanal-Post, keine Nachrichten-ID nötig). "configured: false" heißt,
// die zugehörige Umgebungsvariable ist gar nicht gesetzt - das ist kein
// Fehler, sondern nur "Feature noch nicht eingerichtet".
async function checkWebhook(url) {
  if (!url) return { configured: false, ok: false, latencyMs: null };
  const start = Date.now();
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { configured: true, ok: res.ok, latencyMs: Date.now() - start };
  } catch {
    return { configured: true, ok: false, latencyMs: null };
  }
}

// Prüft die offizielle Discord-API selbst (unabhängig von unseren eigenen
// Webhooks) über den öffentlichen, unauthentifizierten /gateway-Endpunkt -
// zeigt, ob ein Problem bei UNS (Webhook-URL falsch/gelöscht) oder bei
// Discord selbst liegt.
async function checkDiscordApiGeneral() {
  const start = Date.now();
  try {
    const res = await fetch('https://discord.com/api/v10/gateway', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    return { configured: true, ok: res.ok, latencyMs: Date.now() - start };
  } catch {
    return { configured: true, ok: false, latencyMs: null };
  }
}

async function checkDiscordStatus() {
  const [api, announcements, reviews, partners, automod] = await Promise.all([
    checkDiscordApiGeneral(),
    checkWebhook(announcementWebhook()),
    checkWebhook(reviewWebhook()),
    checkWebhook(partnerWebhook()),
    checkWebhook(automodWebhook()),
  ]);
  return { api, announcements, reviews, partners, automod };
}

module.exports = {
  ANNOUNCEMENT_PING_ROLE_ID,
  postAnnouncementToDiscord,
  updateAnnouncementOnDiscord,
  deleteAnnouncementFromDiscord,
  postReviewToDiscord,
  updateReviewOnDiscord,
  deleteReviewFromDiscord,
  syncPartnersToDiscord,
  postAutomodLog,
  checkDiscordStatus,
  // für Tests
  buildPartnerEmbeds,
};

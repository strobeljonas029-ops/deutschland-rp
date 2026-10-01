// Shared Upstash Redis REST helper.
//
// WICHTIG (Bugfix): Frühere Version hat Werte in den URL-Pfad kodiert
// (/set/key/value). Das funktioniert nur für kurze Werte – bei größeren
// Inhalten (z.B. das Hintergrundbild als Base64, oder mit der Zeit
// wachsende Listen wie Moderationsdaten) wird die URL zu lang und die
// Anfrage schlägt fehl (Server/Proxy-Limits für URL-Länge liegen meist
// deutlich unter dem, was ein Bild als Base64-String braucht).
//
// Fix: Alle Befehle werden jetzt per POST an den Basis-Endpunkt geschickt,
// mit dem Redis-Befehl als JSON-Array im Body (offizielles Upstash-REST-
// Format). Das hat keine praktische Längenbeschränkung mehr durch die URL.
const BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function command(args) {
  if (!BASE || !TOKEN) {
    throw new Error('Upstash-Umgebungsvariablen fehlen (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)');
  }
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Upstash-Fehler ${res.status}: ${text}`);
  }
  const data = await res.json();
  if (data && data.error) {
    throw new Error('Upstash-Fehler: ' + data.error);
  }
  return data.result;
}

async function get(key) {
  const result = await command(['GET', key]);
  return result == null ? null : result;
}

async function getJSON(key) {
  const raw = await get(key);
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function set(key, value) {
  return command(['SET', key, value]);
}

async function setJSON(key, value) {
  return set(key, JSON.stringify(value));
}

// Setzt einen Wert mit Ablaufzeit (Sekunden) – wird für Login-Sperren benutzt.
async function setEx(key, seconds, value) {
  return command(['SET', key, value, 'EX', String(seconds)]);
}

async function expire(key, seconds) {
  return command(['EXPIRE', key, String(seconds)]);
}

async function del(key) {
  return command(['DEL', key]);
}

async function incr(key) {
  return command(['INCR', key]);
}

async function mget(keys) {
  if (!keys.length) return [];
  return command(['MGET', ...keys]);
}

module.exports = { command, get, getJSON, set, setJSON, setEx, expire, del, incr, mget };

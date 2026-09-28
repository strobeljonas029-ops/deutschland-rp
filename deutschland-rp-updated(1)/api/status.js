// Öffentliche "Website Status"-Seite der Hauptwebseite. Zeigt für jede
// wichtige Komponente (Kern-System, jeden einzelnen API-Endpunkt, jeden
// Discord-Webhook) den aktuellen Zustand, die Antwortzeit (ms) UND einen
// 30-Tage-Verlauf mit Verfügbarkeits-% - im Stil klassischer Status-Seiten
// (z.B. PowerBot-Status). Bewusst öffentlich (GET, keine Anmeldung nötig) -
// jeder Besucher soll auf einen Blick sehen können, ob gerade eine Störung
// vorliegt.
//
// Die einzelnen Checks rufen NICHT die echten Endpunkte per HTTP auf (das
// könnte bei POST-lastigen Routen Nebenwirkungen haben oder unnötig
// Login/Rechte voraussetzen), sondern die gleichen zugrunde liegenden
// Lese-Funktionen, die die jeweilige Route selbst zum Laden ihrer Daten
// benutzt - rein lesend, ohne jede Schreibwirkung.
//
// Verlauf/Uptime-%: pro Dienst und Tag wird per INCR (atomar, kein Race-
// Condition-Risiko bei gleichzeitigen Besuchern) mitgezählt, wie oft er
// geprüft wurde ("total") und wie oft die Prüfung erfolgreich war ("up").
// Für die Anzeige werden die letzten 30 Tage in genau zwei MGET-Aufrufen
// (alle total-Keys, alle up-Keys) auf einmal geladen.
const { get, set, setEx, del, getJSON, mget, incr } = require('../lib/_kv');
const { checkDiscordStatus } = require('../lib/_discord');
const { loadUsers, loadTeamRoster, getAccountIdFromRequest } = require('../lib/_account');
const { getLockdownState } = require('../lib/_lockdown');

const PROBE_KEY = 'drp_main:status_probe';
const HISTORY_DAYS = 30;
const REFRESH_INTERVAL_MS = 30000;
const MAX_TEST_MINUTES = 60;

// Alle bekannten Dienst-IDs (siehe SERVICES weiter unten) - hier separat
// gepflegt, damit die Test-Störungs-Funktion (POST) sie validieren kann,
// ohne für jede Anfrage erst alle echten Prüfungen laufen lassen zu müssen.
const SERVICE_IDS = [
  'website', 'database',
  'api_partners', 'api_reviews', 'api_teamRoster', 'api_lockdown', 'api_visit', 'api_users', 'api_auth',
  'discord_api', 'discord_announcements', 'discord_reviews', 'discord_partners', 'discord_automod',
];

async function timed(fn) {
  const start = Date.now();
  try {
    await fn();
    return { ok: true, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: null };
  }
}

function dateStr(d) {
  return d.toISOString().slice(0, 10);
}

function lastDays(n) {
  const now = new Date();
  const dates = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    dates.push(dateStr(d));
  }
  return dates;
}

// Zählt die Ergebnisse aller Checks dieser Anfrage in die heutigen
// total/up-Zähler ein. Läuft parallel und wird bewusst NICHT konfigurierte
// (Discord-Webhooks, die es noch nicht gibt) ausgelassen, damit deren
// Verlauf nicht künstlich rot wird.
async function recordUptime(services) {
  const today = dateStr(new Date());
  const calls = [];
  for (const s of services) {
    if (s.configured === false) continue;
    calls.push(incr(`drp_main:uptime:${s.id}:${today}:total`));
    if (s.ok) calls.push(incr(`drp_main:uptime:${s.id}:${today}:up`));
  }
  await Promise.allSettled(calls);
}

async function loadHistory(serviceIds) {
  const dates = lastDays(HISTORY_DAYS);
  const totalKeys = [];
  const upKeys = [];
  for (const id of serviceIds) {
    for (const date of dates) {
      totalKeys.push(`drp_main:uptime:${id}:${date}:total`);
      upKeys.push(`drp_main:uptime:${id}:${date}:up`);
    }
  }
  let totals = [];
  let ups = [];
  try {
    [totals, ups] = await Promise.all([mget(totalKeys), mget(upKeys)]);
  } catch {
    totals = new Array(totalKeys.length).fill(null);
    ups = new Array(upKeys.length).fill(null);
  }
  const history = {};
  let cursor = 0;
  for (const id of serviceIds) {
    const days = [];
    let sumTotal = 0;
    let sumUp = 0;
    for (let i = 0; i < dates.length; i++) {
      const total = Number(totals[cursor]) || 0;
      const up = Number(ups[cursor]) || 0;
      cursor++;
      sumTotal += total;
      sumUp += up;
      days.push({ date: dates[i], percent: total > 0 ? Math.round((up / total) * 1000) / 10 : null });
    }
    history[id] = {
      days,
      uptimePercent: sumTotal > 0 ? Math.round((sumUp / sumTotal) * 1000) / 10 : null,
    };
  }
  return history;
}

// Vorfälle: pro Komponente wird gemerkt, SEIT WANN sie ununterbrochen gestört
// ist (Zeitstempel in KV) - so kann die Status-Seite wie bei klassischen
// Statusseiten "Störung seit X" mit Dauer anzeigen, statt nur einen roten
// Punkt. Erholt sich die Komponente, wird der Zeitstempel gelöscht.
function incidentKey(id) {
  return `drp_main:incident:${id}:start`;
}
async function trackIncident(service) {
  if (service.configured === false) return null; // nicht konfiguriert = kein Vorfall
  const key = incidentKey(service.id);
  if (service.ok) {
    await del(key).catch(() => {});
    return null;
  }
  try {
    const existing = await get(key);
    if (existing) return Number(existing);
    const now = Date.now();
    await set(key, String(now));
    return now;
  } catch {
    return Date.now();
  }
}
function formatDuration(ms) {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `seit ${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  if (hours < 24) return `seit ${hours} Std. ${restMin} Min.`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return `seit ${days} Tag${days === 1 ? '' : 'en'} ${restHours} Std.`;
}

// Test-Störungen: erlauben es angemeldeten Teammitgliedern, für eine
// beliebige Komponente kurzzeitig eine simulierte Störung zu erzwingen -
// nützlich, um die Anzeige (Vorfälle-Karte, Balken, Badges) zu prüfen, ohne
// dass wirklich etwas kaputt sein muss. Wirkt NUR auf die Anzeige dieser
// Status-Seite, keine echte Funktion der Webseite wird dadurch beeinflusst.
function testKey(id) {
  return `drp_main:status_test:${id}`;
}
async function loadActiveTests() {
  try {
    const values = await mget(SERVICE_IDS.map(testKey));
    const active = {};
    SERVICE_IDS.forEach((id, i) => { if (values[i]) active[id] = true; });
    return active;
  } catch {
    return {};
  }
}
async function requireMaster(req, res) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return null;
  }
  const users = await loadUsers();
  const account = users.find((u) => u.id === accountId);
  if (!account || !account.linkedTeamDiscordId) {
    res.status(403).json({ error: 'Nur der Master-Account kann eine Test-Störung auslösen.' });
    return null;
  }
  const roster = await loadTeamRoster();
  const entry = roster.find((r) => r.discordId === account.linkedTeamDiscordId);
  if (!entry || entry.roleId !== 'master') {
    res.status(403).json({ error: 'Nur der Master-Account kann eine Test-Störung auslösen.' });
    return null;
  }
  return account;
}

module.exports = async function handler(req, res) {
  if (req.method === 'POST') {
    try {
      const account = await requireMaster(req, res);
      if (!account) return;
      const { serviceId, minutes } = req.body || {};
      if (serviceId !== 'all' && !SERVICE_IDS.includes(serviceId)) {
        return res.status(400).json({ error: 'Unbekannte Komponente.' });
      }
      const targetIds = serviceId === 'all' ? SERVICE_IDS : [serviceId];
      const mins = Number(minutes);
      if (!mins || mins <= 0) {
        await Promise.all(targetIds.map((id) => del(testKey(id))));
        return res.status(200).json({ ok: true, active: false });
      }
      const clamped = Math.min(Math.max(Math.round(mins), 1), MAX_TEST_MINUTES);
      await Promise.all(targetIds.map((id) => setEx(testKey(id), clamped * 60, String(Date.now()))));
      return res.status(200).json({ ok: true, active: true, minutes: clamped, count: targetIds.length });
    } catch (err) {
      return res.status(500).json({ error: 'Serverfehler: ' + err.message });
    }
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  }
  // Wichtig: dieser Endpunkt antwortet IMMER mit 200 - selbst wenn eine
  // Prüfung intern crasht. Ein 500er hier würde die Status-Seite selbst wie
  // eine Störung aussehen lassen, obwohl evtl. nur ein einzelner Check
  // fehlgeschlagen ist.
  try {
    const [database, discord, partners, reviews, teamRoster, lockdown, visit, users] = await Promise.all([
      timed(() => get(PROBE_KEY)),
      checkDiscordStatus(),
      timed(() => getJSON('drp_main:partners')),
      timed(() => getJSON('drp_main:reviews')),
      timed(() => loadTeamRoster()),
      timed(() => getLockdownState()),
      timed(() => mget(['drp_main:visits:' + dateStr(new Date())])),
      timed(() => loadUsers()),
    ]);
    // Das Anmeldesystem (api/auth/[action].js) hat keine eigene Datenquelle -
    // es liest/schreibt dieselben Konten- und Team-Roster-Daten wie
    // Benutzerverwaltung und Team-Roster-API. Daher kein eigener KV-Aufruf,
    // sondern aus beiden abgeleitet.
    const auth = { ok: users.ok && teamRoster.ok, latencyMs: null };

    const services = [
      { id: 'website', group: 'core', label: 'Webseite', meta: 'Erreichbarkeit der Hauptwebseite', ok: true, latencyMs: null },
      { id: 'database', group: 'core', label: 'Datenbank', meta: 'Speichert Ankündigungen, Bewertungen, Partner, Konten', ...database },
      { id: 'api_partners', group: 'api', label: 'Partner-API', meta: 'Partnerliste laden/verwalten (/api/partners)', ...partners },
      { id: 'api_reviews', group: 'api', label: 'Bewertungs-API', meta: 'Bewertungen abgeben/anzeigen (/api/review)', ...reviews },
      { id: 'api_teamRoster', group: 'api', label: 'Team-Roster-API', meta: 'Teamliste für "Unser Team" (/api/team-roster)', ...teamRoster },
      { id: 'api_lockdown', group: 'api', label: 'Lockdown-API', meta: 'Sperr-Status der Webseite (/api/lockdown)', ...lockdown },
      { id: 'api_visit', group: 'api', label: 'Besucherstatistik-API', meta: 'Besuchszähler (/api/visit)', ...visit },
      { id: 'api_users', group: 'api', label: 'Benutzerverwaltung-API', meta: 'User Liste, Konten verwalten (/api/users)', ...users },
      { id: 'api_auth', group: 'api', label: 'Anmeldesystem-API', meta: 'Registrieren/Login/Logout (/api/auth)', ...auth },
      { id: 'discord_api', group: 'discord', label: 'Discord API (allgemein)', meta: 'Erreichbarkeit der offiziellen Discord-API selbst, unabhängig von unseren Webhooks', ...discord.api },
      { id: 'discord_announcements', group: 'discord', label: 'Discord – Ankündigungen', meta: 'Automatischer Post neuer Ankündigungen', ...discord.announcements },
      { id: 'discord_reviews', group: 'discord', label: 'Discord – Bewertungen', meta: 'Automatischer Post neuer Bewertungen', ...discord.reviews },
      { id: 'discord_partners', group: 'discord', label: 'Discord – Partnerliste', meta: 'Synchronisation der Partnerliste nach Discord', ...discord.partners },
      { id: 'discord_automod', group: 'discord', label: 'Discord – Automod-Log', meta: 'Automod-Meldungen an das Team', ...discord.automod },
    ];

    // Aktive Test-Störungen (per POST vom Master-Account ausgelöst)
    // überschreiben das ECHTE Ergebnis NUR für die Anzeige - die eigentliche
    // Funktion der jeweiligen Komponente läuft normal weiter.
    const activeTests = await loadActiveTests();
    for (const s of services) {
      if (activeTests[s.id]) {
        s.ok = false;
        s.testActive = true;
        s.meta = `${s.meta} · Test-Störung aktiv`;
      }
    }

    // Antwortzeit geht bei jeder Störung (Test ODER echter Ausfall) sofort
    // auf 0 ms - eine "letzte bekannte" Zahl aus der Zeit, als der Dienst
    // noch lief, wäre bei "Gestört" irreführend.
    for (const s of services) {
      if (s.configured !== false && !s.ok) s.latencyMs = 0;
    }

    await recordUptime(services);
    const history = await loadHistory(services.map((s) => s.id));
    for (const s of services) {
      const h = history[s.id] || { days: [], uptimePercent: null };
      s.history = h.days;
      s.uptimePercent = h.uptimePercent;
    }

    // Verfügbarkeits-% geht bei jeder AKTUELL laufenden Störung (Test ODER
    // echter Ausfall) sofort auf 0 - der 30-Tage-Schnitt würde bei einem
    // einzelnen schlechten Check kaum sichtbar sinken. Ist die Komponente
    // wieder ok, greift automatisch wieder der echte 30-Tage-Schnitt, der
    // sich Tag für Tag von selbst erholt, sobald der Störungstag aus dem
    // 30-Tage-Fenster rausfällt bzw. mehr gute Checks dazukommen - dadurch
    // wirkt die Erholung von selbst "langsam ansteigend", ohne eigene
    // Animation.
    for (const s of services) {
      if (s.configured !== false && !s.ok) s.uptimePercent = 0;
    }

    const incidentStarts = await Promise.all(services.map((s) => trackIncident(s)));
    const now = Date.now();
    const incidents = services
      .map((s, i) => ({ s, startedAt: incidentStarts[i] }))
      .filter(({ startedAt }) => startedAt)
      .map(({ s, startedAt }) => ({
        id: s.id,
        title: s.label,
        severity: s.testActive ? 'Test' : (s.group === 'core' ? 'Totalausfall' : 'Teilstörung'),
        isTest: Boolean(s.testActive),
        description: s.testActive
          ? `Simuliert für den Test der Status-Seite - kein echtes Problem, endet automatisch von selbst.`
          : `${s.label} ist aktuell nicht erreichbar. Betroffener Bereich: ${s.meta}`,
        startedAt,
        durationText: formatDuration(now - startedAt),
      }))
      .sort((x, y) => x.startedAt - y.startedAt);

    const relevant = services.filter((s) => s.configured !== false);
    const overallOk = relevant.every((s) => s.ok);

    return res.status(200).json({
      checkedAt: Date.now(),
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      historyDays: HISTORY_DAYS,
      overallOk,
      services,
      incidents,
    });
  } catch (err) {
    return res.status(200).json({
      checkedAt: Date.now(),
      refreshIntervalMs: REFRESH_INTERVAL_MS,
      historyDays: HISTORY_DAYS,
      overallOk: false,
      services: [],
      incidents: [],
    });
  }
};

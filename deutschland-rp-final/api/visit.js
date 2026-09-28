// Einfache, eigene Besucherstatistik – ohne externen Analytics-Dienst.
// Ein "Besuch" wird pro Browser höchstens EINMAL pro Tag gezählt (das
// Frontend merkt sich das selbst in localStorage, siehe index.html), damit
// mehrfaches Neuladen/Seitenwechsel innerhalb der SPA nicht künstlich hohe
// Zahlen erzeugt.
//
// Speicherung: ein eigener Zähler-Key pro Tag (z.B. "drp_main:visits:2026-
// 09-19"), per INCR erhöht. Für die Anzeige (Kalender/Woche/Monat) werden
// die letzten N Tage per MGET auf einmal abgefragt.
const { incr, mget } = require('../lib/_kv');

function dateStr(d) {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const today = dateStr(new Date());
      const count = await incr('drp_main:visits:' + today);
      return res.status(200).json({ ok: true, today, count });
    }

    if (req.method === 'GET') {
      const days = Math.min(Math.max(parseInt(req.query?.days, 10) || 30, 1), 90);
      const now = new Date();
      const dates = [];
      for (let i = days - 1; i >= 0; i--) {
        const d = new Date(now);
        d.setUTCDate(d.getUTCDate() - i);
        dates.push(dateStr(d));
      }
      const keys = dates.map((d) => 'drp_main:visits:' + d);
      const rawCounts = await mget(keys);
      const series = dates.map((date, i) => ({
        date,
        count: Number(rawCounts[i]) || 0,
      }));

      const sum = (arr) => arr.reduce((a, b) => a + b.count, 0);
      const last7 = sum(series.slice(-7));
      const last30 = sum(series.slice(-30));
      const thisMonthPrefix = dateStr(now).slice(0, 7); // YYYY-MM
      const thisMonth = sum(series.filter((s) => s.date.startsWith(thisMonthPrefix)));

      return res.status(200).json({ series, last7, last30, thisMonth });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};

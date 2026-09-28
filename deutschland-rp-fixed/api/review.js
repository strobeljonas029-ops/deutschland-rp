// Bewertungssystem für die Hauptwebseite (Statistik-Seite). Zwei Stufen:
// - Als Gast (nicht angemeldet): NUR eine 1-5 Sterne-Auswahl, kein Name, kein
//   Kommentar.
// - Angemeldet: 1-5 Sterne + "Anonym"-Schalter. Die Kommentar-Funktion ist
//   NUR nutzbar, wenn Anonym AUS ist (sonst würde ein Klartext-Kommentar die
//   angebliche Anonymität sofort wieder aufheben) - ein evtl. trotzdem
//   mitgeschickter Kommentar wird bei Anonym=an serverseitig verworfen.
// Jede neue Bewertung wird zusätzlich per Discord-Webhook in einen Kanal
// gepostet, so bekommt das Team live mit, wenn eine neue Bewertung eingeht.
// Die Discord-Nachricht ist mit der Bewertung synchronisiert: wird ein
// Kommentar zensiert, wird die Nachricht bearbeitet, wird die Bewertung
// entfernt, wird die Nachricht gelöscht (siehe lib/_discord.js).
//
// Wichtig: der Webhook-Link ist ein GEHEIMNIS (jeder, der ihn hat, kann in
// den Kanal posten) und steht deshalb NICHT im Code, sondern nur in der
// Umgebungsvariable DISCORD_WEBHOOK_URL (in den Vercel-Projekteinstellungen
// eintragen: Settings → Environment Variables).
const crypto = require('crypto');
const { getJSON, setJSON } = require('../lib/_kv');
const { getAccountIdFromRequest, loadUsers, loadTeamRoster } = require('../lib/_account');
const { ROLE_TIERS } = require('../lib/_teamRoles');
const { postReviewToDiscord, updateReviewOnDiscord, deleteReviewFromDiscord, postAutomodLog } = require('../lib/_discord');
const { checkText } = require('../lib/_automod');

const KEY = 'drp_main:reviews';
const MAX_STORED = 200; // ältere Bewertungen werden verworfen, Durchschnitt bleibt aber über alle Zeit gültig (siehe unten)
const STATS_KEY = 'drp_main:reviews_stats'; // { count, sum } – für den Durchschnitt über ALLE je abgegebenen Bewertungen, auch nach dem Kappen auf MAX_STORED

async function loadReviews() {
  return (await getJSON(KEY)) || [];
}

async function loadStats() {
  return (await getJSON(STATS_KEY)) || { count: 0, sum: 0 };
}

// Die Discord-Nachrichten-ID ist intern (für die Synchronisierung) und geht
// nicht ans Frontend.
function publicReview(r) {
  const { discordMessageId, ...rest } = r;
  return rest;
}

// Prüft, ob der/die Eingeloggte eine Team-Ebene ab minTier hat (live aus der
// geteilten Teamliste, nicht zwischengespeichert - siehe requireAnnouncement
// Creator in api/announcements.js für dasselbe Muster). minTier=1 lässt
// jede Team-Ebene durch (Niedrigere/Mittlere/Höhere), minTier=3 nur die
// Höhere Ebene.
async function requireTeamRank(req, res, minTier) {
  const accountId = getAccountIdFromRequest(req);
  if (!accountId) {
    res.status(401).json({ error: 'Nicht angemeldet.' });
    return null;
  }
  const users = await loadUsers();
  const account = users.find((u) => u.id === accountId);
  if (!account || !account.linkedTeamDiscordId) {
    res.status(403).json({ error: 'Nur Teammitglieder können das.' });
    return null;
  }
  const roster = await loadTeamRoster();
  const teamEntry = roster.find((r) => r.discordId === account.linkedTeamDiscordId);
  const tier = teamEntry ? ROLE_TIERS[teamEntry.roleId] || 0 : 0;
  if (!tier || tier < minTier) {
    res.status(403).json({ error: 'Dein Team-Rang darf das nicht.' });
    return null;
  }
  return { account, teamEntry, tier };
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const reviews = await loadReviews();
      const stats = await loadStats();
      const average = stats.count > 0 ? stats.sum / stats.count : 0;
      return res.status(200).json({
        items: reviews.slice(0, 50).map(publicReview), // neueste 50 anzeigen
        average: Math.round(average * 10) / 10,
        count: stats.count,
      });
    }

    if (req.method === 'POST') {
      const { rating, anonym, comment } = req.body || {};
      const cleanRating = Number(rating);
      if (!Number.isInteger(cleanRating) || cleanRating < 1 || cleanRating > 5) {
        return res.status(400).json({ error: 'Bitte 1 bis 5 Sterne auswählen.' });
      }

      // Ist jemand angemeldet? Nur dann sind Anonym-Schalter + Kommentar
      // überhaupt relevant - als Gast zählt ausschließlich die Sternezahl.
      const accountId = getAccountIdFromRequest(req);
      let account = null;
      if (accountId) {
        const users = await loadUsers();
        account = users.find((u) => u.id === accountId) || null;
      }

      let cleanName = null; // null = wird als "Gast"/"Anonym" angezeigt
      let cleanComment = '';
      let isAnonym = true;
      if (account) {
        isAnonym = anonym !== false; // Standard: anonym, außer explizit auf false gesetzt
        if (!isAnonym) {
          cleanName = account.name;
          // Kommentar nur erlaubt, wenn NICHT anonym bewertet wird.
          cleanComment = (typeof comment === 'string' ? comment : '').trim().slice(0, 500);
        }
      }

      // Automod: Kommentar auf nicht jugendfreie/beleidigende Inhalte prüfen
      // (siehe lib/_automod.js). Bei eindeutigem Treffer wird die Bewertung
      // abgelehnt (nicht gespeichert, nicht in Discord gepostet) - bei einem
      // unsicheren Treffer wird sie normal gespeichert, aber trotzdem geloggt.
      if (cleanComment) {
        const modResult = checkText(cleanComment);
        if (modResult.verdict !== 'clean') {
          await postAutomodLog({
            area: 'Bewertung - Kommentar',
            verdict: modResult.verdict,
            matched: modResult.matched,
            text: cleanComment,
            actor: cleanName || 'Gast',
          });
          if (modResult.verdict === 'blocked') {
            return res.status(400).json({ error: 'Dein Kommentar enthält nicht erlaubte Inhalte.' });
          }
        }
      }

      const review = {
        id: crypto.randomUUID(),
        name: cleanName,
        guest: !account,
        rating: cleanRating,
        comment: cleanComment,
        createdAt: Date.now(),
      };

      // Erst in Discord posten (liefert die Nachrichten-ID für die spätere
      // Synchronisierung), dann speichern.
      const messageId = await postReviewToDiscord(review);
      if (messageId) review.discordMessageId = messageId;

      const reviews = await loadReviews();
      reviews.unshift(review);
      if (reviews.length > MAX_STORED) reviews.length = MAX_STORED;
      try {
        await setJSON(KEY, reviews);

        const stats = await loadStats();
        stats.count += 1;
        stats.sum += cleanRating;
        await setJSON(STATS_KEY, stats);
      } catch (err) {
        await deleteReviewFromDiscord(review); // nichts in Discord "verwaisen" lassen
        throw err;
      }

      return res.status(200).json({ ok: true, review: publicReview(review) });
    }

    // Kommentar zensieren: jede Team-Ebene darf das, es verschwindet nur der
    // Kommentartext - Sterne/Bewertung bleiben unangetastet erhalten.
    if (req.method === 'PUT') {
      const ctx = await requireTeamRank(req, res, 1);
      if (!ctx) return;
      const { id } = req.body || {};
      const reviews = await loadReviews();
      const idx = reviews.findIndex((r) => r.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Bewertung nicht gefunden.' });
      reviews[idx].comment = '';
      reviews[idx].commentCensored = true;
      reviews[idx].censoredByName = ctx.account.name;
      reviews[idx].censoredAt = Date.now();
      await setJSON(KEY, reviews);
      await updateReviewOnDiscord(reviews[idx]); // Kommentar auch in Discord entfernen
      return res.status(200).json({ ok: true, review: publicReview(reviews[idx]) });
    }

    // Komplette Bewertung entfernen: nur die Höhere Ebene (tier 3) darf das.
    // Der Durchschnitt (STATS_KEY) wird dabei entsprechend nachgezogen.
    if (req.method === 'DELETE') {
      const ctx = await requireTeamRank(req, res, 3);
      if (!ctx) return;
      const { id } = req.body || {};
      const reviews = await loadReviews();
      const idx = reviews.findIndex((r) => r.id === id);
      if (idx === -1) return res.status(404).json({ error: 'Bewertung nicht gefunden.' });
      const [removed] = reviews.splice(idx, 1);
      await setJSON(KEY, reviews);

      const stats = await loadStats();
      stats.count = Math.max(0, stats.count - 1);
      stats.sum = Math.max(0, stats.sum - removed.rating);
      await setJSON(STATS_KEY, stats);
      await deleteReviewFromDiscord(removed); // Nachricht auch in Discord löschen

      return res.status(200).json({ ok: true });
    }

    res.setHeader('Allow', 'GET, POST, PUT, DELETE');
    return res.status(405).json({ error: 'Methode nicht erlaubt.' });
  } catch (err) {
    return res.status(500).json({ error: 'Serverfehler: ' + err.message });
  }
};

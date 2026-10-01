// Automod: einfache, listenbasierte Prüfung von Nutzereingaben auf nicht
// jugendfreie Inhalte und Beleidigungen. Kein KI-Moderationssystem, sondern
// ein Blocklisten-Ansatz mit Normalisierung gegen einfache Umgehungsversuche
// (Leetspeak wie "4rschl0ch", Sonderzeichen/Leerzeichen zwischen Buchstaben
// wie "a r s c h", Groß-/Kleinschreibung).
//
// Zwei Stufen, wie in der Anforderung beschrieben:
//  - "blocked"   Eindeutiger Treffer -> wird abgelehnt (Konto-Name/Kommentar
//                wird verworfen, nicht gespeichert).
//  - "uncertain" Mehrdeutiger/schwächerer Treffer -> wird NICHT blockiert
//                (könnte ein False Positive sein, z.B. ein harmloses Wort,
//                das zufällig eine Teilzeichenkette enthält), aber immer
//                geloggt, damit das Team im Zweifel selbst nachschauen kann.
// "clean" (kein Treffer) wird NICHT geloggt - nur ein tatsächlicher Treffer
// (blocked ODER uncertain) erzeugt einen Log-Eintrag, siehe postAutomodLog
// in lib/_discord.js.
//
// Die Listen sind bewusst nicht erschöpfend (ein vollständiger Schutz vor
// jeder Umgehung ist mit einem Wortlisten-Filter grundsätzlich nicht
// möglich) - sie deckt die gängigsten deutschen und englischen Beleidigungen/
// Vulgärbegriffe ab und kann bei Bedarf einfach erweitert werden.

function normalize(text) {
  let s = String(text || '').toLowerCase();
  // Umlaute/Akzente vereinheitlichen (ä->a, ö->o, ü->u, ß->ss), damit z.B.
  // "Schlämpe" nicht am Umlaut vorbeirutscht.
  s = s
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '');
  // Gängige Leetspeak-Ersetzungen.
  const map = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '€': 'e' };
  s = s.replace(/[013457@$€]/g, (c) => map[c] || c);
  // Alles außer a-z/0-9 entfernen - fängt sowohl "a.r.s.c.h" als auch
  // "arsch loch" (zwei Wörter) als zusammenhängenden Treffer ab.
  s = s.replace(/[^a-z0-9]+/g, '');
  return s;
}

// Harte Liste: eindeutig beleidigend bzw. nicht jugendfrei -> Ablehnung.
const BLOCKED_STEMS = [
  // Deutsch - Vulgär-/Beleidigungsbegriffe
  'arschloch', 'hurensohn', 'wichser', 'fotze', 'schlampe', 'hure', 'fick',
  'missgeburt', 'mistkerl', 'spast', 'spasti', 'mongo', 'behindert',
  'untermensch', 'abschaum', 'schwuchtel',
  // Deutsch - stark diskriminierende/rassistische Begriffe (Auswahl)
  'neger', 'judensau', 'kanake', 'zigeuner',
  // Englisch - gängige Vulgär-/Beleidigungs-/Diskriminierungsbegriffe
  'fuck', 'shit', 'bitch', 'asshole', 'cunt', 'whore', 'slut', 'nigger', 'faggot', 'retard',
];

// Weiche Liste: mehrdeutige/mildere Begriffe -> nicht blockiert, nur geloggt.
const UNCERTAIN_STEMS = [
  'idiot', 'dumm', 'bloed', 'trottel', 'vollidiot', 'opfer',
  'stupid', 'dumbass', 'loser', 'freak',
];

function findStem(normalized, stems) {
  return stems.find((stem) => normalized.includes(stem)) || null;
}

// Prüft einen Eingabetext. Gibt { verdict: 'clean'|'uncertain'|'blocked',
// matched: string|null } zurück.
function checkText(text) {
  if (!text || !String(text).trim()) return { verdict: 'clean', matched: null };
  const normalized = normalize(text);
  if (!normalized) return { verdict: 'clean', matched: null };
  const blockedHit = findStem(normalized, BLOCKED_STEMS);
  if (blockedHit) return { verdict: 'blocked', matched: blockedHit };
  const uncertainHit = findStem(normalized, UNCERTAIN_STEMS);
  if (uncertainHit) return { verdict: 'uncertain', matched: uncertainHit };
  return { verdict: 'clean', matched: null };
}

module.exports = { checkText };

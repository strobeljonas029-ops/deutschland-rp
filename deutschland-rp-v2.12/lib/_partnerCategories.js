// Partner-Kategorien der Hauptwebseite. Reihenfolge = Anzeigereihenfolge
// (Website UND Discord). Die ID ist das, was im Partner-Eintrag gespeichert
// wird ("category"), das Label wird angezeigt.
const PARTNER_CATEGORIES = [
  { id: 'klein', label: 'Klein Partner', color: 0x57f287 },
  { id: 'mittel', label: 'Mittel Partner', color: 0x3498db },
  { id: 'gross', label: 'Groß Partner', color: 0xe67e22 },
  { id: 'sonder', label: 'Sonder Partner', color: 0xeb459e },
];

// Partner, die vor Einführung der Kategorien angelegt wurden, haben kein
// "category"-Feld - sie werden als "Klein Partner" behandelt, bis sie über
// "Bearbeiten" einer anderen Kategorie zugeordnet werden.
const DEFAULT_PARTNER_CATEGORY = 'klein';

function isValidCategory(id) {
  return PARTNER_CATEGORIES.some((c) => c.id === id);
}

function categoryOf(partner) {
  return isValidCategory(partner && partner.category) ? partner.category : DEFAULT_PARTNER_CATEGORY;
}

module.exports = { PARTNER_CATEGORIES, DEFAULT_PARTNER_CATEGORY, isValidCategory, categoryOf };

/* Lesen und Migrieren der Hardfacts-Uebergabe zwischen Modul 1 und Modul 2.

   Hintergrund: Bis Phase 0 schrieb Modul 1
       zielgruppe: strategyTitles
   also die Begruendung des Modells, WARUM die Titel-Winkel funktionieren -
   unter dem Label "Zielgruppe". Modul 2 hat diesen Meta-Text in jeden Prompt
   als Zielgruppendefinition injiziert und zusaetzlich ein zweites Mal als
   "Strategie / Positionierung", weil beide Felder denselben Wert trugen.

   Alte Dateien (JSON-Downloads, sessionStorage) lassen sich daran zweifelsfrei
   erkennen: zielgruppe === strategie_titel. In dem Fall wird `zielgruppe`
   geleert - der Text geht nicht verloren, er steht weiterhin in
   `strategie_titel`, wo er hingehoert. Lieber keine Zielgruppe als eine
   falsche: Modul 2 generiert dann sichtbar ohne Angabe, statt auf eine
   Copywriter-Reflexion hin zu texten. */
var HardfactsIO = (function () {
  'use strict';

  function isLegacyAudience(hf) {
    if (!hf) return false;
    var zg = (hf.zielgruppe || '').trim();
    var st = (hf.strategie_titel || '').trim();
    return !!zg && zg === st;
  }

  /* Liefert { hf, migrated: [...] } - migrated listet, was angepasst wurde,
     damit die UI es anzeigen kann statt still zu korrigieren. */
  function migrate(raw) {
    var hf = Object.assign({}, raw || {});
    var migrated = [];

    if (isLegacyAudience(hf)) {
      hf.zielgruppe = '';
      migrated.push('Die Zielgruppe stammte aus einer aelteren Fassung von Modul 1 und enthielt ' +
        'die Strategie-Begruendung zu den Titeln statt einer Zielgruppe. Sie wurde geleert - ' +
        'bitte unten ergaenzen.');
    }

    /* `offer` war ein zusammengesetzter String `produkt · preis`. Getrennte
       Felder erlauben es, den Preis zu unterdruecken (Hellinger-Regelwerk:
       keine Preise in der Copy). Bei Altdaten wird am mittigen Punkt
       getrennt - konservativ, ohne den Originalstring zu verlieren. */
    if (!hf.angebot && typeof hf.offer === 'string') {
      var parts = hf.offer.split('·').map(function (p) { return p.trim(); }).filter(Boolean);
      hf.angebot = { produkt: parts[0] || '', preis: parts[1] || '' };
    }
    /* " · " aus zwei leeren Feldern ist truthy und hat in Modul 2 jeden
       Fallback ausgehebelt. */
    if (typeof hf.offer === 'string' && !hf.offer.replace(/[·\s]/g, '')) {
      hf.offer = '';
      if (hf.angebot) hf.angebot = { produkt: '', preis: '' };
    }

    if (!Array.isArray(hf.bulletpoints)) hf.bulletpoints = [];
    if (!hf.versions) hf.versions = { schemaVersion: 1 };

    return { hf: hf, migrated: migrated };
  }

  /* Zielgruppe fuer die Prompts. Gibt null zurueck, wenn nichts Belastbares
     vorliegt - der Aufrufer schreibt dann "(keine Angabe)" statt einen
     Ersatzwert zu erfinden. */
  function audience(hf) {
    var zg = (hf && hf.zielgruppe || '').trim();
    return zg || null;
  }

  return { migrate: migrate, isLegacyAudience: isLegacyAudience, audience: audience };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = HardfactsIO;

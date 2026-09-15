/* Liest die maschinenlesbare Konfiguration aus dem Regelwerk der Marke.

   Der Block steht als ```json brand-config im jeweiligen regeln.md - also in
   derselben Datei wie die Regeln, die er abbildet. Bewusst KEINE separate
   Konfigurationsdatei: die waere ein zweiter Wahrheitsort, der beim Aendern
   einer Regel stillschweigend veralten wuerde.

   Was hier herauskommt, ersetzt die frueher im Prompt hartcodierten Werte:
     ctaButton = "Jetzt kostenlos anmelden"
     ctaSubline = "100% kostenfrei am [Termin]"
     announcement ... z.B. "LIVE-Webinar am [Termin]"
     5 Varianten mit je eigenem Winkel: ... Frage-Format ...
   Diese Zeilen standen HINTER dem Preset im Prompt und waren konkreter - sie
   haben die Regelwerke faktisch ueberstimmt. Fuer Hellinger erzeugten sie
   woertliche Verstoesse ("Webinar" ist dort verboten, "kostenlos" ist
   "kostenfrei", Fragen im Seminartitel sind untersagt). */
var BrandConfig = (function () {
  'use strict';

  var FENCE = /```json\s+brand-config\s*\n([\s\S]*?)\n```/;

  /* Neutrale Vorgaben, wenn kein Preset gewaehlt ist. Enthaelt bewusst KEINE
     markenspezifischen Formulierungen - ohne Preset gibt es keine Marke. */
  var GENERIC = {
    anrede: null,
    eventBezeichnung: 'Live-Webinar',
    vorlagen: {
      webinar: {
        name: 'Kostenfreies Webinar',
        offerType: 'lead-event', conversionAction: 'anmeldung',
        priceStatus: 'kostenlos', eventFormat: 'live-seminar',
        ctaText: 'Jetzt kostenfrei anmelden',
        microcopy: '100 % kostenfrei · Am [Datum] um [Uhrzeit]'
      }
    },
    angleKatalog: ['curiosity', 'versprechen', 'zeitgeschehen', 'faktencheck', 'frage'],
    angleVerboten: {},
    verbote: [],
    verboteInFeldern: {}
  };

  /* Klartext-Beschreibungen der Angle-Typen fuer den Prompt. Generisch, nicht
     markenspezifisch - welche davon erlaubt sind, entscheidet der
     angleKatalog des jeweiligen Regelwerks. */
  var ANGLE_LABELS = {
    curiosity: 'Curiosity Gap: eine Luecke oeffnen, die der Leser schliessen will',
    versprechen: 'konkretes Nutzenversprechen',
    zeitgeschehen: 'Bezug zu einer aktuellen gesellschaftlichen oder fachlichen Entwicklung',
    faktencheck: 'Einordnung einer belegten Zahl oder Annahme',
    frage: 'Frage-Format',
    reframe: 'Reframe: einen vertrauten Begriff neu rahmen',
    perspektivwechsel: 'entlastende Perspektivverschiebung, fliessend statt korrigierend',
    muster: 'ein wiederkehrendes Muster benennen, das der Leser bei sich kennt',
    tiefenkontrast: 'Oberflaeche gegen Wurzel, Symptom gegen Ursache'
  };

  /* Prompt-Baustein fuer die Titel-Generierung. Ersetzt die feste Quote
     "5 Varianten mit je eigenem Winkel: Curiosity Gap, Zeitgeschehen,
     Versprechen, Frage-Format, Faktencheck." - die hat bei Hellinger drei im
     Regelwerk verbotene Typen erzwungen. */
  function angleAnweisung(cfg, anzahl) {
    var erlaubt = erlaubteAngles(cfg);
    var verboten = verboteneAngles(cfg);
    var lines = [
      anzahl + ' Varianten. Waehle fuer jede einen Winkel, der zu DIESEM Input passt:',
    ];
    erlaubt.forEach(function (a) {
      lines.push('- ' + (ANGLE_LABELS[a] || a));
    });
    lines.push('Lass Winkel weg, die hier nicht tragen. Zwei starke Varianten mit verwandtem ' +
      'Winkel sind besser als eine erzwungene. Erfinde keinen Aufhaenger, nur um einen Winkel zu bedienen.');
    var vKeys = Object.keys(verboten);
    if (vKeys.length) {
      lines.push('VERBOTEN fuer diese Marke, auch wenn es naheliegt:');
      vKeys.forEach(function (a) {
        lines.push('- ' + (ANGLE_LABELS[a] || a) + ' (' + verboten[a] + ')');
      });
    }
    return lines.join('\n');
  }

  function parse(presetText) {
    if (!presetText) return null;
    var m = FENCE.exec(presetText);
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch (e) {
      /* Laut scheitern statt still auf generische Werte zurueckzufallen: ein
         kaputter Block wuerde sonst dazu fuehren, dass markenfremde CTAs und
         Angle-Typen benutzt werden, ohne dass es jemand merkt. */
      throw new Error('brand-config im Regelwerk ist kein gueltiges JSON: ' + e.message);
    }
  }

  /* Der Konfigurationsblock gehoert nicht in den System-Prompt: er wiederholt
     nur, was im Fliesstext daneben steht, und kostet Tokens. Entfernt wird er
     deterministisch, damit der Cache-Prefix ueber alle Calls identisch bleibt. */
  function stripFromPrompt(presetText) {
    if (!presetText) return presetText;
    return presetText.replace(FENCE, '').replace(/\n{3,}/g, '\n\n');
  }

  function forPreset(presetText) {
    return parse(presetText) || GENERIC;
  }

  /* Die vier Achsen einer Vorlage. Sie sind getrennt, weil sie unabhaengig
     variieren - ein kostenloses Beratungsgespraech kann zu einem
     kostenpflichtigen Angebot fuehren. */
  function vorlage(cfg, key) {
    var v = (cfg && cfg.vorlagen) || {};
    return v[key] || v[Object.keys(v)[0]] || GENERIC.vorlagen.webinar;
  }

  function vorlagenListe(cfg) {
    var v = (cfg && cfg.vorlagen) || {};
    return Object.keys(v).map(function (k) {
      return Object.assign({ key: k }, v[k]);
    });
  }

  /* Angle-Typen, die fuer diese Marke zulaessig sind. Ersetzt die feste Quote
     "Curiosity Gap, Zeitgeschehen, Versprechen, Frage-Format, Faktencheck",
     die bei Hellinger drei verbotene Typen erzwungen hat. */
  function erlaubteAngles(cfg) {
    var verboten = (cfg && cfg.angleVerboten) || {};
    return ((cfg && cfg.angleKatalog) || GENERIC.angleKatalog)
      .filter(function (a) { return !verboten[a]; });
  }

  function verboteneAngles(cfg) {
    return (cfg && cfg.angleVerboten) || {};
  }

  /* Prueft einen Text gegen die Verbotsliste der Marke.
     Liefert [{id, hinweis, quelle, treffer}] - leer heisst sauber. */
  function pruefeText(cfg, text) {
    if (!cfg || !text) return [];
    return (cfg.verbote || []).map(function (v) {
      var re;
      try { re = new RegExp(v.regex, 'gi'); } catch (e) { return null; }
      var hits = String(text).match(re);
      if (!hits) return null;
      /* Doppelte Treffer zusammenfassen - fuenf Gedankenstriche sind ein
         Befund, nicht fuenf. */
      var uniq = hits.filter(function (h, i) { return hits.indexOf(h) === i; });
      return { id: v.id, hinweis: v.hinweis, quelle: v.quelle, treffer: uniq.slice(0, 5) };
    }).filter(Boolean);
  }

  /* Verbote, die nur in bestimmten Feldern gelten - etwa Fragezeichen, die in
     der Bodycopy erwuenscht, im Seminartitel aber untersagt sind. */
  function pruefeFeld(cfg, feldPfad, text) {
    if (!cfg || !text) return [];
    var regeln = cfg.verboteInFeldern || {};
    return Object.keys(regeln).map(function (key) {
      var r = regeln[key];
      if (!(r.felder || []).some(function (f) { return feldPfad === f || feldPfad.indexOf(f + '.') === 0; })) return null;
      var re;
      try { re = new RegExp(r.regex, 'gi'); } catch (e) { return null; }
      if (!re.test(String(text))) return null;
      return { id: key, hinweis: r.hinweis, quelle: r.quelle, feld: feldPfad };
    }).filter(Boolean);
  }

  return {
    GENERIC: GENERIC,
    ANGLE_LABELS: ANGLE_LABELS,
    angleAnweisung: angleAnweisung,
    parse: parse,
    forPreset: forPreset,
    stripFromPrompt: stripFromPrompt,
    vorlage: vorlage,
    vorlagenListe: vorlagenListe,
    erlaubteAngles: erlaubteAngles,
    verboteneAngles: verboteneAngles,
    pruefeText: pruefeText,
    pruefeFeld: pruefeFeld
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = BrandConfig;

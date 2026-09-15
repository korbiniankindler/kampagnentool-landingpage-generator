/* Semantischer Reviewer (1.6).

   Das Quality Gate in shared/validators.js prueft, was sich deterministisch
   pruefen laesst: Vollstaendigkeit, Anzahlen, Faktenerhalt, woertliche
   Redundanz, Verbotsbegriffe per Regex. Es sagt nichts darueber, ob die Copy
   GUT ist - ob sie konkret statt floskelhaft ist, ob die Seite einen Bogen
   baut, ob ein Versprechen im Briefing gedeckt ist. Genau das ist die Groesse,
   um die es dem Tool geht, und sie war bisher unmessbar.

   Bewusste Entwurfsentscheidungen, jeweils gegen die naheliegende Alternative:

   1. EIN Call, EINE Rubrik. Keine Kaskade aus mehreren Richtern. Eine Kaskade
      kostet das Vielfache und liefert vor allem mehr Uneinigkeit, nicht mehr
      Wahrheit.

   2. Der Reviewer bekommt Regelwerk und Wissensdatenbank, aber NICHT die
      Referenz-Copy. Mit der Referenz vor Augen bewertet ein Modell vor allem
      Aehnlichkeit zur Referenz - es entstuende eine Bestaetigungsschleife, in
      der der Generator fuer Nachahmung belohnt wird. Die Referenz steuert die
      Erzeugung, die Regeln bewerten das Ergebnis.

   3. Anderes Modell als der Generator. Ein Modell, das seinen eigenen Text
      bewertet, findet systematisch zu wenig.

   4. NUR Befunde, keine Umschreibung. Der Reviewer darf nichts an der Copy
      aendern, und sein `vorschlag` wird nirgends automatisch uebernommen.
      Ein automatisch angewandter Rewrite waere eine zweite, unkontrollierte
      Generierung ohne Quality Gate dahinter.

   5. Erfundene Testimonials sind ausdruecklich ERLAUBT (Produktentscheidung,
      siehe die Regelwerke der Presets). Ohne diesen expliziten Hinweis meldet jeder
      Reviewer sie zuverlaessig als erfundene Fakten und ueberschwemmt das
      Ergebnis mit Falschbefunden.

   6. Jeder Befund braucht ein woertliches Zitat aus der Copy. `pruefeBelege`
      verwirft anschliessend deterministisch jeden Befund, dessen Zitat sich
      im generierten Text nicht wiederfindet. Das ist die einzige wirksame
      Bremse gegen halluzinierte Befunde - ohne sie ist ein LLM-Reviewer
      nicht auswertbar. */
var Reviewer = (function () {
  'use strict';

  /* Absichtlich ein anderes Modell als ToolVersions.MODEL (Generator). */
  var MODEL = 'claude-opus-5';

  /* Version der Rubrik. Wie PROMPT_VERSION: ohne sie sind zwei Review-Laeufe
     nicht vergleichbar, weil niemand weiss, gegen welche Rubrik gemessen
     wurde. Bei jeder inhaltlichen Aenderung an DIMENSIONEN oder am Prompt
     hochzaehlen. */
  var RUBRIK_VERSION = 1;

  /* Die Rubrik. Jede Dimension misst etwas, das das deterministische Gate
     NICHT sehen kann - sonst gehoerte sie dorthin und nicht hierher. */
  var DIMENSIONEN = [
    {
      key: 'regelkonformitaet',
      name: 'Regelkonformitaet',
      frage: 'Haelt die Copy das Regelwerk der Marke ein - Tonalitaet, Ansprache, Aufbau, ' +
             'verbotene Formulierungen, Umgang mit Versprechen?',
      anker5: 'Kein Verstoss; die Copy klingt, als haette sie jemand geschrieben, der das Regelwerk kennt.',
      anker1: 'Mehrere klare Verstoesse gegen benannte Regeln.'
    },
    {
      key: 'konkretheit',
      name: 'Konkretheit',
      frage: 'Steht in den Saetzen etwas Ueberpruefbares und Spezifisches, oder sind es ' +
             'austauschbare Wendungen, die auf jede beliebige Kampagne passen wuerden?',
      anker5: 'Fast jeder Satz traegt eine konkrete Aussage; die Seite waere fuer ein anderes Angebot nicht wiederverwendbar.',
      anker1: 'Ueberwiegend Floskeln; man koennte den Markennamen austauschen, ohne dass es auffiele.'
    },
    {
      key: 'zielgruppenpassung',
      name: 'Zielgruppenpassung',
      frage: 'Spricht die Copy die im Briefing genannte Zielgruppe in ihrer Sprache und ' +
             'an ihrem Problem an - oder ein allgemeines Publikum?',
      anker5: 'Die Zielgruppe wuerde sich erkennen; Sprachniveau und Problemsicht passen.',
      anker1: 'Die Copy koennte an jede beliebige Zielgruppe gerichtet sein.'
    },
    {
      key: 'versprechen_deckung',
      name: 'Deckung der Versprechen',
      frage: 'Ist jedes Versprechen und jede Sachaussage durch das Briefing, den ' +
             'zusaetzlichen Kontext oder die Wissensdatenbank gedeckt?',
      anker5: 'Jede Sachaussage laesst sich auf eine der Quellen zurueckfuehren.',
      anker1: 'Zentrale Versprechen stehen ohne jede Grundlage in den Quellen.'
    },
    {
      key: 'dramaturgie',
      name: 'Dramaturgie',
      frage: 'Baut die Seite von Section zu Section auf - Problem, Einordnung, Loesung, ' +
             'Beweis, Handlung -, oder beginnt jede Section thematisch von vorn?',
      anker5: 'Erkennbarer Bogen; jede Section setzt voraus, was vorher stand.',
      anker1: 'Jede Section wiederholt den Einstieg; die Reihenfolge waere beliebig.'
    },
    {
      key: 'redundanz',
      name: 'Inhaltliche Redundanz',
      frage: 'Wiederholen verschiedene Sections denselben Gedanken in anderen Worten? ' +
             'Gemeint ist inhaltliche Wiederholung, nicht woertliche.',
      anker5: 'Jede Section traegt einen eigenen Gedanken bei.',
      anker1: 'Mehrere Sections sagen im Kern dasselbe.'
    }
  ];

  var KATEGORIEN = DIMENSIONEN.map(function (d) { return d.key; });

  /* ---------- Copy fuer den Reviewer aufbereiten ---------- */

  /* Die Copy wird als lesbarer Text mit vorangestelltem Feldpfad ausgegeben,
     nicht als JSON. Lesbar, weil eine semantische Bewertung an einer
     JSON-Struktur schlechter gelingt als an Fliesstext; mit Pfad, weil ein
     Befund ohne Fundstelle nicht nachpruefbar ist. */
  function renderCopy(active, sectionData) {
    var teile = [];
    (active || []).forEach(function (s, i) {
      var d = sectionData ? sectionData[s.id] : null;
      teile.push('### ' + (i + 1) + '. ' + s.name + '  (' + s.id + ')');
      if (!d || typeof d !== 'object') { teile.push('(nicht generiert)'); teile.push(''); return; }
      feldZeilen(d, s.id).forEach(function (z) { teile.push(z); });
      teile.push('');
    });
    return teile.join('\n').trim();
  }

  function feldZeilen(wert, pfad, out) {
    out = out || [];
    if (wert == null) return out;
    if (typeof wert === 'string') {
      if (wert.trim()) out.push('[' + pfad + '] ' + wert.trim());
      return out;
    }
    if (Array.isArray(wert)) {
      wert.forEach(function (v, i) { feldZeilen(v, pfad + '.' + i, out); });
      return out;
    }
    if (typeof wert === 'object') {
      Object.keys(wert).forEach(function (k) { feldZeilen(wert[k], pfad ? pfad + '.' + k : k, out); });
    }
    return out;
  }

  /* ---------- Prompt ---------- */

  function rubrikText() {
    return DIMENSIONEN.map(function (d, i) {
      return (i + 1) + '. ' + d.name + ' (' + d.key + ')\n' +
             '   ' + d.frage + '\n' +
             '   5 = ' + d.anker5 + '\n' +
             '   1 = ' + d.anker1;
    }).join('\n\n');
  }

  /* Der Reviewer sieht NUR Regelwerk und Wissensdatenbank - presetText muss
     bereits ohne Referenz-Copy uebergeben werden (siehe reviewDateien).
     Das ist keine Formalie: mit der Referenz im Kontext bewertet er
     Aehnlichkeit statt Qualitaet. */
  function buildSystem(presetText) {
    var anweisung = [
      'Du pruefst eine fertige deutsche Landingpage als kritischer Reviewer.',
      'Du schreibst die Copy NICHT um. Du lieferst ausschliesslich Befunde.',
      '',
      'Was du bekommst: das Regelwerk und die Wissensdatenbank der Marke, das',
      'Kampagnen-Briefing und die fertige Copy. Die Referenz-Copys der Marke',
      'bekommst du bewusst NICHT - bewerte deshalb nie Aehnlichkeit zu einem',
      'Vorbild, sondern immer nur die Copy gegen Regelwerk und Briefing.',
      '',
      'AUSDRUECKLICH ERLAUBT und niemals ein Befund:',
      '- Erfundene Testimonials, Namen und Zitate von Teilnehmern, solange sie',
      '  zum Regelwerk passen. Das ist eine bewusste Produktentscheidung.',
      '- Vom Briefing abweichende Formulierungen, solange die Aussage stimmt.',
      '- Sections, die bewusst nicht gewaehlt wurden. Bewerte nur, was da ist.',
      '',
      'Jeder Befund braucht ein WOERTLICHES Zitat aus der Copy (Feld `zitat`),',
      'zeichengenau kopiert. Befunde ohne auffindbares Zitat werden verworfen.',
      'Lieber fuenf belegte Befunde als zwanzig vermutete.',
      '',
      'KRITISCH: Antworte AUSSCHLIESSLICH mit einem einzigen gueltigen JSON-Objekt.'
    ].join('\n');

    if (!presetText) return [{ type: 'text', text: anweisung }];
    /* Eigener Cache-Block. Byte-identisch zwischen Review-Laeufen, aber
       absichtlich ein ANDERER Block als beim Generator (dort steckt die
       Referenz-Copy mit drin) - ein gemeinsamer Cache-Treffer waere ohnehin
       nicht moeglich. */
    return [
      {
        type: 'text',
        text: 'REGELWERK UND WISSENSDATENBANK DER MARKE (ohne Referenz-Copys) - ' +
              'die Arbeitsanweisungen folgen am Ende des System-Prompts:\n\n' + presetText,
        cache_control: { type: 'ephemeral', ttl: '1h' }
      },
      { type: 'text', text: anweisung }
    ];
  }

  function buildUser(o) {
    o = o || {};
    var hf = o.hf || {};
    var briefing = [
      'Kampagne: ' + (hf.kampagnenname || '(ohne Namen)'),
      'Titel: ' + (hf.titel || '(kein Titel)'),
      hf.beschreibung ? 'Beschreibung: ' + hf.beschreibung : null,
      'Zielgruppe: ' + (o.zielgruppe || '(keine Angabe)'),
      hf.offer ? 'Angebot: ' + hf.offer : null,
      o.strategie ? 'Strategie: ' + o.strategie : null
    ].filter(Boolean).join('\n');

    var teile = ['KAMPAGNEN-BRIEFING', briefing, ''];
    if (o.ctxBlock) { teile.push('ZUSAETZLICHER KONTEXT', String(o.ctxBlock).trim(), ''); }
    teile.push(
      'AUFBAU DER SEITE',
      o.pageMap || '(nicht angegeben)',
      '',
      'DIE ZU PRUEFENDE COPY',
      '(Der Ausdruck in eckigen Klammern vor jeder Zeile ist der Feldpfad. Gib ihn',
      'bei einem Befund unter `feld` unveraendert an.)',
      '',
      o.copy || '(keine Copy)',
      '',
      'BEWERTUNGSRUBRIK',
      rubrikText(),
      '',
      'Bewerte jede Dimension mit 1-5 und begruende in einem Satz.',
      'Nenne anschliessend die konkreten Befunde, die zu den Abzuegen gefuehrt haben.',
      'Schwere "kritisch" nur, wenn die Stelle so nicht veroeffentlicht werden',
      'sollte; alles andere ist "hinweis".',
      'Gib maximal 12 Befunde an, die wichtigsten zuerst.',
      '',
      'Antworte NUR mit diesem JSON-Objekt:',
      '{',
      '  "bewertung": { ' + KATEGORIEN.map(function (k) {
        return '"' + k + '": { "punkte": 1-5, "begruendung": "..." }';
      }).join(', ') + ' },',
      '  "befunde": [',
      '    { "section": "<section-id>", "feld": "<feldpfad>", "kategorie": "<' +
        KATEGORIEN.join('|') + '>",',
      '      "schwere": "kritisch|hinweis", "zitat": "<woertlich aus der Copy>",',
      '      "problem": "<ein Satz>", "vorschlag": "<ein Satz, wird NICHT automatisch uebernommen>" }',
      '  ],',
      '  "gesamturteil": "<zwei bis drei Saetze>"',
      '}'
    );
    return teile.join('\n');
  }

  /* Structured Output. Bewusst ohne Array- und String-Constraints: die API
     unterstuetzt sie in json_schema nicht (siehe tests/structured-outputs.test.js).
     `additionalProperties: false` ist dagegen an JEDEM Objekt Pflicht. */
  function jsonSchema() {
    var bewertung = { type: 'object', properties: {}, required: [], additionalProperties: false };
    KATEGORIEN.forEach(function (k) {
      bewertung.properties[k] = {
        type: 'object',
        properties: {
          punkte: { type: 'integer', description: '1 bis 5' },
          begruendung: { type: 'string' }
        },
        required: ['punkte', 'begruendung'],
        additionalProperties: false
      };
      bewertung.required.push(k);
    });
    return {
      type: 'object',
      properties: {
        bewertung: bewertung,
        befunde: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              section: { type: 'string' },
              feld: { type: 'string' },
              kategorie: { type: 'string', enum: KATEGORIEN },
              schwere: { type: 'string', enum: ['kritisch', 'hinweis'] },
              zitat: { type: 'string' },
              problem: { type: 'string' },
              vorschlag: { type: 'string' }
            },
            required: ['section', 'feld', 'kategorie', 'schwere', 'zitat', 'problem', 'vorschlag'],
            additionalProperties: false
          }
        },
        gesamturteil: { type: 'string' }
      },
      required: ['bewertung', 'befunde', 'gesamturteil'],
      additionalProperties: false
    };
  }

  function outputConfig() {
    return { format: { type: 'json_schema', schema: jsonSchema() } };
  }

  /* ---------- Belegpruefung ---------- */

  /* Normalisierung fuer den Zitatvergleich. Bewusst grosszuegiger als
     Validators.norm: Anfuehrungszeichen, Bindestriche und Leerraum darf der
     Reviewer beim Abtippen verlieren. Umlaute werden NICHT ersetzt: wer sie
     umschreibt, hat nicht woertlich zitiert. */
  function normZitat(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[‘’‚“”„'"`´]/g, '')
      .replace(/[–—-]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* Verwirft Befunde, deren Zitat in der Copy nicht vorkommt. Das ist die
     wichtigste Funktion dieser Datei: ohne sie laesst sich nicht
     unterscheiden, ob der Reviewer eine Stelle gefunden oder erfunden hat.
     Verworfene Befunde werden nicht still geloescht, sondern zurueckgegeben -
     eine hohe Quote ist selbst ein Befund ueber den Reviewer. */
  function pruefeBelege(befunde, sectionData) {
    var alleTexte = feldZeilen(sectionData || {}, '').map(function (z) {
      return normZitat(z.replace(/^\[[^\]]*\]\s*/, ''));
    });
    var behalten = [], verworfen = [];
    (befunde || []).forEach(function (b) {
      var z = normZitat(b && b.zitat);
      /* Sehr kurze Zitate sind nicht aussagekraeftig: "Du" findet sich immer.
         Sie gelten als unbelegt, damit ein Reviewer sich nicht durch
         Einwort-Zitate an der Pruefung vorbeimogeln kann. */
      if (z.length < 12) { verworfen.push(Object.assign({}, b, { grund: 'zitat-zu-kurz' })); return; }
      /* Jedes Feld EINZELN pruefen, nicht den zusammengefuegten Text. Sonst
         gaelte ein Zitat, das ueber eine Feldgrenze hinweglaeuft, als
         gefunden - obwohl dieser Satz so auf keiner Seite steht. Ein
         Trennzeichen als Schutz reicht nicht, es kann im Zitat selbst
         stehen. */
      var belegt = alleTexte.some(function (t) { return t.indexOf(z) !== -1; });
      if (!belegt) { verworfen.push(Object.assign({}, b, { grund: 'zitat-nicht-gefunden' })); return; }
      behalten.push(b);
    });
    return { befunde: behalten, verworfen: verworfen };
  }

  /* ---------- Auswertung ---------- */

  function punkte(ergebnis) {
    var b = (ergebnis && ergebnis.bewertung) || {};
    var werte = [];
    var out = {};
    KATEGORIEN.forEach(function (k) {
      var p = b[k] && b[k].punkte;
      var gueltig = (typeof p === 'number' && p >= 1 && p <= 5);
      out[k] = gueltig ? p : null;
      if (gueltig) werte.push(p);
    });
    if (!werte.length) return { schnitt: null, werte: out };
    return {
      schnitt: Math.round((werte.reduce(function (a, c) { return a + c; }, 0) / werte.length) * 100) / 100,
      werte: out
    };
  }

  /* Baut den kompletten Request. Das Absenden bleibt beim Aufrufer - im
     Browser laeuft es ueber ClaudeAPI, im Runner ebenfalls, aber mit
     anderer Fehlerbehandlung. */
  function buildRequest(o) {
    o = o || {};
    return {
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: 'disabled' },
      system: buildSystem(o.presetText),
      messages: [{ role: 'user', content: buildUser(o) }]
    };
  }

  /* Preset-Dateien fuer den Reviewer: Regelwerk und Wissensdatenbank, aber
     ohne die Referenz-Copy, die der Generator bekommen hat. Der Aufrufer
     laedt die Dateien; hier steht nur, WELCHE. */
  function reviewDateien(preset) {
    return (preset && preset.files) ? preset.files.slice() : [];
  }

  return {
    MODEL: MODEL,
    RUBRIK_VERSION: RUBRIK_VERSION,
    DIMENSIONEN: DIMENSIONEN,
    KATEGORIEN: KATEGORIEN,
    renderCopy: renderCopy,
    rubrikText: rubrikText,
    buildSystem: buildSystem,
    buildUser: buildUser,
    buildRequest: buildRequest,
    jsonSchema: jsonSchema,
    outputConfig: outputConfig,
    pruefeBelege: pruefeBelege,
    punkte: punkte,
    reviewDateien: reviewDateien,
    _normZitat: normZitat
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Reviewer;

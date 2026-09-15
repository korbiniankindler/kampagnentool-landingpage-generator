/* Dokument-Digest (1.3).

   Bisher haengen hochgeladene PDFs als document-Bloecke an JEDEM Request:
   Content-Plan, drei bis vier Chunks, dazu jede Regenerierung. Zwanzig Seiten
   sind grob 40.000 Input-Tokens - selbst mit Cache-Treffer bei jedem Request
   erneut, und bei jeder Regenerierung neu. Vor allem aber muss das Modell die
   relevanten Stellen in zwanzig Seiten SUCHEN, waehrend es gleichzeitig Copy
   schreibt. Das sind zwei Aufgaben in einem Call, und die schlechtere davon
   verdraengt die bessere.

   Der Digest trennt beides: EIN Extraktions-Call liest die Dokumente und
   liefert Fakten mit woertlichem Beleg und Seitenangabe. Die Generierung
   bekommt danach nur noch diesen kompakten Block.

   Abgrenzung zu einem Claim-/Citation-System: Das hier ist ausdruecklich
   KEINES. Die fertige Copy traegt keine Quellenangaben, und niemand muss
   Belege pflegen. Die Zitate dienen einzig dazu, den Digest selbst
   nachpruefbar zu machen - sie erscheinen nie auf der Landingpage.

   Rangfolge der Quellen, uebernommen aus den Regelwerken beider Marken
   (presets/hellinger/regeln.md, Konfliktregeln; presets/holistic-house/regeln.md,
   Vorrangregel):

       bestaetigte Hardfacts  >  hochgeladenes Dokument
                              >  Wissensdatenbank  >  Referenz-Copy

   Die bestaetigten Hardfacts sind der vom Menschen abgenommene Teil des
   Briefings. Ein Dokument darf sie ERGAENZEN, niemals ueberschreiben. Deshalb
   werden Widersprueche nicht still aufgeloest, sondern ausgewiesen - im
   Prompt wie in der Oberflaeche.

   EHRLICHE GRENZE: Anders als beim Reviewer (shared/reviewer.js) laesst sich
   ein Zitat hier NICHT deterministisch gegen die Quelle pruefen. Das Tool
   liest PDFs nicht selbst - es reicht sie an die API weiter. Ein erfundenes
   Zitat faellt also nur einem Menschen auf. Genau deshalb wird der Digest in
   der Oberflaeche angezeigt, statt im Hintergrund zu verschwinden. */
var Digest = (function () {
  'use strict';

  /* Version des Digest-Prompts. Wie PROMPT_VERSION: ohne sie ist nicht
     zuzuordnen, gegen welche Fassung ein Ergebnis entstanden ist. */
  var DIGEST_VERSION = 1;

  /* Kategorien, in die ein Fakt faellt. Sie bestimmen, wie der Fakt im
     Prompt einsortiert wird - und sie machen sichtbar, wenn ein Dokument nur
     Fuellmaterial liefert. */
  var KATEGORIEN = ['termin', 'referent', 'inhalt', 'zielgruppe', 'angebot', 'beleg', 'sonstiges'];

  /* Felder der Hardfacts, bei denen ein Widerspruch zum Dokument teuer ist:
     sie landen in Anzeigen, Kalendereinladungen und Bestaetigungsmails.
     `art` steuert, WIE verglichen wird - ein Datum laesst sich exakt pruefen,
     ein Titel nur ueber Wortueberdeckung. */
  var KONFLIKT_FELDER = [
    { key: 'titel', label: 'Titel', art: 'text' },
    { key: 'live_termin', label: 'Termin', art: 'datum' },
    { key: 'kampagnenname', label: 'Kampagnenname', art: 'text' },
    { key: 'pre_headline', label: 'Pre-Headline', art: 'text' },
    { key: 'sub_headline', label: 'Sub-Headline', art: 'text' }
  ];

  var MONATE = {
    januar: 1, jaenner: 1, februar: 2, maerz: 3, marz: 3, april: 4, mai: 5, juni: 6,
    juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12
  };

  /* Deutsches Datum in (Tag, Monat, Jahr), egal ob "20.09.2026",
     "20. September 2026" oder "20.9.26". Nicht eindeutig => null, und dann
     wird NICHT verglichen. Ein falsch geratener Konflikt ist schlimmer als
     ein nicht erkannter: er kostet Vertrauen in jede weitere Meldung. */
  function datumsTeile(s) {
    var t = String(s == null ? '' : s).toLowerCase()
      .replace(/\u00e4/g, 'ae').replace(/\u00f6/g, 'oe').replace(/\u00fc/g, 'ue');
    var m = t.match(/(\d{1,2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{2,4})/);
    if (m) return kanonisch(m[1], m[2], m[3]);
    var namen = Object.keys(MONATE).join('|');
    m = t.match(new RegExp('(\\d{1,2})\\s*\\.?\\s*(' + namen + ')\\s*(\\d{4})?'));
    if (m) return kanonisch(m[1], MONATE[m[2]], m[3]);
    return null;
  }

  function kanonisch(tag, monat, jahr) {
    var t = parseInt(tag, 10), mo = parseInt(monat, 10);
    var j = jahr ? parseInt(jahr, 10) : null;
    if (!(t >= 1 && t <= 31) || !(mo >= 1 && mo <= 12)) return null;
    if (j !== null && j < 100) j += 2000;
    return { tag: t, monat: mo, jahr: j };
  }

  /* Zwei Daten sind verschieden, wenn Tag oder Monat abweichen. Fehlt auf
     einer Seite das Jahr, wird es nicht verglichen - "20. September" ohne
     Jahreszahl widerspricht "20.09.2026" nicht. */
  function datumWeichtAb(a, b) {
    if (!a || !b) return false;
    if (a.tag !== b.tag || a.monat !== b.monat) return true;
    return (a.jahr !== null && b.jahr !== null && a.jahr !== b.jahr);
  }

  /* ---------- Prompt ---------- */

  function buildSystem() {
    return [
      'Du liest angehaengte Kampagnen-Dokumente und ziehst daraus die Fakten,',
      'die fuer das Schreiben einer Landingpage gebraucht werden.',
      '',
      'Du schreibst KEINE Copy. Du formulierst nicht um, du wertest nicht,',
      'du ergaenzt nichts aus eigenem Wissen. Steht etwas nicht im Dokument,',
      'kommt es nicht in den Digest.',
      '',
      'Zu JEDEM Fakt gehoeren:',
      '- `aussage`: der Fakt in einem knappen Satz, in Deinen Worten',
      '- `zitat`: die Stelle im Dokument, WOERTLICH und zeichengenau',
      '- `seite`: die Seitenzahl, auf der das Zitat steht',
      'Findest Du keine woertliche Belegstelle, lass den Fakt weg.',
      '',
      'WIDERSPRUECHE: Du bekommst die bereits bestaetigten Kampagnen-Daten.',
      'Widerspricht das Dokument ihnen, loese das NICHT auf - melde es unter',
      '`konflikte`. Die bestaetigten Daten gelten; das Dokument ergaenzt sie.',
      '',
      'KRITISCH: Antworte AUSSCHLIESSLICH mit einem einzigen gueltigen JSON-Objekt.'
    ].join('\n');
  }

  function buildUser(o) {
    o = o || {};
    var hf = o.hf || {};
    var bestaetigt = KONFLIKT_FELDER
      .map(function (f) { return hf[f.key] ? f.label + ': ' + hf[f.key] : null; })
      .filter(Boolean);
    if (o.zielgruppe) bestaetigt.push('Zielgruppe: ' + o.zielgruppe);

    return [
      'BEREITS BESTAETIGTE KAMPAGNEN-DATEN',
      '(Diese gelten. Das Dokument kann sie ergaenzen, nicht ersetzen.)',
      bestaetigt.length ? bestaetigt.join('\n') : '(noch nichts bestaetigt)',
      '',
      o.dateien && o.dateien.length
        ? 'ANGEHAENGTE DOKUMENTE\n' + o.dateien.map(function (n, i) { return (i + 1) + '. ' + n; }).join('\n')
        : 'ANGEHAENGTE DOKUMENTE\n(keine)',
      '',
      'Ziehe aus den angehaengten Dokumenten alles heraus, was fuer eine',
      'Landingpage zu dieser Kampagne verwendbar ist: Termine, Personen und',
      'ihre Rolle, Inhalte und Ablauf, Zielgruppe, Angebot, sowie belegbare',
      'Zahlen, Studien und Zitate.',
      '',
      'Lass weg: Formalien, Impressum, Seitenzahlen, Inhaltsverzeichnisse,',
      'Wiederholungen. Hoechstens 25 Fakten - die tragenden zuerst.',
      '',
      'Antworte NUR mit diesem JSON-Objekt:',
      '{',
      '  "kernaussagen": ["<worum es im Dokument geht, 2-4 Saetze als Liste>"],',
      '  "fakten": [',
      '    { "aussage": "<ein Satz>", "zitat": "<woertlich aus dem Dokument>",',
      '      "seite": <Seitenzahl als Zahl>, "kategorie": "<' + KATEGORIEN.join('|') + '>" }',
      '  ],',
      '  "konflikte": [',
      '    { "feld": "<Titel|Termin|...>", "briefing": "<bestaetigter Wert>",',
      '      "dokument": "<was im Dokument steht>", "zitat": "<woertlich>", "seite": <Zahl> }',
      '  ]',
      '}'
    ].join('\n');
  }

  function jsonSchema() {
    return {
      type: 'object',
      properties: {
        kernaussagen: { type: 'array', items: { type: 'string' } },
        fakten: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              aussage: { type: 'string' },
              zitat: { type: 'string' },
              seite: { type: 'integer' },
              kategorie: { type: 'string', enum: KATEGORIEN }
            },
            required: ['aussage', 'zitat', 'seite', 'kategorie'],
            additionalProperties: false
          }
        },
        konflikte: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              feld: { type: 'string' },
              briefing: { type: 'string' },
              dokument: { type: 'string' },
              zitat: { type: 'string' },
              seite: { type: 'integer' }
            },
            required: ['feld', 'briefing', 'dokument', 'zitat', 'seite'],
            additionalProperties: false
          }
        }
      },
      required: ['kernaussagen', 'fakten', 'konflikte'],
      additionalProperties: false
    };
  }

  function outputConfig() {
    return { format: { type: 'json_schema', schema: jsonSchema() } };
  }

  /* Der Request. `content` baut der Aufrufer, weil nur er die
     document-Bloecke hat (Browser: base64 aus dem Upload). */
  function buildRequest(o, model) {
    o = o || {};
    return {
      model: model,
      max_tokens: 4000,
      thinking: { type: 'disabled' },
      system: buildSystem(),
      messages: [{ role: 'user', content: o.content || buildUser(o) }]
    };
  }

  /* ---------- Pruefung ---------- */

  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /* Deterministische Pruefung des Digests. Sie kann die Zitate NICHT gegen
     das PDF pruefen (siehe Kopf dieser Datei) - sie prueft, was ohne die
     Quelle pruefbar ist: Struktur, plausible Seitenzahlen und ob das Modell
     einen Widerspruch verschwiegen hat, den ein Stringvergleich sieht.

     `seitenGesamt` ist die Summe der Seiten aller Dokumente, soweit bekannt
     (countPdfPages im Browser liefert bei komprimierten PDFs null - dann
     entfaellt die Pruefung, statt falsch Alarm zu schlagen). */
  function pruefe(digest, opts) {
    opts = opts || {};
    var befunde = [];
    var d = digest || {};
    var fakten = Array.isArray(d.fakten) ? d.fakten : [];

    if (!fakten.length) {
      befunde.push({ schwere: 'kritisch', id: 'digest-leer',
        text: 'Aus den Dokumenten wurde kein einziger Fakt gewonnen. Entweder enthalten sie ' +
              'nichts Verwertbares, oder die Extraktion ist fehlgeschlagen.' });
    }

    fakten.forEach(function (f, i) {
      var pfad = 'fakten.' + i;
      if (!f || !norm(f.aussage)) {
        befunde.push({ schwere: 'kritisch', id: 'fakt-leer', feld: pfad,
          text: 'Fakt ohne Aussage.' });
        return;
      }
      /* Ein Fakt ohne Beleg ist nicht von einer Erfindung zu unterscheiden.
         Kurze Zitate ("ja", "2026") belegen nichts. */
      if (norm(f.zitat).length < 12) {
        befunde.push({ schwere: 'kritisch', id: 'fakt-ohne-beleg', feld: pfad,
          text: 'Ohne woertliches Zitat nicht nachpruefbar: "' + f.aussage + '"' });
      }
      if (opts.seitenGesamt && (!(f.seite > 0) || f.seite > opts.seitenGesamt)) {
        befunde.push({ schwere: 'hinweis', id: 'seite-unplausibel', feld: pfad,
          text: 'Seite ' + f.seite + ' liegt ausserhalb der ' + opts.seitenGesamt +
                ' hochgeladenen Seiten - die Fundstelle stimmt nicht.' });
      }
      if (f.kategorie && KATEGORIEN.indexOf(f.kategorie) === -1) {
        befunde.push({ schwere: 'hinweis', id: 'kategorie-unbekannt', feld: pfad,
          text: 'Unbekannte Kategorie "' + f.kategorie + '".' });
      }
    });

    /* Gegenprobe zu den gemeldeten Konflikten: Nennt ein Fakt einen
       bestaetigten Wert WOERTLICH anders, ohne dass das Modell es unter
       `konflikte` gemeldet hat, ist das genau der Fall, der still in die Copy
       laufen wuerde. Nur exakte Feldwerte werden verglichen - eine
       Datumslogik gehoert nicht hierher, die erkennt das Modell besser. */
    var gemeldet = {};
    (Array.isArray(d.konflikte) ? d.konflikte : []).forEach(function (k) {
      if (k && k.feld) gemeldet[norm(k.feld)] = true;
    });
    var hf = opts.hf || {};
    KONFLIKT_FELDER.forEach(function (feld) {
      var wert = hf[feld.key];
      if (!norm(wert)) return;
      if (gemeldet[norm(feld.label)]) return;

      if (feld.art === 'datum') {
        /* Der teuerste Fehler des ganzen Systems: ein falsches Datum steht
           danach in Anzeigen, Kalendereinladungen und Bestaetigungsmails.
           Deshalb hier ein exakter Vergleich statt einer Wortueberdeckung -
           und deshalb `kritisch` statt `hinweis`. */
        var soll = datumsTeile(wert);
        if (!soll) return;
        fakten.forEach(function (f, i) {
          if (!f || f.kategorie !== 'termin') return;
          var ist = datumsTeile(norm(f.aussage) + ' ' + norm(f.zitat));
          if (datumWeichtAb(soll, ist)) {
            befunde.push({ schwere: 'kritisch', id: 'termin-konflikt', feld: 'fakten.' + i,
              text: 'Der Termin im Briefing lautet "' + wert + '", das Dokument nennt einen ' +
                    'anderen: "' + f.aussage + '". Verbindlich ist das Briefing - bitte klaeren, ' +
                    'welcher Termin stimmt.' });
          }
        });
        return;
      }

      /* Textfelder: Wortueberdeckung. Fast vollstaendige Uebereinstimmung
         heisst derselbe Wert, gar keine heisst anderes Thema - beides
         unauffaellig. Dazwischen liegt der verdaechtige Bereich: dieselbe
         Sache, andere Angabe. */
      var tokens = norm(wert).replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/)
        .filter(function (w) { return w.length > 3; });
      if (tokens.length < 2) return;
      fakten.forEach(function (f, i) {
        var text = norm(f && f.aussage) + ' ' + norm(f && f.zitat);
        if (!text.trim()) return;
        var anteil = tokens.filter(function (w) { return text.indexOf(w) !== -1; }).length / tokens.length;
        if (anteil > 0.4 && anteil < 0.95) {
          befunde.push({ schwere: 'hinweis', id: 'moeglicher-konflikt', feld: 'fakten.' + i,
            text: feld.label + ' im Briefing lautet "' + wert + '". Der Fakt "' +
                  f.aussage + '" weicht davon ab, wurde aber nicht als Konflikt gemeldet. Bitte pruefen.' });
        }
      });
    });

    return befunde;
  }

  /* ---------- Prompt-Block fuer die Generierung ---------- */

  /* Was die Generierung tatsaechlich zu sehen bekommt. Kompakt, nach
     Kategorie gruppiert, OHNE die Zitate: die dienen der Pruefung des
     Digests, nicht dem Schreiben - im Generierungsprompt waeren sie nur
     Ballast und eine Einladung, sie in die Copy zu uebernehmen.

     Konflikte stehen mit der Aufloesung dabei, nicht als offene Frage. Ein
     Modell, das zwei widersprechende Termine sieht und keine Regel dazu,
     waehlt einen davon - mit 50 Prozent den falschen. */
  function renderForPrompt(digest, hf, befunde) {
    var d = digest || {};
    var fakten = Array.isArray(d.fakten) ? d.fakten : [];
    if (!fakten.length && !(d.kernaussagen || []).length) return '';

    /* Konflikte kommen aus ZWEI Quellen: gemeldet vom Modell (`konflikte`)
       und deterministisch gefunden (pruefe). Die zweite Quelle darf hier
       nicht fehlen. Sonst steht ein Fakt wie "Das Seminar findet am
       27.10.2026 statt" unkommentiert im Prompt, obwohl das Tool genau
       diesen Widerspruch erkannt und dem Menschen angezeigt hat - und das
       Modell nimmt dann mit guter Wahrscheinlichkeit das falsche Datum. */
    var markiert = {};
    var zusaetzlich = [];
    (befunde || []).forEach(function (b) {
      if (!b || (b.id !== 'termin-konflikt' && b.id !== 'moeglicher-konflikt')) return;
      var m = /^fakten\.(\d+)$/.exec(b.feld || '');
      if (m) markiert[parseInt(m[1], 10)] = true;
      zusaetzlich.push(b);
    });

    var teile = ['Aus den hochgeladenen Kampagnen-Dokumenten extrahiert:'];

    var kern = (d.kernaussagen || []).filter(Boolean);
    if (kern.length) teile.push('Worum es geht: ' + kern.join(' '));

    function zeile(f, i) {
      return '- ' + f.aussage + (markiert[i]
        ? '  [ACHTUNG: weicht vom verbindlichen Briefing ab - NICHT verwenden]' : '');
    }
    function liste(auswahl) {
      return auswahl.map(function (e) { return zeile(e.f, e.i); }).join('\n');
    }
    var indiziert = fakten.map(function (f, i) { return { f: f, i: i }; });

    KATEGORIEN.forEach(function (kat) {
      var passend = indiziert.filter(function (e) { return e.f && e.f.kategorie === kat; });
      if (!passend.length) return;
      teile.push(kat.charAt(0).toUpperCase() + kat.slice(1) + ':\n' + liste(passend));
    });
    var ohne = indiziert.filter(function (e) { return e.f && KATEGORIEN.indexOf(e.f.kategorie) === -1; });
    if (ohne.length) teile.push('Weitere Angaben:\n' + liste(ohne));

    var zeilen = (Array.isArray(d.konflikte) ? d.konflikte : [])
      .filter(function (k) { return k && k.feld; })
      .map(function (k) {
        return '- ' + k.feld + ': verbindlich "' + k.briefing + '" (im Dokument steht "' + k.dokument + '" - NICHT verwenden)';
      });
    var h = hf || {};
    zusaetzlich.forEach(function (b) {
      var feld = b.id === 'termin-konflikt' ? 'Termin' : 'Angabe';
      var soll = b.id === 'termin-konflikt' ? h.live_termin : null;
      zeilen.push('- ' + feld + (soll ? ': verbindlich "' + soll + '"' : '') +
        ' - eine Angabe im Dokument weicht davon ab und darf nicht uebernommen werden.');
    });
    if (zeilen.length) {
      teile.push('WICHTIG - das Dokument widerspricht dem bestaetigten Briefing. ' +
        'Verbindlich ist immer das Briefing:\n' + zeilen.join('\n'));
    }

    teile.push('Diese Angaben sind belegt und duerfen verwendet werden. Was hier nicht ' +
      'steht, stand nicht im Dokument - erfinde nichts dazu.');
    return teile.join('\n\n') + '\n';
  }

  /* Kurzfassung fuer die Oberflaeche: wie viel wurde gewonnen, und woran
     sollte ein Mensch draufschauen. */
  function zusammenfassung(digest, befunde) {
    var d = digest || {};
    var fakten = Array.isArray(d.fakten) ? d.fakten : [];
    var proKategorie = {};
    fakten.forEach(function (f) {
      var k = (f && f.kategorie) || 'sonstiges';
      proKategorie[k] = (proKategorie[k] || 0) + 1;
    });
    return {
      fakten: fakten.length,
      konflikte: (Array.isArray(d.konflikte) ? d.konflikte : []).length,
      proKategorie: proKategorie,
      kritisch: (befunde || []).filter(function (b) { return b.schwere === 'kritisch'; }).length,
      hinweise: (befunde || []).filter(function (b) { return b.schwere !== 'kritisch'; }).length
    };
  }

  return {
    DIGEST_VERSION: DIGEST_VERSION,
    KATEGORIEN: KATEGORIEN,
    KONFLIKT_FELDER: KONFLIKT_FELDER,
    buildSystem: buildSystem,
    buildUser: buildUser,
    buildRequest: buildRequest,
    jsonSchema: jsonSchema,
    outputConfig: outputConfig,
    pruefe: pruefe,
    datumsTeile: datumsTeile,
    renderForPrompt: renderForPrompt,
    zusammenfassung: zusammenfassung
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Digest;

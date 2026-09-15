/* Absicherung von shared/digest.js.

   Der Digest ersetzt die PDFs in den Generierungs-Prompts. Das ist ein
   Tausch: weniger Tokens und ein sauber getrennter Leseschritt gegen das
   Risiko, dass etwas Wichtiges nicht im Digest landet. Die Tests halten die
   Stellen fest, an denen dieser Tausch schieflaufen wuerde.

   Die teuerste davon ist der Termin-Konflikt: Ein falsches Datum steht
   danach in Anzeigen, Kalendereinladungen und Bestaetigungsmails. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const D = require('../shared/digest.js');

const HF = {
  titel: 'Der Platz, der wirklich zu Dir gehoert',
  live_termin: '20.09.2026, 11 Uhr',
  kampagnenname: 'Alte Muster loesen - September 2026'
};

function digest(fakten, konflikte, kern) {
  return { kernaussagen: kern || ['Ein Live-Seminar.'], fakten: fakten || [], konflikte: konflikte || [] };
}
function fakt(extra) {
  return Object.assign({
    aussage: 'Sophie Hellinger leitet das Seminar.',
    zitat: 'Leitung: Sophie Hellinger, Gruenderin der Hellingerschule',
    seite: 1, kategorie: 'referent'
  }, extra || {});
}
function ids(befunde) { return befunde.map(b => b.id).sort(); }

/* ---------- Datumserkennung ---------- */

test('Deutsche Datumsformate werden auf dieselbe Form gebracht', () => {
  const soll = { tag: 20, monat: 9, jahr: 2026 };
  ['20.09.2026', '20. September 2026', '20.9.26', '20.9.2026',
   'Termin: 20. September 2026, 11:00 Uhr'].forEach((s) => {
    assert.deepEqual(D.datumsTeile(s), soll, s + ' wurde nicht erkannt');
  });
});

test('Unklare Zeitangaben liefern null, statt etwas zu raten', () => {
  // Ein falsch geratener Konflikt kostet Vertrauen in jede weitere Meldung.
  ['naechsten Herbst', '2026', 'im September', 'bald', '', null].forEach((s) => {
    assert.equal(D.datumsTeile(s), null, JSON.stringify(s) + ' haette null sein muessen');
  });
});

test('Unmoegliche Datumsangaben werden verworfen', () => {
  assert.equal(D.datumsTeile('45.13.2026'), null);
  assert.equal(D.datumsTeile('0.0.2026'), null);
});

/* ---------- Termin-Konflikt ---------- */

test('Ein abweichender Termin im Dokument ist ein kritischer Befund', () => {
  const b = D.pruefe(digest([fakt({
    aussage: 'Das Seminar findet am 27.10.2026 statt.',
    zitat: 'Termin: 27. Oktober 2026, 11:00 Uhr', kategorie: 'termin'
  })]), { hf: HF });
  const konflikt = b.find(x => x.id === 'termin-konflikt');
  assert.ok(konflikt, 'der teuerste Fehler des Systems muss auffallen');
  assert.equal(konflikt.schwere, 'kritisch');
  assert.match(konflikt.text, /20\.09\.2026/, 'der verbindliche Wert muss in der Meldung stehen');
  assert.match(konflikt.text, /27\.10\.2026/, 'der abweichende Wert ebenso');
});

test('Derselbe Termin in anderer Schreibweise ist KEIN Konflikt', () => {
  const b = D.pruefe(digest([fakt({
    aussage: 'Termin ist der 20. September 2026 um 11 Uhr.',
    zitat: 'Wann: 20. September 2026, 11:00 Uhr', kategorie: 'termin'
  })]), { hf: HF });
  assert.deepEqual(b.filter(x => x.id === 'termin-konflikt'), [],
    'sonst meldet das Tool bei jedem korrekt extrahierten Termin einen Fehlalarm');
});

test('Ein fehlendes Jahr widerspricht dem Briefing nicht', () => {
  const b = D.pruefe(digest([fakt({
    aussage: 'Das Seminar ist am 20. September.',
    zitat: 'Save the date: 20. September', kategorie: 'termin'
  })]), { hf: HF });
  assert.deepEqual(b.filter(x => x.id === 'termin-konflikt'), []);
});

test('Ein bereits gemeldeter Konflikt wird nicht doppelt aufgefuehrt', () => {
  const b = D.pruefe(digest(
    [fakt({ aussage: 'Das Seminar findet am 27.10.2026 statt.', zitat: 'Termin: 27.10.2026', kategorie: 'termin' })],
    [{ feld: 'Termin', briefing: '20.09.2026', dokument: '27.10.2026', zitat: 'Termin: 27.10.2026', seite: 1 }]
  ), { hf: HF });
  assert.deepEqual(b.filter(x => x.id === 'termin-konflikt'), [],
    'das Modell hat den Konflikt bereits gemeldet - eine zweite Meldung ist Laerm');
});

test('Ein Datum ausserhalb der Termin-Kategorie loest keinen Fehlalarm aus', () => {
  // "Gegruendet 1995" oder eine Anmeldefrist sind keine Widersprueche zum
  // Veranstaltungstermin.
  const b = D.pruefe(digest([fakt({
    aussage: 'Die Hellingerschule wurde am 01.03.1995 gegruendet.',
    zitat: 'Gegruendet am 1. Maerz 1995', kategorie: 'referent'
  })]), { hf: HF });
  assert.deepEqual(b.filter(x => x.id === 'termin-konflikt'), []);
});

/* ---------- Text-Konflikt ---------- */

test('Ein abweichender Titel wird als moeglicher Konflikt gemeldet', () => {
  const b = D.pruefe(digest([fakt({
    aussage: 'Der Titel lautet "Der Platz, der zu Dir gehoert".',
    zitat: 'Arbeitstitel: Der Platz, der zu Dir gehoert', kategorie: 'inhalt'
  })]), { hf: HF });
  const k = b.find(x => x.id === 'moeglicher-konflikt');
  assert.ok(k, 'ein fehlendes Wort im Titel aendert die Anzeige');
  assert.equal(k.schwere, 'hinweis', 'nur ein Verdacht - Wortueberdeckung ist keine Gewissheit');
});

test('Ein Fakt zu einem ganz anderen Thema ist kein Konflikt', () => {
  const b = D.pruefe(digest([fakt({
    aussage: 'Die Aufzeichnung steht sieben Tage zur Verfuegung.',
    zitat: 'Die Aufzeichnung ist sieben Tage abrufbar.', kategorie: 'inhalt'
  })]), { hf: HF });
  assert.deepEqual(b.filter(x => /konflikt/.test(x.id)), []);
});

test('Ein woertlich uebernommener Titel ist kein Konflikt', () => {
  const b = D.pruefe(digest([fakt({
    aussage: 'Der Titel lautet "Der Platz, der wirklich zu Dir gehoert".',
    zitat: 'Titel: Der Platz, der wirklich zu Dir gehoert', kategorie: 'inhalt'
  })]), { hf: HF });
  assert.deepEqual(b.filter(x => x.id === 'moeglicher-konflikt'), []);
});

/* ---------- Struktur ---------- */

test('Ein Fakt ohne woertlichen Beleg ist kritisch', () => {
  // Ohne Beleg ist er nicht von einer Erfindung zu unterscheiden - und das
  // Tool kann Zitate nicht selbst gegen das PDF pruefen.
  const b = D.pruefe(digest([fakt({ zitat: 'ja' })]), {});
  assert.ok(b.some(x => x.id === 'fakt-ohne-beleg' && x.schwere === 'kritisch'));
});

test('Eine Seitenzahl ausserhalb des Dokuments faellt auf', () => {
  const b = D.pruefe(digest([fakt({ seite: 99 })]), { seitenGesamt: 12 });
  assert.ok(b.some(x => x.id === 'seite-unplausibel'));
});

test('Ohne bekannte Seitenzahl wird die Fundstelle nicht geprueft', () => {
  // countPdfPages liefert bei komprimierten PDFs null. Dann lieber nicht
  // pruefen als falsch Alarm schlagen.
  const b = D.pruefe(digest([fakt({ seite: 99 })]), {});
  assert.deepEqual(b.filter(x => x.id === 'seite-unplausibel'), []);
});

test('Ein leerer Digest ist ein kritischer Befund, kein stiller Erfolg', () => {
  assert.deepEqual(ids(D.pruefe(digest([]), {})), ['digest-leer']);
  assert.deepEqual(ids(D.pruefe(null, {})), ['digest-leer']);
});

test('Ein Fakt ohne Aussage wird gemeldet', () => {
  const b = D.pruefe(digest([fakt({ aussage: '   ' })]), {});
  assert.ok(b.some(x => x.id === 'fakt-leer'));
});

test('Eine unbekannte Kategorie faellt auf', () => {
  const b = D.pruefe(digest([fakt({ kategorie: 'erfunden' })]), {});
  assert.ok(b.some(x => x.id === 'kategorie-unbekannt'));
});

/* ---------- Prompt-Block ---------- */

test('renderForPrompt gruppiert nach Kategorie und laesst die Zitate weg', () => {
  // Die Zitate belegen den Digest, sie sind kein Schreibmaterial. Im
  // Generierungsprompt waeren sie Ballast und eine Einladung, sie
  // wortwoertlich in die Copy zu uebernehmen.
  const txt = D.renderForPrompt(digest([
    fakt({ aussage: 'Sophie Hellinger leitet das Seminar.', kategorie: 'referent' }),
    fakt({ aussage: 'Es dauert 90 Minuten.', zitat: 'Dauer: circa 90 Minuten', kategorie: 'inhalt' })
  ]), HF);
  assert.match(txt, /Referent:/);
  assert.match(txt, /- Sophie Hellinger leitet das Seminar\./);
  assert.match(txt, /Inhalt:/);
  assert.ok(!/Leitung: Sophie Hellinger, Gruenderin/.test(txt), 'das Zitat gehoert nicht in den Prompt');
  assert.match(txt, /erfinde nichts dazu/, 'die Grenze des Digests muss im Prompt stehen');
});

test('Ein Konflikt steht mit seiner Aufloesung im Prompt, nicht als offene Frage', () => {
  // Ein Modell, das zwei widersprechende Termine sieht und keine Regel dazu,
  // waehlt einen davon - mit 50 Prozent den falschen.
  const txt = D.renderForPrompt(digest([fakt()], [
    { feld: 'Termin', briefing: '20.09.2026, 11 Uhr', dokument: '27.10.2026', zitat: 'x', seite: 3 }
  ]), HF);
  assert.match(txt, /Verbindlich ist immer das Briefing/);
  assert.match(txt, /verbindlich "20\.09\.2026, 11 Uhr"/);
  assert.match(txt, /NICHT verwenden/);
});

test('Ohne Fakten entsteht kein leerer Prompt-Block', () => {
  assert.equal(D.renderForPrompt({ fakten: [], kernaussagen: [] }, HF), '');
  assert.equal(D.renderForPrompt(null, HF), '');
});

test('Fakten mit unbekannter Kategorie gehen im Prompt nicht verloren', () => {
  const txt = D.renderForPrompt(digest([fakt({ aussage: 'Eine wichtige Angabe.', kategorie: 'quatsch' })]), HF);
  assert.match(txt, /Eine wichtige Angabe\./);
});

/* ---------- Prompt und Schema ---------- */

test('Der Extraktions-Prompt verbietet ausdruecklich das Schreiben von Copy', () => {
  const sys = D.buildSystem();
  assert.match(sys, /KEINE Copy/);
  assert.match(sys, /ergaenzt nichts aus eigenem Wissen/);
  assert.match(sys, /WOERTLICH/);
});

test('Der Prompt nennt die bestaetigten Daten als vorrangig', () => {
  const usr = D.buildUser({ hf: HF, zielgruppe: 'Coaches' });
  assert.match(usr, /Der Platz, der wirklich zu Dir gehoert/);
  assert.match(usr, /20\.09\.2026/);
  assert.match(usr, /Coaches/);
  assert.match(usr, /ergaenzen, nicht ersetzen/);
});

test('Ohne bestaetigte Daten wird das benannt, statt Felder zu erfinden', () => {
  assert.match(D.buildUser({ hf: {} }), /\(noch nichts bestaetigt\)/);
});

function pruefeSchema(node, pfad, gefunden) {
  gefunden = gefunden || [];
  if (!node || typeof node !== 'object') return gefunden;
  if (node.type === 'object') {
    if (node.additionalProperties !== false) gefunden.push(pfad + ': additionalProperties muss false sein');
    if (!Array.isArray(node.required)) gefunden.push(pfad + ': required fehlt');
    Object.keys(node.properties || {}).forEach(k => pruefeSchema(node.properties[k], pfad + '.' + k, gefunden));
  }
  if (node.type === 'array') {
    ['minItems', 'maxItems', 'uniqueItems'].forEach(k => {
      if (k in node) gefunden.push(pfad + ': ' + k + ' wird von der API nicht unterstuetzt');
    });
    pruefeSchema(node.items, pfad + '[]', gefunden);
  }
  ['minLength', 'maxLength', 'minimum', 'maximum', 'pattern'].forEach(k => {
    if (k in node) gefunden.push(pfad + ': ' + k + ' wird von der API nicht unterstuetzt');
  });
  return gefunden;
}

test('Das Digest-Schema haelt die API-Einschraenkungen ein', () => {
  assert.deepEqual(pruefeSchema(D.jsonSchema(), 'digest'), []);
  assert.equal(D.outputConfig().format.type, 'json_schema');
});

test('buildRequest uebernimmt vorbereiteten Inhalt mit Dokument-Bloecken', () => {
  // Im Browser haengen die PDFs als document-Bloecke davor - der Aufrufer
  // baut den Inhalt, weil nur er das base64 hat.
  const content = [{ type: 'document', source: { type: 'base64' } }, { type: 'text', text: 'Frage' }];
  const b = D.buildRequest({ content }, 'claude-sonnet-5');
  assert.deepEqual(b.messages[0].content, content);
  assert.equal(b.model, 'claude-sonnet-5');
  assert.deepEqual(b.thinking, { type: 'disabled' });
});

test('Die Digest-Version ist gesetzt', () => {
  assert.equal(typeof D.DIGEST_VERSION, 'number');
});

test('zusammenfassung zaehlt, was ein Mensch zur Beurteilung braucht', () => {
  const d = digest([
    fakt({ kategorie: 'termin' }), fakt({ kategorie: 'termin' }), fakt({ kategorie: 'inhalt' })
  ], [{ feld: 'Titel', briefing: 'a', dokument: 'b', zitat: 'c', seite: 1 }]);
  const z = D.zusammenfassung(d, D.pruefe(d, { hf: HF }));
  assert.equal(z.fakten, 3);
  assert.equal(z.konflikte, 1);
  assert.equal(z.proKategorie.termin, 2);
  assert.equal(typeof z.kritisch, 'number');
});

/* ---------- Deterministisch gefundene Konflikte im Prompt ---------- */

test('Ein selbst gefundener Termin-Konflikt erreicht auch den Prompt', () => {
  // Der teuerste Fall: Das Modell hat den Widerspruch NICHT gemeldet, die
  // Pruefung hat ihn gefunden. Steht er nur in der Oberflaeche, schreibt das
  // Modell trotzdem das falsche Datum.
  const d = digest([fakt({
    aussage: 'Das Seminar findet am 27.10.2026 statt.',
    zitat: 'Termin: 27. Oktober 2026', kategorie: 'termin'
  })]);
  const befunde = D.pruefe(d, { hf: HF });
  assert.ok(befunde.some(b => b.id === 'termin-konflikt'), 'Testannahme: der Konflikt wird gefunden');

  const txt = D.renderForPrompt(d, HF, befunde);
  assert.match(txt, /Verbindlich ist immer das Briefing/);
  assert.match(txt, /20\.09\.2026/, 'der verbindliche Termin muss im Prompt stehen');
  assert.match(txt, /NICHT verwenden/, 'der abweichende Fakt muss markiert sein');
});

test('Nur der widerspruechliche Fakt wird markiert, nicht die uebrigen', () => {
  const d = digest([
    fakt({ aussage: 'Das Seminar findet am 27.10.2026 statt.', zitat: 'Termin: 27.10.2026', kategorie: 'termin' }),
    fakt({ aussage: 'Sophie Hellinger leitet das Seminar.', kategorie: 'referent' })
  ]);
  const txt = D.renderForPrompt(d, HF, D.pruefe(d, { hf: HF }));
  const zeilen = txt.split('\n');
  const termin = zeilen.find(z => /27\.10\.2026 statt/.test(z));
  const referent = zeilen.find(z => /Sophie Hellinger leitet/.test(z));
  assert.match(termin, /ACHTUNG/);
  assert.ok(!/ACHTUNG/.test(referent), 'ein unbeteiligter Fakt darf nicht entwertet werden');
});

test('Ohne Befunde bleibt der Prompt unveraendert', () => {
  // Rueckwaertskompatibel: der dritte Parameter ist optional.
  const d = digest([fakt()]);
  assert.equal(D.renderForPrompt(d, HF, []), D.renderForPrompt(d, HF));
  assert.ok(!/ACHTUNG/.test(D.renderForPrompt(d, HF)));
});

test('Strukturelle Befunde markieren keinen Fakt', () => {
  // Eine unplausible Seitenzahl ist ein Qualitaetsproblem des Digests, kein
  // Widerspruch zum Briefing - der Fakt selbst bleibt verwendbar.
  const d = digest([fakt({ seite: 99 })]);
  const txt = D.renderForPrompt(d, HF, D.pruefe(d, { seitenGesamt: 5 }));
  assert.ok(!/ACHTUNG/.test(txt));
});

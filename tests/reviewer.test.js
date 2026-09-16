/* Absicherung von shared/reviewer.js.

   Die Tests hier halten vor allem die ENTWURFSENTSCHEIDUNGEN fest. Ein
   LLM-Reviewer ist leicht zu bauen und schwer richtig zu bauen; die vier
   Entscheidungen, an denen es kippt, sind einzeln getestet:
   - anderes Modell als der Generator (sonst bewertet er sich selbst)
   - keine Referenz-Copy im Kontext (sonst misst er Aehnlichkeit statt Qualitaet)
   - erfundene Testimonials ausdruecklich erlaubt (sonst Falschbefunde en masse)
   - Belegpflicht per woertlichem Zitat (sonst sind die Befunde nicht auswertbar)

   Faellt einer dieser Tests, ist nicht der Test falsch - dann ist der
   Reviewer zu etwas anderem geworden. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const R = require('../shared/reviewer.js');
const ToolVersions = require('../shared/versions.js');
const CopyPresets = require('../shared/copywriter-presets.js');

/* Eine kleine, aber realistische Seite: Textfelder, Objekt-Arrays,
   String-Arrays - alle drei Formen, die in den Section-Schemas vorkommen. */
const SECTION_DATA = {
  hero: {
    preHeadline: 'Kostenloses Online-Seminar',
    h1: 'Der Platz, der zu Dir gehoert',
    h2: 'Warum alte Muster bleiben, bis die Ordnung stimmt',
    bulletpoints: [
      { title: 'Ordnung erkennen', text: 'Eine klare Einordnung Deiner Familie' },
      { title: 'Muster loesen', text: 'Was sich loest, wenn jeder seinen Platz hat' }
    ],
    ctaButton: 'Jetzt kostenlos anmelden'
  },
  problem: {
    headline: 'Du hast schon viel versucht',
    bodyCopy: 'Buecher gelesen, Seminare besucht, Gespraeche gefuehrt.',
    punkte: ['Immer wieder dieselbe Schleife', 'Kurz Erleichterung, dann alles wie vorher']
  }
};

const ACTIVE = [
  { id: 'hero', name: 'Hero', desc: 'Einstieg' },
  { id: 'problem', name: 'Problem', desc: 'Problemaufriss' }
];

/* ---------- Entwurfsentscheidungen ---------- */

test('Der Reviewer nutzt ein ANDERES Modell als der Generator', () => {
  // Ein Modell, das seinen eigenen Text bewertet, findet systematisch zu wenig.
  assert.notEqual(R.MODEL, ToolVersions.MODEL);
  assert.equal(R.buildRequest({}).model, R.MODEL);
});

test('Der Reviewer bekommt Regelwerk und Wissensdatenbank, aber KEINE Referenz-Copy', () => {
  CopyPresets.CATALOG.forEach((p) => {
    const dateien = R.reviewDateien(p);
    assert.ok(dateien.length >= 2, p.id + ': Regelwerk und Wissensdatenbank erwartet');
    assert.ok(dateien.some(f => /regeln\.md$/.test(f)), p.id + ': Regelwerk fehlt');
    assert.ok(dateien.some(f => /wissensdatenbank\.md$/.test(f)), p.id + ': Wissensdatenbank fehlt');
    dateien.forEach((f) => {
      assert.ok(!/referenzen\//.test(f),
        p.id + ': Referenz-Copy im Reviewer-Kontext - dann bewertet er Aehnlichkeit statt Qualitaet');
    });
    // Gegenprobe: der Generator bekommt sehr wohl eine Referenz.
    assert.ok((p.referenzen || []).length > 0, p.id + ': Testannahme stimmt nicht mehr');
  });
});

test('reviewDateien liefert eine Kopie, nicht die Katalog-Liste selbst', () => {
  const p = CopyPresets.CATALOG[0];
  const d = R.reviewDateien(p);
  d.push('presets/irgendwas.md');
  assert.notEqual(p.files.length, d.length, 'der Katalog darf nicht veraenderbar sein');
});

test('Erfundene Testimonials sind im Prompt ausdruecklich erlaubt', () => {
  // Ohne diesen Satz meldet jeder Reviewer sie als erfundene Fakten und
  // ueberschwemmt das Ergebnis mit Falschbefunden.
  const sys = R.buildSystem('REGELWERK').map(b => b.text).join('\n');
  assert.match(sys, /Testimonials/);
  assert.match(sys, /ERLAUBT/);
  assert.match(sys, /niemals ein Befund/i);
});

test('Der Reviewer wird ausdruecklich vom Umschreiben abgehalten', () => {
  const sys = R.buildSystem('REGELWERK').map(b => b.text).join('\n');
  assert.match(sys, /NICHT um/, 'Umschreiben muss explizit ausgeschlossen sein');
  assert.match(sys, /ausschliesslich Befunde/i);
  const usr = R.buildUser({ copy: 'x' });
  assert.match(usr, /NICHT automatisch uebernommen/,
    'auch der Vorschlag muss als nicht-automatisch gekennzeichnet sein');
});

test('Der Prompt verbietet den Vergleich mit einem Vorbild', () => {
  const sys = R.buildSystem('REGELWERK').map(b => b.text).join('\n');
  assert.match(sys, /nie Aehnlichkeit/i);
});

test('Das Preset liegt in einem eigenen Cache-Block', () => {
  const sys = R.buildSystem('REGELWERK-TEXT');
  assert.equal(sys.length, 2);
  assert.deepEqual(sys[0].cache_control, { type: 'ephemeral', ttl: '1h' });
  assert.match(sys[0].text, /REGELWERK-TEXT/);
  assert.ok(!sys[1].cache_control, 'die Anweisung selbst wird nicht gecacht');
});

test('Ohne Preset bleibt genau ein System-Block ohne Cache', () => {
  const sys = R.buildSystem('');
  assert.equal(sys.length, 1);
  assert.ok(!sys[0].cache_control);
});

/* ---------- Copy-Aufbereitung ---------- */

test('renderCopy gibt jedes Textfeld mit seinem Feldpfad aus', () => {
  const copy = R.renderCopy(ACTIVE, SECTION_DATA);
  assert.match(copy, /\[hero\.h1\] Der Platz, der zu Dir gehoert/);
  assert.match(copy, /\[hero\.bulletpoints\.0\.text\] Eine klare Einordnung Deiner Familie/);
  assert.match(copy, /\[problem\.punkte\.1\] Kurz Erleichterung/);
  assert.match(copy, /### 1\. Hero {2}\(hero\)/);
});

test('renderCopy zeigt eine fehlende Section als solche, statt sie zu verschweigen', () => {
  const copy = R.renderCopy(ACTIVE, { hero: SECTION_DATA.hero });
  assert.match(copy, /\(nicht generiert\)/);
});

test('renderCopy laesst leere Felder weg, statt leere Pfade auszugeben', () => {
  const copy = R.renderCopy([{ id: 'hero', name: 'Hero', desc: '' }], { hero: { h1: 'Text', h2: '   ' } });
  assert.match(copy, /\[hero\.h1\]/);
  assert.ok(!/\[hero\.h2\]/.test(copy));
});

/* ---------- Belegpflicht: der Kern ---------- */

test('Ein halluziniertes Zitat wird verworfen', () => {
  const r = R.pruefeBelege([
    { zitat: 'Eine klare Einordnung Deiner Familie', problem: 'belegt' },
    { zitat: 'Dieser Satz steht so nirgends auf der Seite', problem: 'erfunden' }
  ], SECTION_DATA);
  assert.equal(r.befunde.length, 1);
  assert.equal(r.befunde[0].problem, 'belegt');
  assert.equal(r.verworfen.length, 1);
  assert.equal(r.verworfen[0].grund, 'zitat-nicht-gefunden');
});

test('Verworfene Befunde werden zurueckgegeben, nicht still geloescht', () => {
  // Eine hohe Quote ist ein Befund ueber den REVIEWER. Wer sie wegwirft,
  // merkt nie, dass der Reviewer Stellen erfindet.
  const r = R.pruefeBelege([{ zitat: 'gibt es nicht auf dieser Seite', problem: 'x' }], SECTION_DATA);
  assert.equal(r.verworfen.length, 1);
  assert.equal(r.verworfen[0].problem, 'x', 'der ganze Befund bleibt erhalten, nicht nur eine Zaehlung');
});

test('Sehr kurze Zitate gelten als unbelegt', () => {
  // "Du" oder "Ordnung" findet sich immer - damit liesse sich jeder Befund
  // an der Pruefung vorbeimogeln.
  const r = R.pruefeBelege([{ zitat: 'Ordnung' }, { zitat: 'Du' }], SECTION_DATA);
  assert.equal(r.befunde.length, 0);
  r.verworfen.forEach(v => assert.equal(v.grund, 'zitat-zu-kurz'));
});

test('Ein Zitat ueber eine Feldgrenze hinweg gilt als unbelegt', () => {
  // Es liest sich wie ein Satz der Seite, steht dort aber so nicht - jedes
  // Feld wird deshalb einzeln geprueft und nicht der zusammengefuegte Text.
  const r = R.pruefeBelege([
    { zitat: 'Jetzt kostenlos anmelden Du hast schon viel versucht' }
  ], SECTION_DATA);
  assert.equal(r.befunde.length, 0);
  assert.equal(r.verworfen[0].grund, 'zitat-nicht-gefunden');
});

test('Abweichende Anfuehrungszeichen und Bindestriche brechen den Beleg nicht', () => {
  // Das darf ein Reviewer beim Abtippen verlieren, ohne dass ein echter
  // Befund verloren geht.
  const data = { hero: { h2: 'Warum alte Muster bleiben - so lange, bis die "Ordnung" stimmt' } };
  const r = R.pruefeBelege([
    { zitat: 'Warum alte Muster bleiben – so lange, bis die „Ordnung“ stimmt' }
  ], data);
  assert.equal(r.befunde.length, 1, 'Interpunktion darf keinen Beleg zerstoeren');
});

test('Ersetzte Umlaute gelten NICHT als woertliches Zitat', () => {
  // Wer "oe" fuer "oe" schreibt, hat nicht zitiert - und bei einem Titel, der
  // so in Anzeigen und Einladungen landet, ist das keine Formatfrage.
  const data = { hero: { h1: 'Der Platz, der zu Dir gehört und bleibt' } };
  const r = R.pruefeBelege([{ zitat: 'Der Platz, der zu Dir gehoert und bleibt' }], data);
  assert.equal(r.befunde.length, 0);
  assert.equal(r.verworfen[0].grund, 'zitat-nicht-gefunden');
});

test('pruefeBelege haelt leere und fehlende Eingaben aus', () => {
  assert.deepEqual(R.pruefeBelege(null, null), { befunde: [], verworfen: [] });
  assert.deepEqual(R.pruefeBelege([], SECTION_DATA).befunde, []);
  const r = R.pruefeBelege([{ problem: 'ohne Zitat' }], SECTION_DATA);
  assert.equal(r.verworfen[0].grund, 'zitat-zu-kurz');
});

/* ---------- Schema und Auswertung ---------- */

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

test('Das Review-Schema haelt die API-Einschraenkungen ein', () => {
  assert.deepEqual(pruefeSchema(R.jsonSchema(), 'review'), []);
  assert.equal(R.outputConfig().format.type, 'json_schema');
});

test('Jede Rubrik-Dimension steht im Schema, im Prompt und in der Auswertung', () => {
  const schema = R.jsonSchema();
  const usr = R.buildUser({ copy: 'x' });
  R.KATEGORIEN.forEach((k) => {
    assert.ok(schema.properties.bewertung.properties[k], k + ' fehlt im Schema');
    assert.ok(schema.properties.bewertung.required.includes(k), k + ' ist nicht verpflichtend');
    assert.ok(schema.properties.befunde.items.properties.kategorie.enum.includes(k), k + ' fehlt im Kategorie-Enum');
    assert.match(usr, new RegExp(k), k + ' kommt im Prompt nicht vor');
  });
  assert.equal(R.KATEGORIEN.length, new Set(R.KATEGORIEN).size, 'doppelte Dimension');
});

test('Jede Dimension nennt beide Skalenanker', () => {
  // Ohne Anker bewertet jedes Modell auf einer eigenen Skala und zwei Laeufe
  // sind nicht vergleichbar.
  R.DIMENSIONEN.forEach((d) => {
    assert.ok(d.anker5 && d.anker1, d.key + ': Anker fehlt');
    assert.match(R.rubrikText(), new RegExp(d.anker1.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

test('punkte mittelt nur gueltige Werte und meldet Luecken als null', () => {
  const p = R.punkte({ bewertung: { konkretheit: { punkte: 4 }, dramaturgie: { punkte: 2 }, redundanz: { punkte: 9 } } });
  assert.equal(p.schnitt, 3, 'der ungueltige Wert 9 darf den Schnitt nicht verfaelschen');
  assert.equal(p.werte.redundanz, null);
  assert.equal(p.werte.regelkonformitaet, null);
});

test('punkte liefert null statt NaN, wenn nichts bewertet wurde', () => {
  assert.equal(R.punkte({}).schnitt, null);
  assert.equal(R.punkte(null).schnitt, null);
});

/* ---------- Request ---------- */

test('buildRequest schaltet thinking ab und begrenzt die Laenge', () => {
  const b = R.buildRequest({ presetText: 'X', copy: 'Y' });
  assert.deepEqual(b.thinking, { type: 'disabled' });
  assert.ok(b.max_tokens > 0);
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0].role, 'user');
});

test('Der Prompt nennt Briefing, Aufbau und Copy getrennt voneinander', () => {
  const usr = R.buildUser({
    hf: { kampagnenname: 'K', titel: 'T', offer: 'Angebot X' },
    zielgruppe: 'Coaches', pageMap: '1. Hero (hero): Einstieg',
    copy: R.renderCopy(ACTIVE, SECTION_DATA)
  });
  assert.match(usr, /KAMPAGNEN-BRIEFING/);
  assert.match(usr, /Zielgruppe: Coaches/);
  assert.match(usr, /Angebot X/);
  assert.match(usr, /AUFBAU DER SEITE/);
  assert.match(usr, /DIE ZU PRUEFENDE COPY/);
  assert.match(usr, /\[hero\.h1\]/);
});

test('Fehlende Zielgruppe wird als Luecke benannt, nicht stillschweigend weggelassen', () => {
  const usr = R.buildUser({ hf: { titel: 'T' }, copy: 'x' });
  assert.match(usr, /Zielgruppe: \(keine Angabe\)/);
});

test('Die Rubrik-Version ist gesetzt - sonst sind zwei Laeufe nicht vergleichbar', () => {
  assert.equal(typeof R.RUBRIK_VERSION, 'number');
  assert.ok(R.RUBRIK_VERSION >= 1);
});

/* ---- Abgrenzung zum maschinellen Abgleich (nach dem ersten Live-Lauf) ----
   Drei von fuenf kritischen Reviewer-Befunden waren "nicht ... sondern" -
   das findet die Regex im Quality Gate bereits, Wort fuer Wort und ohne
   Kosten. Der teure Call fand zu einem guten Teil das, was der billige
   schon hatte.

   Die Korrektur darf aber nicht in "ignoriere diese Regeln" umschlagen:
   Der beste Befund des Laufs war "Statt einer weiteren Erklaerung erlebst
   Du ..." - derselbe Korrekturgestus ohne die verbotene Wortfolge. Das sieht
   keine Regex. */

const VERBOTE = [
  { id: 'nicht-sondern', hinweis: 'Perspektivverschiebung fliessend formulieren.' },
  { id: 'sie-anrede', hinweis: 'Durchgaengig Du, grossgeschrieben.' }
];
const sysText = (verbote) => R.buildSystem('REGELWERK', verbote).map(b => b.text).join('\n');

test('Der Reviewer erfaehrt, welche Regeln maschinell geprueft werden', () => {
  const sys = sysText(VERBOTE);
  assert.match(sys, /BEREITS MASCHINELL GEPRUEFT/);
  VERBOTE.forEach(v => assert.match(sys, new RegExp(v.hinweis.slice(0, 25).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    v.id + ' fehlt im Prompt'));
});

test('Die sinngemaesse Verletzung bleibt ausdruecklich seine Aufgabe', () => {
  // Ohne diesen Teil wuerde die Abgrenzung den Reviewer entwerten, statt ihn
  // zu schaerfen.
  const sys = sysText(VERBOTE);
  assert.match(sys, /DEINE Aufgabe/);
  assert.match(sys, /sinngemaess/);
  assert.match(sys, /Statt X/, 'das Beispiel macht den Unterschied erst greifbar');
  assert.match(sys, /melde sie/);
});

test('Ohne Verbotsliste entfaellt die Passage ersatzlos', () => {
  // Ein Hinweis auf nicht genannte Regeln wuerde nur verunsichern.
  [[], null, undefined].forEach((v) => {
    assert.ok(!/BEREITS MASCHINELL GEPRUEFT/.test(sysText(v)), 'Passage trotz leerer Liste: ' + JSON.stringify(v));
  });
});

test('Verbote ohne Hinweistext werden uebergangen', () => {
  const sys = sysText([{ id: 'x' }, { id: 'y', hinweis: 'Keine Preise in der Copy.' }]);
  assert.match(sys, /Keine Preise/);
  assert.ok(!/- undefined/.test(sys));
});

test('buildRequest reicht die Verbotsliste durch', () => {
  const b = R.buildRequest({ presetText: 'X', verbote: VERBOTE, copy: 'Y' });
  assert.match(b.system.map(x => x.text).join('\n'), /BEREITS MASCHINELL GEPRUEFT/);
});

/* ---- Deterministische Felder ---- */

const SCHEMAS = require('../shared/section-schemas.js');

test('Felder aus dem bestaetigten Briefing sind in der Copy markiert', () => {
  // Ein Befund auf hero.h1 richtet sich an den Menschen, der das Briefing
  // verantwortet; einer auf framework.bodyCopy an die Generierung.
  const copy = R.renderCopy([{ id: 'hero', name: 'Hero' }],
    { hero: { h1: 'Der Titel', announcement: 'Der Banner' } }, SCHEMAS);
  assert.match(copy, /\[hero\.h1 .* aus dem bestaetigten Briefing\]/);
  assert.ok(!/announcement.*bestaetigten/.test(copy), 'ein generiertes Feld darf nicht markiert sein');
});

test('Der Prompt erklaert die Markierung, statt sie unkommentiert zu lassen', () => {
  const sys = sysText(VERBOTE);
  assert.match(sys, /aus dem bestaetigten Briefing/);
  assert.match(sys, /Briefing zu aendern waere/);
});

test('Ohne Schemas bleibt renderCopy unveraendert', () => {
  // Rueckwaertskompatibel: der dritte Parameter ist optional.
  const sd = { hero: { h1: 'Der Titel' } };
  const act = [{ id: 'hero', name: 'Hero' }];
  assert.equal(R.renderCopy(act, sd), R.renderCopy(act, sd, null));
  assert.ok(!/bestaetigten/.test(R.renderCopy(act, sd)));
});

test('Die Markierung zerstoert die Belegpruefung nicht', () => {
  // pruefeBelege arbeitet auf den Rohdaten, nicht auf der gerenderten Copy -
  // sonst wuerde die Markierung in den Zitatvergleich geraten.
  const sd = { hero: { h1: 'Der Platz, der zu Dir gehoert' } };
  const r = R.pruefeBelege([{ zitat: 'Der Platz, der zu Dir gehoert' }], sd);
  assert.equal(r.befunde.length, 1);
  assert.equal(r.verworfen.length, 0);
});

test('festeFelder kennt die deterministischen Felder des Hero', () => {
  const f = R.festeFelder('hero', SCHEMAS);
  ['h1', 'h2', 'bulletpoints', 'ctaButton', 'preHeadline'].forEach(
    n => assert.ok(f.includes(n), n + ' fehlt'));
  assert.deepEqual(R.festeFelder('unbekannt', SCHEMAS), []);
  assert.deepEqual(R.festeFelder('hero', null), []);
});

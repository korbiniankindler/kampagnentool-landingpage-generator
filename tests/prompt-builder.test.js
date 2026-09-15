/* Absicherung von shared/prompt-builder.js.

   Kern: Erst- und Neugenerierung bekommen DIESELBEN Vorgaben. Vorher fehlten
   dem Regenerierungs-Prompt saemtliche Section-Regeln, der Seitenaufbau, der
   Content-Plan, Termin, Offer und die Bulletpoints - wer den Hero
   regenerierte, bekam einen neu erfundenen Titel. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
global.SectionSchemas = require('../shared/section-schemas.js');
const PB = require('../shared/prompt-builder.js');

const HF = {
  titel: 'Der Platz, der zu Dir gehoert', pre_headline: 'PRE', sub_headline: 'SUB',
  live_termin: '20.09.2026, 11 Uhr', offer: 'Ausbildung',
  beschreibung: 'Live-Seminar mit Sophie Hellinger.',
  bulletpoints: ['Erster Punkt', 'Zweiter Punkt', 'Dritter Punkt']
};
const BASE = {
  hf: HF, zielgruppe: 'Menschen mit Vorerfahrung', strategie: 'Tiefe statt Oberflaeche',
  ctxBlock: 'Zusaetzlicher Kontext: X\n',
  pageMap: '1. Hero (hero): Above the fold\n2. Social Proof (social): 3 Testimonials',
  planText: '1. Hero (hero): Ankommen\n2. Social Proof (social): Vertrauen',
  brandCfg: { eventBezeichnung: 'Live-Seminar' },
  lpVorlage: { ctaText: 'Jetzt kostenfrei anmelden', conversionAction: 'anmeldung', microcopy: '100 % kostenfrei' }
};
const chunkP = (o) => PB.buildChunkPrompt(Object.assign({}, BASE, { chunk: [{ id: 'hero', name: 'Hero' }, { id: 'social', name: 'Social Proof' }] }, o));
const regenP = (o) => PB.buildRegenPrompt(Object.assign({}, BASE, { section: { id: 'hero', name: 'Hero' }, feedback: 'konfrontativer' }, o));

/* ---- Der zentrale Test ---- */

test('Neugenerierung bekommt dieselben Vorgaben wie die Erstgenerierung', () => {
  const c = chunkP(), r = regenP();
  const muss = [
    ['Termin: 20.09.2026, 11 Uhr', 'der Termin fehlte der Neugenerierung komplett'],
    ['Offer: Ausbildung', 'ebenso das Angebot'],
    ['Inhalts-Bullets', 'ebenso die bestaetigten Bulletpoints'],
    ['Pre-Headline: PRE', 'ebenso Pre- und Sub-Headline'],
    ['Aufbau der GESAMTEN Landingpage', 'ohne Seitenaufbau entstehen neue Dopplungen'],
    ['Content-Plan', 'ohne Plan bricht die Gesamtdramaturgie'],
    ['exakt 5 Eintraege', 'Anzahl-Constraints fehlten'],
    ['exakt 3 Eintraege', 'Anzahl-Constraints fehlten'],
    ['Referent/Host NIEMALS erfinden', 'die wichtigste Halluzinationsbremse fehlte'],
    ['h1 = exakt aus "Titel"', 'deshalb erfand ein Hero-Regen den Titel neu'],
    ['genau 3 Stueck', 'die bestaetigte Bullet-Anzahl'],
    ['TEXTLAENGEN', 'die Laengenvorgaben'],
    ['Zielgruppe: Menschen mit Vorerfahrung', 'die Zielgruppe']
  ];
  muss.forEach(([marker, warum]) => {
    assert.ok(c.includes(marker), `Chunk-Prompt fehlt "${marker}"`);
    assert.ok(r.includes(marker), `Regen-Prompt fehlt "${marker}" - ${warum}`);
  });
});

test('Section-Regeln sind in beiden Modi byte-identisch', () => {
  const a = PB.sectionRegeln(Object.assign({ mode: 'initial' }, BASE));
  const b = PB.sectionRegeln(Object.assign({ mode: 'regen' }, BASE));
  assert.equal(a, b, 'divergierende Regeln waren genau der Defekt');
});

/* ---- Marken-Konfiguration ---- */

test('CTA und Event-Bezeichnung kommen aus der Marken-Konfiguration', () => {
  const p = chunkP();
  assert.ok(p.includes('"Jetzt kostenfrei anmelden"'));
  assert.ok(p.includes('Nenne das Format "Live-Seminar"'));
  assert.ok(!p.includes('Jetzt kostenlos anmelden'));
  assert.ok(!/LIVE-Webinar am/.test(p));
});

test('Bullet-Anzahl folgt der Nutzerauswahl', () => {
  assert.ok(chunkP({ hf: Object.assign({}, HF, { bulletpoints: ['a', 'b', 'c', 'd', 'e'] }) }).includes('genau 5 Stueck'));
  assert.ok(chunkP({ hf: Object.assign({}, HF, { bulletpoints: [] }) }).includes('keine angegeben'));
});

/* ---- Modusspezifisches ---- */

test('nur der Regen-Modus traegt Feedback, Locks und Nachbarsections', () => {
  const r = regenP({ lockedSnap: [{ path: 'h2', value: 'Gesperrt' }], nachbarn: 'social: {...}' });
  assert.ok(r.includes('Feedback: konfrontativer'));
  assert.ok(r.includes('GESPERRTE FELDER'));
  assert.ok(r.includes('Bereits geschriebene Sections'));
  assert.ok(r.includes('Überarbeite NUR die Section "Hero"'));

  const c = chunkP();
  assert.ok(!c.includes('Feedback:'));
  assert.ok(!c.includes('Überarbeite NUR'));
  assert.ok(c.includes('Generiere folgende Sections'));
});

test('ohne Feedback bekommt die Neugenerierung eine neutrale Vorgabe', () => {
  assert.match(regenP({ feedback: '' }), /Feedback: Allgemein verbessern/);
});

test('eigene Sections behalten ihre Beschreibung in beiden Modi', () => {
  const eigen = { id: 'custom_1', name: 'Garantie', desc: 'Zwei Columns mit je Headline und Text', custom: true };
  assert.ok(chunkP({ chunk: [eigen] }).includes('Zwei Columns'));
  const r = regenP({ section: eigen });
  assert.ok(r.includes('Beschreibung dieser eigenen Section: Zwei Columns'));
  assert.ok(r.includes('SELBST aus der Beschreibung'), 'kein festes Schema fuer eigene Sections');
});

/* ---- Robustheit ---- */

test('fehlende Angaben werden benannt statt erfunden', () => {
  const p = PB.buildChunkPrompt({ hf: {}, chunk: [{ id: 'hero', name: 'Hero' }] });
  assert.ok(p.includes('(keine Angabe)'), 'Zielgruppe');
  assert.ok(p.includes('(keine Bulletpoints angegeben)'));
  assert.ok(!p.includes('Termin:'), 'leere Felder werden weggelassen, nicht mit Platzhalter gefuellt');
});

test('haelt leere Eingaben aus', () => {
  assert.doesNotThrow(() => PB.buildChunkPrompt({}));
  assert.doesNotThrow(() => PB.buildRegenPrompt({ section: { id: 'x', name: 'X' } }));
});

test('buildPageMap nummeriert ab 1', () => {
  const m = PB.buildPageMap([{ id: 'hero', name: 'Hero', desc: 'A' }, { id: 'social', name: 'Social', desc: 'B' }]);
  assert.match(m, /^1\. Hero \(hero\): A/);
  assert.match(m, /2\. Social \(social\): B/);
});

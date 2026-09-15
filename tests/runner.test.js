/* Absicherung des Headless-Runners.

   Der Runner ist nur dann aussagekraeftig, wenn er DIESELBE Pipeline faehrt
   wie das Tool - gleiche Prompts, gleiche Referenzwahl, gleicher Hero-Merge,
   gleiches Gate. Genau das pruefen diese Tests. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { ladePreset, metriken } = require(path.join(ROOT, 'eval/runner.js'));
const CopyPresets = require(path.join(ROOT, 'shared/copywriter-presets.js'));
global.SectionSchemas = global.SectionSchemas || require(path.join(ROOT, 'shared/section-schemas.js'));
global.BrandConfig = global.BrandConfig || require(path.join(ROOT, 'shared/brand-config.js'));
const Validators = require(path.join(ROOT, 'shared/validators.js'));

const FAELLE = path.join(ROOT, 'eval/faelle');

test('alle Eval-Faelle sind gueltig und vollstaendig', () => {
  const dateien = fs.readdirSync(FAELLE).filter(f => f.endsWith('.json'));
  assert.ok(dateien.length >= 4, 'mindestens vier Faelle als Startpunkt');
  const ids = new Set();
  dateien.forEach(f => {
    const fall = JSON.parse(fs.readFileSync(path.join(FAELLE, f), 'utf8'));
    assert.ok(fall.id && !ids.has(fall.id), `${f}: id fehlt oder doppelt`);
    ids.add(fall.id);
    assert.ok(fall.beschreibung, `${f}: ohne Beschreibung ist unklar, was der Fall abdeckt`);
    assert.ok(Array.isArray(fall.sections) && fall.sections.length, `${f}: keine Sections`);
    assert.ok(fall.hardfacts, `${f}: keine Hardfacts`);
    if (fall.preset) {
      assert.ok(CopyPresets.CATALOG.some(p => p.id === fall.preset), `${f}: unbekanntes Preset ${fall.preset}`);
    }
  });
});

test('die Faelle decken beide Marken und beide Register ab', () => {
  const faelle = fs.readdirSync(FAELLE).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(FAELLE, f), 'utf8')));
  const presets = new Set(faelle.map(f => f.preset));
  assert.ok(presets.has('hellinger') && presets.has('holistic-house'), 'beide Marken');
  assert.ok(faelle.some(f => !f.hardfacts.zielgruppe || !f.hardfacts.live_termin),
    'mindestens ein Fall mit Luecken - sonst bleibt ungeprueft, ob Platzhalter statt Erfindungen entstehen');
});

test('Preset-Laden trifft dieselbe Referenz-Wahl wie das Tool', () => {
  // Die Register-Heuristik entscheidet, welche Referenz-Copy in den Prompt
  // geht. Waehlt der Runner anders, misst er eine andere Pipeline.
  const b2b = ladePreset('hellinger', 'Coaches, Therapeutinnen und Berater');
  const b2c = ladePreset('hellinger', 'Menschen mit Vorerfahrung in Aufstellungsarbeit');
  assert.equal(b2b.refId, 'b2b');
  assert.equal(b2c.refId, 'b2c');
  assert.equal(b2b.refId, CopyPresets.autoRef('hellinger', 'Coaches, Therapeutinnen und Berater').id);
});

test('Preset-Text enthaelt Regelwerk, Wissensdatenbank und genau eine Referenz', () => {
  const { text } = ladePreset('hellinger', 'Menschen mit Vorerfahrung');
  assert.match(text, /Copywriter-Regelwerk/);
  assert.match(text, /Wissensdatenbank/);
  // genau eine Referenz: der B2B-Titel darf im B2C-Lauf nicht auftauchen
  assert.ok(!/Coaching loest Symptome, Ordnung loest Ursachen/.test(text),
    'mehrere Referenzen wuerden die Register-Tonalitaeten mischen');
});

test('ohne Preset liefert ladePreset leeren Text statt zu werfen', () => {
  const r = ladePreset(null, 'x');
  assert.equal(r.text, '');
  assert.equal(r.refId, null);
});

test('unbekanntes Preset scheitert laut', () => {
  assert.throws(() => ladePreset('gibtsnicht', 'x'), /Unbekanntes Preset/);
});

test('Metriken zaehlen die Groessen, die der Benchmark vergleicht', () => {
  const befunde = [
    { schwere: 'kritisch', id: 'preset-verstoss' },
    { schwere: 'kritisch', id: 'feld-leer' },
    { schwere: 'kritisch', id: 'anzahl' },
    { schwere: 'hinweis', id: 'redundanz' }
  ];
  const m = metriken(befunde, { hero: { h1: 'Ein Titel mit fuenf Woertern' } },
    [{ id: 'hero' }], [{ feld: 'h1' }]);
  assert.equal(m.befundeKritisch, 3);
  assert.equal(m.befundeHinweis, 1);
  assert.equal(m.presetVerstoesse, 1);
  assert.equal(m.redundanzen, 1);
  assert.equal(m.faktenAbweichungen, 1, 'wie oft das Modell von bestaetigten Werten abweichen wollte');
  assert.equal(m.sectionsErwartet, 1);
  assert.equal(m.woerterGesamt, 5);
});

test('kein Feldname im Schema primt eine verbotene Bezeichnung', () => {
  /* Der Feldname steht im Prompt-Schema und wird vom Modell gelesen.
     "webinarRole" primte bei Hellinger genau das im Regelwerk verbotene Wort -
     aufgefallen erst im Trockenlauf des Runners. */
  const hellinger = global.BrandConfig.forPreset(
    fs.readFileSync(path.join(ROOT, 'presets/hellinger/regeln.md'), 'utf8'));
  global.SectionSchemas.knownIds().forEach(id => {
    const hint = global.SectionSchemas.promptHint(id) || '';
    const treffer = global.BrandConfig.pruefeText(hellinger, hint);
    assert.deepEqual(treffer, [], `Schema von "${id}" primt: ${JSON.stringify(treffer)}`);
  });
});

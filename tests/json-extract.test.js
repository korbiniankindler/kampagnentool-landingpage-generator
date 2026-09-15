/* Absicherung von shared/json-extract.js gegen die Fehlerbilder, die in
   Produktivlaeufen tatsaechlich auftreten. Fixtures: tests/fixtures/model-responses/

   Der wichtigste Test hier ist `truncated`: Eine abgeschnittene Antwort MUSS
   ohne opts.salvage werfen und mit opts.salvage als `salvaged: true` markiert
   sein. Vor Phase 0 wurde sie still als Erfolg weiterverarbeitet. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { extractJSON, extractJSONDetailed, normalizeModelText } = require('../shared/json-extract.js');

const FIX = path.join(__dirname, 'fixtures', 'model-responses');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');

test('valid: parst unveraendert, ohne Reparatur und ohne Salvage', () => {
  const r = extractJSONDetailed(fixture('valid.json.txt'));
  assert.equal(r.salvaged, false);
  assert.equal(r.repaired, false);
  assert.equal(r.data.titel.length, 1);
  assert.equal(r.data.titel[0].titel, 'Der Platz, der zu Dir gehoert');
});

test('markdown-fence: Backticks werden entfernt', () => {
  const r = extractJSONDetailed(fixture('markdown-fence.txt'));
  assert.equal(r.salvaged, false);
  assert.equal(r.data.titel[0].pre, 'A');
});

test('prose-before: Fliesstext vor dem JSON wird uebersprungen', () => {
  const r = extractJSONDetailed(fixture('prose-before.txt'));
  assert.equal(r.salvaged, false);
  assert.equal(r.data.strategie, 'Kurz und knapp.');
});

test('unescaped-quote: inneres Zitat wird maskiert, Text bleibt vollstaendig', () => {
  const r = extractJSONDetailed(fixture('unescaped-quote.txt'));
  assert.equal(r.salvaged, false);
  assert.equal(r.repaired, true);
  assert.match(r.data.strategie, /Alte Muster loesen/);
  // Der String darf NICHT den Rest der Antwort verschluckt haben
  assert.equal(r.data.titel.length, 1);
});

test('real-newline: echter Umbruch im String bleibt als Umbruch erhalten', () => {
  const r = extractJSONDetailed(fixture('real-newline.txt'));
  assert.equal(r.salvaged, false);
  assert.equal(r.repaired, true);
  assert.match(r.data.strategie, /Erster Gedanke/);
  assert.match(r.data.strategie, /Zweiter Gedanke/);
});

test('missing-comma: fehlendes Trennkomma wird ergaenzt', () => {
  const r = extractJSONDetailed(fixture('missing-comma.txt'));
  assert.equal(r.salvaged, false);
  assert.equal(r.repaired, true);
  assert.equal(r.data.strategie, 'Kurz und knapp.');
  assert.equal(r.data.titel[0].titel, 'B');
});

test('trailing-comma: Komma vor schliessender Klammer wird entfernt', () => {
  const r = extractJSONDetailed(fixture('trailing-comma.txt'));
  assert.equal(r.salvaged, false);
  assert.equal(r.data.titel.length, 1);
});

test('literal-backslash-n: \\n als Zeichenfolge wird zu echtem Umbruch', () => {
  const r = extractJSONDetailed(fixture('literal-backslash-n.txt'));
  assert.equal(r.data.strategie, 'Erster Absatz.\n\nZweiter Absatz.');
  assert.ok(!r.data.strategie.includes('\\n'), 'kein sichtbares \\n im Text');
});

/* ---- Der Kern von Phase 0.5 ---- */

test('truncated: wirft ohne salvage', () => {
  assert.throws(
    () => extractJSON(fixture('truncated.txt')),
    /unvollständig|abgeschnitten/i
  );
});

test('truncated: mit salvage geborgen, aber als salvaged MARKIERT', () => {
  const r = extractJSONDetailed(fixture('truncated.txt'), { salvage: true });
  assert.equal(r.salvaged, true, 'Salvage MUSS erkennbar sein - sonst gilt ein abgeschnittener Output als Erfolg');
  // Es wurde etwas gerettet, aber weniger als angefordert
  assert.ok(Array.isArray(r.data.titel));
  assert.ok(r.data.titel.length < 5, 'abgeschnitten = weniger Eintraege als die 5 angeforderten');
});

test('truncated: Abbruch direkt nach einem Key wird geborgen (haeufigster Fall)', () => {
  // Bricht die Antwort nach `"sub":` ab, hat der Key keinen Wert mehr. Ohne
  // Entfernen des haengenden Keys scheitert Salvage komplett.
  const r = extractJSONDetailed(fixture('truncated.txt'), { salvage: true });
  assert.equal(r.data.titel.length, 3, 'der angefangene dritte Eintrag wird ohne seinen leeren Key gerettet');
  assert.equal(r.data.titel[2].titel, 'H');
  assert.equal(r.data.titel[2].sub, undefined, 'das abgeschnittene Feld fehlt - genau deshalb ist salvaged:true noetig');
});

test('truncated-mid-string: wirft ohne salvage, salvaged mit', () => {
  assert.throws(() => extractJSON(fixture('truncated-mid-string.txt')), /unvollständig|abgeschnitten/i);
  const r = extractJSONDetailed(fixture('truncated-mid-string.txt'), { salvage: true });
  assert.equal(r.salvaged, true);
  assert.equal(typeof r.data.strategie, 'string');
});

test('no-json: wirft immer, auch mit salvage', () => {
  assert.throws(() => extractJSON(fixture('no-json.txt')), /Kein JSON-Objekt/);
  assert.throws(() => extractJSON(fixture('no-json.txt'), { salvage: true }), /Kein JSON-Objekt/);
});

test('leere und null-Eingabe werfen sauber statt TypeError', () => {
  assert.throws(() => extractJSON(''), /Kein JSON-Objekt/);
  assert.throws(() => extractJSON(null), /Kein JSON-Objekt/);
  assert.throws(() => extractJSON(undefined), /Kein JSON-Objekt/);
});

test('normalizeModelText arbeitet rekursiv und laesst Nicht-Strings in Ruhe', () => {
  const out = normalizeModelText({ a: 'x\\ny', b: ['p\\nq'], c: 5, d: null, e: true });
  assert.equal(out.a, 'x\ny');
  assert.equal(out.b[0], 'p\nq');
  assert.equal(out.c, 5);
  assert.equal(out.d, null);
  assert.equal(out.e, true);
});

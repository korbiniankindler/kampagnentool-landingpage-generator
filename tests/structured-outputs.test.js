/* Absicherung der Structured-Outputs-Schemas.

   Belegte Einschraenkungen der API, die hier den Ausschlag geben:
   - additionalProperties: false ist fuer JEDES Objekt Pflicht
   - Array-Constraints (minItems/maxItems) werden NICHT unterstuetzt
   - String-Constraints (minLength/maxLength) ebenfalls nicht
   Daraus folgt: das Schema garantiert Feldnamen, Typen und Struktur, aber
   NICHT die Anzahl der Eintraege und nicht die Vollstaendigkeit bei
   Token-Limit. Beides bleibt Aufgabe des Prompts und der Validatoren. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../shared/section-schemas.js');
const ClaudeAPI = require('../shared/api-client.js');

const ROOT = path.join(__dirname, '..');

/* Prueft rekursiv, dass das Schema die API-Einschraenkungen einhaelt. */
function pruefeSchema(node, pfad, gefunden) {
  gefunden = gefunden || [];
  if (!node || typeof node !== 'object') return gefunden;
  if (node.type === 'object') {
    if (node.additionalProperties !== false) gefunden.push(`${pfad}: additionalProperties muss false sein`);
    if (!Array.isArray(node.required)) gefunden.push(`${pfad}: required fehlt`);
    Object.keys(node.properties || {}).forEach(k => pruefeSchema(node.properties[k], `${pfad}.${k}`, gefunden));
  }
  if (node.type === 'array') {
    ['minItems', 'maxItems', 'uniqueItems'].forEach(k => {
      if (k in node) gefunden.push(`${pfad}: ${k} wird von der API nicht unterstuetzt`);
    });
    pruefeSchema(node.items, `${pfad}[]`, gefunden);
  }
  ['minLength', 'maxLength', 'minimum', 'maximum', 'pattern'].forEach(k => {
    if (k in node) gefunden.push(`${pfad}: ${k} wird von der API nicht unterstuetzt`);
  });
  return gefunden;
}

test('jedes Section-Schema haelt die API-Einschraenkungen ein', () => {
  S.knownIds().forEach(id => {
    const sch = S.jsonSchema(id);
    if (!sch) return;
    assert.deepEqual(pruefeSchema(sch, id), [], `Schema von "${id}" ist nicht API-konform`);
  });
});

test('Schemas von Modul 1 halten die Einschraenkungen ein', () => {
  const html = fs.readFileSync(path.join(ROOT, 'hardfacts-generator.html'), 'utf8');
  ['SCHEMA_TITEL', 'SCHEMA_BULLETS'].forEach(name => {
    const m = html.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n\\};)`));
    assert.ok(m, `${name} nicht gefunden`);
    const cfg = eval('(' + m[1].replace(/;$/, '') + ')');
    assert.equal(cfg.format.type, 'json_schema');
    assert.deepEqual(pruefeSchema(cfg.format.schema, name), [], `${name} ist nicht API-konform`);
  });
});

test('Chunk-Schema bindet mehrere Sections', () => {
  const cfg = S.outputConfig([{ id: 'social' }, { id: 'benefits' }]);
  assert.equal(cfg.format.type, 'json_schema');
  assert.deepEqual(Object.keys(cfg.format.schema.properties).sort(), ['benefits', 'social']);
  assert.deepEqual(cfg.format.schema.required.sort(), ['benefits', 'social']);
});

test('eigene Sections werden NICHT schemagebunden', () => {
  // Ihre Struktur soll aus der Beschreibung entstehen - ein festes Schema
  // waere genau die Regression, die frueher behoben wurde.
  assert.equal(S.outputConfig([{ id: 'hero' }, { id: 'custom_1', custom: true }]), null);
  assert.equal(S.outputConfig([{ id: 'gibtsnicht' }]), null);
  assert.equal(S.outputConfig([]), null);
});

test('optionale Felder stehen nicht in required', () => {
  const faq = S.jsonSchema('faq');
  assert.ok(faq.properties.ctaButton, 'ctaButton ist im Schema');
  assert.ok(!faq.required.includes('ctaButton'), 'aber nicht erzwungen - das Regelwerk sieht ihn nur optional vor');
  assert.ok(faq.required.includes('faqs'));
});

test('der Hero laesst die deterministisch gesetzten Felder aus dem Schema', () => {
  const hero = S.jsonSchema('hero');
  ['h1', 'h2', 'preHeadline', 'bulletpoints', 'ctaButton'].forEach(f => {
    assert.ok(!(f in hero.properties), `${f} wird vom Code gesetzt und gehoert nicht ins Antwortschema`);
  });
  assert.ok('announcement' in hero.properties);
});

/* ---- Rueckfall, wenn der Proxy das Schema ablehnt ---- */

test('Schema-Ablehnung wird erkannt', () => {
  const ja = ['unexpected parameter output_config', 'Unrecognized request argument: output_config',
              'json_schema is not supported'];
  const nein = ['rate limit exceeded', 'max_tokens: must be <= 64000', 'Overloaded'];
  ja.forEach(m => assert.ok(ClaudeAPI.istSchemaAbgelehnt(new Error(m)), `nicht erkannt: ${m}`));
  nein.forEach(m => assert.ok(!ClaudeAPI.istSchemaAbgelehnt(new Error(m)), `faelschlich erkannt: ${m}`));
  assert.ok(!ClaudeAPI.istSchemaAbgelehnt(null));
});

test('bei Ablehnung wird ohne Schema wiederholt und das gemeldet', async () => {
  const gesendet = [];
  let gemeldet = false;
  ClaudeAPI._resetThrottleForTests();
  ClaudeAPI.configure({
    proxyUrl: 'https://proxy.test/', maxPerMin: 1000, maxAttempts: 1,
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      gesendet.push(body);
      if (body.output_config) {
        return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null },
          text: async () => JSON.stringify({ error: { type: 'invalid_request_error', message: 'unexpected parameter output_config' } }) };
      }
      return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null },
        text: async () => JSON.stringify({ content: [{ type: 'text', text: '{"ok":1}' }], stop_reason: 'end_turn' }) };
    }
  });

  const d = await ClaudeAPI.sendMitSchema({ model: 'm', max_tokens: 100 },
    { format: { type: 'json_schema', schema: { type: 'object' } } },
    { onFallback: () => { gemeldet = true; } });

  assert.equal(gesendet.length, 2, 'erst mit Schema, dann ohne');
  assert.ok(gesendet[0].output_config, 'erster Versuch mit Schema');
  assert.ok(!gesendet[1].output_config, 'zweiter ohne');
  assert.equal(d._schemaGenutzt, false);
  assert.ok(gemeldet, 'der Rueckfall darf nicht still passieren');
  assert.equal(ClaudeAPI.textOf(d), '{"ok":1}');
});

test('andere Fehler loesen KEINEN Schema-Rueckfall aus', async () => {
  const gesendet = [];
  ClaudeAPI._resetThrottleForTests();
  ClaudeAPI.configure({
    proxyUrl: 'https://proxy.test/', maxPerMin: 1000, maxAttempts: 1,
    sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      gesendet.push(JSON.parse(init.body));
      return { ok: true, status: 200, statusText: 'OK', headers: { get: () => null },
        text: async () => JSON.stringify({ error: { type: 'invalid_request_error', message: 'max_tokens too large' } }) };
    }
  });
  await assert.rejects(() => ClaudeAPI.sendMitSchema({ model: 'm' },
    { format: { type: 'json_schema', schema: {} } }, {}), /max_tokens/);
  assert.equal(gesendet.length, 1, 'kein zweiter Versuch - der Fehler liegt nicht am Schema');
});

test('ohne Schema verhaelt sich sendMitSchema wie send', async () => {
  ClaudeAPI._resetThrottleForTests();
  ClaudeAPI.configure({
    proxyUrl: 'https://proxy.test/', maxPerMin: 1000, sleepImpl: async () => {},
    fetchImpl: async () => ({ ok: true, status: 200, statusText: 'OK', headers: { get: () => null },
      text: async () => JSON.stringify({ content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn' }) })
  });
  const d = await ClaudeAPI.sendMitSchema({ model: 'm' }, null, {});
  assert.equal(ClaudeAPI.textOf(d), 'x');
});

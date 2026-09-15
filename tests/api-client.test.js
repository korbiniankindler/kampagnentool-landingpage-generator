/* Absicherung von shared/api-client.js.

   Jeder Test hier entspricht einem Fehlerbild, das die alte, in beiden
   Modul-HTMLs duplizierte callClaude()-Implementierung falsch behandelt hat. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ClaudeAPI = require('../shared/api-client.js');

/* Minimaler Response-Mock in der Form, die der Client benutzt. */
function mockResponse({ ok = true, status = 200, statusText = 'OK', body = '{}', headers = {} }) {
  const lower = {};
  Object.keys(headers).forEach((k) => { lower[k.toLowerCase()] = headers[k]; });
  return {
    ok, status, statusText,
    headers: { get: (name) => (name.toLowerCase() in lower ? lower[name.toLowerCase()] : null) },
    text: async () => body
  };
}

/* Setzt den Client fuer einen Test auf: Sleep wird protokolliert statt
   gewartet, der Throttle wird ausgehebelt. */
function setup(responses) {
  const calls = [];
  const sleeps = [];
  let i = 0;
  ClaudeAPI._resetThrottleForTests();
  ClaudeAPI.configure({
    proxyUrl: 'https://proxy.test/',
    maxPerMin: 1000,
    maxAttempts: 3,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const next = responses[Math.min(i, responses.length - 1)];
      i++;
      if (typeof next === 'function') return next();
      return next;
    }
  });
  return { calls, sleeps };
}

const OK_BODY = JSON.stringify({
  content: [{ type: 'text', text: '{"a":1}' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10 }
});

test('Erfolgsfall: liefert den geparsten Body, genau ein Request', async () => {
  const { calls } = setup([mockResponse({ body: OK_BODY })]);
  const d = await ClaudeAPI.send({ model: 'm', max_tokens: 100 });
  assert.equal(calls.length, 1);
  assert.equal(ClaudeAPI.textOf(d), '{"a":1}');
  assert.equal(ClaudeAPI.isTruncated(d), false);
});

test('HTTP 502 mit HTML: lesbare Meldung statt "Unexpected token <"', async () => {
  setup([mockResponse({
    ok: false, status: 502, statusText: 'Bad Gateway',
    body: '<html><head><title>502</title></head><body><h1>Bad gateway</h1></body></html>'
  })]);
  await assert.rejects(
    () => ClaudeAPI.send({ model: 'm', max_tokens: 100 }),
    (err) => {
      assert.match(err.message, /HTTP 502/);
      assert.ok(!/Unexpected token/.test(err.message), 'darf kein JSON-Parse-Fehler sein');
      assert.match(err.message, /Bad gateway/i, 'Inhalt der Fehlerseite bleibt erkennbar');
      assert.equal(err.status, 502);
      return true;
    }
  );
});

test('HTTP 502 ist retrybar: dritter Versuch gewinnt', async () => {
  const { calls } = setup([
    mockResponse({ ok: false, status: 502, body: 'gateway' }),
    mockResponse({ ok: false, status: 503, body: 'unavailable' }),
    mockResponse({ body: OK_BODY })
  ]);
  const d = await ClaudeAPI.send({ model: 'm', max_tokens: 100 });
  assert.equal(calls.length, 3);
  assert.equal(ClaudeAPI.textOf(d), '{"a":1}');
});

test('HTTP 400 ist NICHT retrybar: genau ein Request', async () => {
  const { calls } = setup([mockResponse({
    ok: false, status: 400,
    body: JSON.stringify({ error: { message: 'max_tokens too large' } })
  })]);
  await assert.rejects(() => ClaudeAPI.send({ model: 'm', max_tokens: 100 }), /max_tokens too large/);
  assert.equal(calls.length, 1, 'ein 400 wird nicht wiederholt');
});

test('429 mit Retry-After: wartet genau die angegebene Zeit', async () => {
  const { sleeps, calls } = setup([
    mockResponse({ ok: false, status: 429, body: '{}', headers: { 'retry-after': '7' } }),
    mockResponse({ body: OK_BODY })
  ]);
  await ClaudeAPI.send({ model: 'm', max_tokens: 100 });
  assert.equal(calls.length, 2);
  assert.ok(sleeps.some((ms) => ms >= 7000 && ms <= 7500), 'Retry-After (7s) hat Vorrang vor Backoff, war: ' + sleeps.join(','));
});

test('429 ohne Retry-After wartet deutlich laenger als ein 2s-Backoff', async () => {
  // Bei 4 Requests/Minute bringt ein 2s-Backoff nichts - das Limit faellt
  // erst mit dem Zeitfenster.
  const { sleeps } = setup([
    mockResponse({ ok: false, status: 429, body: '{}' }),
    mockResponse({ body: OK_BODY })
  ]);
  await ClaudeAPI.send({ model: 'm', max_tokens: 100 });
  assert.ok(sleeps[0] >= 10000, 'erwartet Fenster-Wartezeit, war: ' + sleeps[0]);
});

test('request-id landet in der Fehlermeldung', async () => {
  setup([mockResponse({
    ok: false, status: 400, body: JSON.stringify({ error: { message: 'kaputt' } }),
    headers: { 'request-id': 'req_abc123' }
  })]);
  await assert.rejects(() => ClaudeAPI.send({ model: 'm', max_tokens: 100 }), /req_abc123/);
});

test('Netzwerkfehler wird wiederholt', async () => {
  const { calls } = setup([
    () => { throw new Error('fetch failed'); },
    () => { throw new Error('fetch failed'); },
    mockResponse({ body: OK_BODY })
  ]);
  const d = await ClaudeAPI.send({ model: 'm', max_tokens: 100 });
  assert.equal(calls.length, 3);
  assert.equal(ClaudeAPI.textOf(d), '{"a":1}');
});

test('Timeout wird NICHT wiederholt und meldet die Dauer', async () => {
  const { calls } = setup([() => { const e = new Error('The operation was aborted'); e.name = 'AbortError'; throw e; }]);
  await assert.rejects(
    () => ClaudeAPI.send({ model: 'm', max_tokens: 16000 }),
    (err) => {
      assert.equal(err.timeout, true);
      assert.match(err.message, /Zeitueberschreitung nach 350 s/);
      return true;
    }
  );
  assert.equal(calls.length, 1, 'ein Timeout bei 16k Tokens darf die Wartezeit nicht verdoppeln');
});

test('Fehler im Body bei HTTP 200: rate limit wird wiederholt, anderes nicht', async () => {
  const rl = setup([
    mockResponse({ body: JSON.stringify({ error: { type: 'rate_limit_error', message: 'rate limit exceeded' } }) }),
    mockResponse({ body: OK_BODY })
  ]);
  await ClaudeAPI.send({ model: 'm', max_tokens: 100 });
  assert.equal(rl.calls.length, 2);

  const other = setup([mockResponse({ body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad schema' } }) })]);
  await assert.rejects(() => ClaudeAPI.send({ model: 'm', max_tokens: 100 }), /bad schema/);
  assert.equal(other.calls.length, 1);
});

test('HTTP 200 mit Nicht-JSON: lesbare Meldung', async () => {
  setup([mockResponse({ body: 'Service temporarily unavailable' })]);
  await assert.rejects(() => ClaudeAPI.send({ model: 'm', max_tokens: 100 }), /kein JSON.*Service temporarily unavailable/s);
});

test('isTruncated erkennt stop_reason max_tokens', () => {
  assert.equal(ClaudeAPI.isTruncated({ stop_reason: 'max_tokens' }), true);
  assert.equal(ClaudeAPI.isTruncated({ stop_reason: 'end_turn' }), false);
  assert.equal(ClaudeAPI.isTruncated(null), false);
});

test('Timeout skaliert mit max_tokens statt pauschal zu sein', () => {
  const kurz = ClaudeAPI.timeoutForBody({ max_tokens: 1000 });
  const lang = ClaudeAPI.timeoutForBody({ max_tokens: 16000 });
  assert.ok(lang > kurz * 3, 'ein 16k-Chunk braucht deutlich mehr Zeit als ein 1k-Call');
  assert.ok(lang <= 360000, 'aber gedeckelt');
});

test('onRetry meldet jeden Wiederholversuch an die UI', async () => {
  const seen = [];
  setup([
    mockResponse({ ok: false, status: 503, body: 'x' }),
    mockResponse({ body: OK_BODY })
  ]);
  await ClaudeAPI.send({ model: 'm', max_tokens: 100 }, { onRetry: (n, info) => seen.push({ n, status: info.status }) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].n, 2);
  assert.equal(seen[0].status, 503);
});

/* ---- Verhalten des konkret eingesetzten Cloudflare Workers ----
   Er gibt JEDE Antwort mit HTTP 200 zurueck und verwirft die
   Anthropic-Header (siehe docs/proxy-capabilities.md). Der Body-Fehler-Zweig
   ist damit der einzige, der API-Fehler ueberhaupt sieht. */

test('Worker-Verhalten: 429 als HTTP 200 im Body wird wiederholt', () => {
  // Deckt ab, was der Worker aus einem echten 429 macht
  const { calls } = setup([
    mockResponse({ body: JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit' } }) }),
    mockResponse({ body: OK_BODY })
  ]);
  return ClaudeAPI.send({ model: 'm', max_tokens: 100 }).then(() => {
    assert.equal(calls.length, 2);
  });
});

test('Worker-Verhalten: overloaded (529) wird wiederholt', async () => {
  const { calls } = setup([
    mockResponse({ body: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) }),
    mockResponse({ body: OK_BODY })
  ]);
  await ClaudeAPI.send({ model: 'm', max_tokens: 100 });
  assert.equal(calls.length, 2);
});

test('Worker-Verhalten: api_error (5xx) wird wiederholt', async () => {
  const { calls } = setup([
    mockResponse({ body: JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal server error' } }) }),
    mockResponse({ body: OK_BODY })
  ]);
  await ClaudeAPI.send({ model: 'm', max_tokens: 100 });
  assert.equal(calls.length, 2, 'ein serverseitiger Fehler ist vorruebergehend');
});

test('Worker-Verhalten: invalid_request wird NICHT wiederholt', async () => {
  const { calls } = setup([mockResponse({
    body: JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: must be <= 64000' } })
  })]);
  await assert.rejects(() => ClaudeAPI.send({ model: 'm', max_tokens: 100 }), /max_tokens/);
  assert.equal(calls.length, 1, 'ein Schemafehler aendert sich durch Wiederholung nicht');
});

test('Worker-Verhalten: fehlendes retry-after faellt auf das Fenster zurueck', async () => {
  // Der Worker verwirft die Anthropic-Header - retry-after gibt es nie.
  const { sleeps } = setup([
    mockResponse({ body: JSON.stringify({ error: { type: 'rate_limit_error', message: 'rate limit' } }) }),
    mockResponse({ body: OK_BODY })
  ]);
  await ClaudeAPI.send({ model: 'm', max_tokens: 100 });
  assert.ok(sleeps[0] >= 10000, 'berechnetes Rate-Limit-Fenster statt 2s-Backoff, war: ' + sleeps[0]);
});

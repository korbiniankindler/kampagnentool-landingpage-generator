/* Absicherung von worker/index.js.
   Der Worker wird hier als ES-Modul eingebunden und gegen ein gemocktes
   Anthropic geprueft. Jeder Test entspricht einem Verhalten, das die erste
   Worker-Fassung NICHT hatte - siehe docs/proxy-capabilities.md. */
import test from 'node:test';
import assert from 'node:assert';
import worker, { RateLimiter } from '../worker/index.js';

const mkReq = (body, hdr) => new Request('https://x/', {
  method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, hdr || {}),
  body: JSON.stringify(body)
});
const REQ = () => mkReq({ model: 'm', max_tokens: 10, messages: [] });
const ENV = { ANTHROPIC_KEY: 'sk-test' };

test('HTTP-Status von Anthropic wird durchgereicht', async () => {
  // Die erste Fassung gab JEDE Antwort mit 200 zurueck - ein 429 war fuer
  // den Client nicht als solcher erkennbar.
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), {
    status: 429, headers: { 'content-type': 'application/json' }
  });
  const r = await worker.fetch(REQ(), ENV);
  assert.equal(r.status, 429);
});

test('request-id und retry-after werden weitergegeben und exponiert', async () => {
  globalThis.fetch = async () => new Response('{}', {
    status: 429, headers: { 'request-id': 'req_abc', 'retry-after': '7' }
  });
  const r = await worker.fetch(REQ(), ENV);
  assert.equal(r.headers.get('request-id'), 'req_abc');
  assert.equal(r.headers.get('retry-after'), '7');
  // Ohne Expose-Headers sieht JavaScript im Browser sie trotz Weitergabe nicht
  assert.match(r.headers.get('access-control-expose-headers'), /retry-after/);
  assert.match(r.headers.get('access-control-expose-headers'), /request-id/);
});

test('Body wird unveraendert weitergereicht - neue API-Parameter brauchen keine Worker-Aenderung', async () => {
  let gesendet = null;
  globalThis.fetch = async (url, init) => { gesendet = JSON.parse(init.body); return new Response('{}', { status: 200 }); };
  await worker.fetch(mkReq({ model: 'm', output_config: { format: { type: 'json_schema' } } }), ENV);
  assert.deepEqual(gesendet.output_config, { format: { type: 'json_schema' } });
});

test('anthropic-beta wird durchgereicht, wenn der Client ihn setzt', async () => {
  let hdr = null;
  globalThis.fetch = async (url, init) => { hdr = init.headers; return new Response('{}', { status: 200 }); };
  await worker.fetch(mkReq({ model: 'm' }, { 'anthropic-beta': 'irgendein-beta-2026-01-01' }), ENV);
  assert.equal(hdr['anthropic-beta'], 'irgendein-beta-2026-01-01');
});

test('HTML-Fehlerseite ergibt den echten Status, keinen Worker-500', async () => {
  globalThis.fetch = async () => new Response('<html>502 Bad Gateway</html>', {
    status: 502, headers: { 'content-type': 'text/html' }
  });
  const r = await worker.fetch(REQ(), ENV);
  assert.equal(r.status, 502, 'response.json() haette hier geworfen und im catch einen 500 erzeugt');
});

test('Streaming wird durchgereicht statt gepuffert', async () => {
  globalThis.fetch = async () => new Response('data: {}\n\n', {
    status: 200, headers: { 'content-type': 'text/event-stream' }
  });
  const r = await worker.fetch(mkReq({ model: 'm', stream: true }), ENV);
  assert.equal(r.headers.get('content-type'), 'text/event-stream');
  assert.match(await r.text(), /^data:/);
});

test('Netzwerkfehler zum Upstream ergibt 502, nicht 500', async () => {
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  const r = await worker.fetch(REQ(), ENV);
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(body.error.type, 'proxy_error', 'im Anthropic-Fehlerformat, damit der Client einen Pfad hat');
});

test('optionales Zugriffsgeheimnis', async () => {
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  const geschuetzt = { ...ENV, SHARED_SECRET: 'geheim' };
  assert.equal((await worker.fetch(REQ(), geschuetzt)).status, 401);
  assert.equal((await worker.fetch(mkReq({ model: 'm' }, { 'x-tool-secret': 'geheim' }), geschuetzt)).status, 200);
  // Ohne gesetztes Secret bleibt der Endpunkt offen wie bisher
  assert.equal((await worker.fetch(REQ(), ENV)).status, 200);
});

test('fehlender API-Key und falsche Methode scheitern verstaendlich', async () => {
  assert.equal((await worker.fetch(REQ(), {})).status, 500);
  assert.equal((await worker.fetch(new Request('https://x/', { method: 'GET' }), ENV)).status, 405);
});

test('Preflight beantwortet CORS', async () => {
  const r = await worker.fetch(new Request('https://x/', { method: 'OPTIONS' }), ENV);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('access-control-allow-methods'), /POST/);
});

test('kaputter Request-Body ergibt 400 im Anthropic-Fehlerformat', async () => {
  const r = await worker.fetch(new Request('https://x/', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'kein json'
  }), ENV);
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.type, 'proxy_error');
});

/* ---- Organisationsweites Rate-Limiting ----
   Die Bremse in shared/api-client.js zaehlt nur den eigenen Browser-Tab. Ein
   Reload, ein zweiter Tab oder eine zweite Person umgeht sie vollstaendig.
   Erst der Zaehler hier wird von allen geteilt. */

/* Gemocktes Durable-Object-Binding: EIN Objekt fuer alle Namen, so wie
   idFromName('global') es im Betrieb erzwingt. */
function mkLimiterBinding(limiter) {
  const inst = limiter || new RateLimiter({});
  return {
    idFromName: (n) => n,
    get: () => ({ fetch: (url) => inst.fetch(new Request(url)) })
  };
}

const OK_UPSTREAM = () => { globalThis.fetch = async () => new Response('{}', { status: 200 }); };

test('ohne Binding verhaelt sich der Worker wie bisher', async () => {
  // Der Code laesst sich damit deployen, BEVOR das Binding existiert -
  // kein Stichtag, an dem beides gleichzeitig passen muss.
  OK_UPSTREAM();
  for (let i = 0; i < 20; i++) {
    assert.equal((await worker.fetch(REQ(), ENV)).status, 200);
  }
});

test('der gemeinsame Zaehler bremst ueber Tabs hinweg', async () => {
  OK_UPSTREAM();
  const env = { ...ENV, RATE_LIMITER: mkLimiterBinding(), RATE_LIMIT_PER_MIN: '3' };
  assert.equal((await worker.fetch(REQ(), env)).status, 200);
  assert.equal((await worker.fetch(REQ(), env)).status, 200);
  assert.equal((await worker.fetch(REQ(), env)).status, 200);
  const vierter = await worker.fetch(REQ(), env);
  assert.equal(vierter.status, 429, 'der vierte Request im Fenster muss abgewiesen werden');
});

test('die Abweisung nennt Retry-After und ist als Proxy-Limit erkennbar', async () => {
  OK_UPSTREAM();
  const env = { ...ENV, RATE_LIMITER: mkLimiterBinding(), RATE_LIMIT_PER_MIN: '1' };
  await worker.fetch(REQ(), env);
  const r = await worker.fetch(REQ(), env);
  assert.equal(r.status, 429);
  const wartezeit = parseInt(r.headers.get('retry-after'), 10);
  assert.ok(wartezeit >= 1 && wartezeit <= 60, 'Retry-After: ' + r.headers.get('retry-after'));
  const body = await r.json();
  assert.equal(body.error.type, 'proxy_rate_limit',
    'unterscheidbar von einem Limit der API - sonst sucht man den Fehler bei Anthropic');
  assert.match(body.error.message, /Konto/);
});

test('ein abgewiesener Request erreicht Anthropic nicht', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('{}', { status: 200 }); };
  const env = { ...ENV, RATE_LIMITER: mkLimiterBinding(), RATE_LIMIT_PER_MIN: '1' };
  await worker.fetch(REQ(), env);
  await worker.fetch(REQ(), env);
  assert.equal(calls, 1, 'sonst kostet die Bremse trotzdem Tokens');
});

test('ein unberechtigter Request verbraucht keinen Platz im Fenster', async () => {
  OK_UPSTREAM();
  const env = { ...ENV, SHARED_SECRET: 'geheim', RATE_LIMITER: mkLimiterBinding(), RATE_LIMIT_PER_MIN: '1' };
  assert.equal((await worker.fetch(REQ(), env)).status, 401);
  assert.equal((await worker.fetch(mkReq({ model: 'm' }, { 'x-tool-secret': 'geheim' }), env)).status, 200,
    'sonst sperrt ein Fremdzugriff die Berechtigten aus - genau anders herum als gewollt');
});

test('ein defekter Zaehler laesst durch, statt das Werkzeug lahmzulegen', async () => {
  // Fail open: Ein ungebremster Moment endet schlimmstenfalls in einem 429
  // von Anthropic, den der Client seit jeher behandelt. Ein Rate-Limiter, der
  // bei eigener Stoerung alles blockiert, richtet mehr Schaden an.
  OK_UPSTREAM();
  const kaputt = { idFromName: () => { throw new Error('Durable Object nicht erreichbar'); }, get: () => {} };
  const r = await worker.fetch(REQ(), { ...ENV, RATE_LIMITER: kaputt });
  assert.equal(r.status, 200);
});

test('das Fenster gleitet, statt in festen Minutenbloecken zu springen', async () => {
  // Bei festen Bloecken laufen zehn Requests durch, wenn fuenf am Ende des
  // einen und fuenf am Anfang des naechsten Blocks liegen.
  const limiter = new RateLimiter({});
  const echt = Date.now;
  let jetzt = 1_700_000_000_000;
  Date.now = () => jetzt;
  try {
    const slot = async () => (await limiter.fetch(new Request('https://r/slot?limit=2'))).json();
    assert.equal((await slot()).erlaubt, true);
    assert.equal((await slot()).erlaubt, true);
    assert.equal((await slot()).erlaubt, false);
    jetzt += 59_000;
    assert.equal((await slot()).erlaubt, false, 'innerhalb der Minute bleibt es gesperrt');
    jetzt += 2_000;           // der erste Eintrag faellt aus dem Fenster
    assert.equal((await slot()).erlaubt, true);
  } finally {
    Date.now = echt;
  }
});

test('das Standardlimit entspricht dem Anthropic-Limit von 5 pro Minute', async () => {
  OK_UPSTREAM();
  const env = { ...ENV, RATE_LIMITER: mkLimiterBinding() };   // ohne RATE_LIMIT_PER_MIN
  for (let i = 0; i < 5; i++) assert.equal((await worker.fetch(REQ(), env)).status, 200);
  assert.equal((await worker.fetch(REQ(), env)).status, 429);
});

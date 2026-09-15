/* Absicherung von worker/index.js.
   Der Worker wird hier als ES-Modul eingebunden und gegen ein gemocktes
   Anthropic geprueft. Jeder Test entspricht einem Verhalten, das die erste
   Worker-Fassung NICHT hatte - siehe docs/proxy-capabilities.md. */
import test from 'node:test';
import assert from 'node:assert';
import worker from '../worker/index.js';

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

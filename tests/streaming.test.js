/* Absicherung des SSE-Lesers in shared/api-client.js.

   Der Worker reicht "stream": true seit dem Deploy durch; hier fehlte die
   Gegenseite. Ein selbstgebauter SSE-Leser ist die Art Code, die still falsch
   sein kann: Er liefert Text, und ob der vollstaendig war, sieht man ihm nicht
   an. Die Tests hier decken genau die Stellen ab, an denen das passiert.

   Wire-Format laut API-Referenz:
     event: content_block_delta
     data: {"type":"content_block_delta","index":0,"delta":{...}}
   getrennt durch eine Leerzeile. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const ClaudeAPI = require('../shared/api-client.js');

function ev(type, obj) {
  return 'event: ' + type + '\ndata: ' + JSON.stringify(Object.assign({ type }, obj)) + '\n\n';
}

/* Ein vollstaendiger, wohlgeformter Stream. */
function strom(text, stopReason) {
  return ev('message_start', { message: { id: 'msg_1', role: 'assistant', model: 'm', usage: { input_tokens: 100 } } }) +
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    text.map(t => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } })).join('') +
    ev('content_block_stop', { index: 0 }) +
    ev('message_delta', { delta: { stop_reason: stopReason || 'end_turn' }, usage: { output_tokens: 42 } }) +
    ev('message_stop', {});
}

/* Liest einen Text als Stream ein, in Stuecken beliebiger Groesse. */
function lies(text, stueckGroesse) {
  const acc = ClaudeAPI._createMessageAccumulator();
  const parser = ClaudeAPI._createSSEParser(e => acc.handle(e));
  for (let i = 0; i < text.length; i += (stueckGroesse || text.length)) {
    parser.push(text.slice(i, i + (stueckGroesse || text.length)));
  }
  return { acc, parser };
}

test('Ein vollstaendiger Stream ergibt dieselbe Form wie eine normale Antwort', () => {
  const { acc, parser } = lies(strom(['Hallo ', 'Welt']));
  const d = acc.finish('', parser.rest());
  assert.equal(ClaudeAPI.textOf(d), 'Hallo Welt');
  assert.equal(d.stop_reason, 'end_turn');
  assert.equal(ClaudeAPI.isTruncated(d), false);
  assert.equal(d.usage.output_tokens, 42, 'Output-Tokens aus message_delta');
  assert.equal(d.usage.input_tokens, 100, 'Input-Tokens aus message_start bleiben erhalten');
});

test('Chunk-Grenzen mitten in einer Zeile aendern nichts', () => {
  // Das ist der Normalfall beim Lesen aus einem Netzwerk-Stream, nicht die
  // Ausnahme - und der haeufigste Fehler in selbstgebauten SSE-Lesern.
  const roh = strom(['Der Platz, ', 'der zu Dir ', 'gehoert']);
  const erwartet = 'Der Platz, der zu Dir gehoert';
  [1, 2, 3, 7, 13, 64, 999, roh.length].forEach((n) => {
    const { acc, parser } = lies(roh, n);
    assert.equal(ClaudeAPI.textOf(acc.finish('', parser.rest())), erwartet, 'Stueckgroesse ' + n);
  });
});

test('Ein Abbruch ohne message_stop ist ein FEHLER, kein Teilerfolg', () => {
  // Die Antwort enthaelt Text und sieht brauchbar aus - genau deshalb muss sie
  // scheitern statt still als Erfolg durchzugehen.
  const roh = strom(['Ein halber ', 'Satz']).replace(/event: message_stop[\s\S]*$/, '');
  const { acc, parser } = lies(roh);
  assert.throws(() => acc.finish('', parser.rest()), /brach ab/);
});

test('Ein Abbruch mitten in einem Event wird ebenfalls erkannt', () => {
  const roh = strom(['Text']).slice(0, -40);
  const { acc, parser } = lies(roh);
  assert.throws(() => acc.finish('', parser.rest()), (e) => {
    assert.match(e.message, /brach ab/);
    assert.equal(e.abgebrochen, true);
    return true;
  });
});

test('Der Fehlertext nennt, wie viel schon angekommen war', () => {
  // Ohne diese Angabe ist nicht zu unterscheiden, ob nichts kam oder fast
  // alles - das ist der Unterschied zwischen Proxy-Problem und Token-Limit.
  const roh = strom(['12345678901234567890']).replace(/event: message_stop[\s\S]*$/, '');
  const { acc, parser } = lies(roh);
  assert.throws(() => acc.finish('', parser.rest()), /20 Zeichen/);
});

test('Ein error-Ereignis mitten im Stream schlaegt durch', () => {
  // HTTP-Status war da laengst 200. Ohne diesen Zweig gaelte die halbe
  // Antwort als vollstaendig.
  const roh = ev('message_start', { message: { id: 'm' } }) +
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Anfang' } }) +
    ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } });
  const { acc, parser } = lies(roh);
  assert.throws(() => acc.finish('', parser.rest()), (e) => {
    assert.match(e.message, /Overloaded/);
    assert.equal(e.status, 429, 'Ueberlastung ist wiederholbar');
    assert.equal(e.streamFehler, true);
    return true;
  });
});

test('Ein serverseitiger Fehler im Stream gilt als wiederholbar', () => {
  const roh = ev('message_start', { message: {} }) +
    ev('error', { error: { type: 'api_error', message: 'Internal' } });
  const { acc, parser } = lies(roh);
  assert.throws(() => acc.finish('', parser.rest()), (e) => {
    assert.equal(e.status, 503);
    return true;
  });
});

test('stop_reason max_tokens wird als Truncation erkannt', () => {
  const { acc, parser } = lies(strom(['Zu lang'], 'max_tokens'));
  const d = acc.finish('', parser.rest());
  assert.equal(ClaudeAPI.isTruncated(d), true, 'sonst gilt eine abgeschnittene Seite als fertig');
});

test('Zeilenenden mit \\r\\n werden verstanden', () => {
  // Ein Zwischenproxy darf sie umschreiben; SSE erlaubt beide.
  const roh = strom(['Hallo']).replace(/\n/g, '\r\n');
  const { acc, parser } = lies(roh);
  assert.equal(ClaudeAPI.textOf(acc.finish('', parser.rest())), 'Hallo');
});

test('Mehrere data-Zeilen gehoeren zu EINEM Ereignis', () => {
  // SSE verbindet sie mit Zeilenumbruch. Anthropic sendet praktisch immer
  // eine - ein Parser, der das annimmt, bricht ohne Vorwarnung.
  const teil1 = '{"type":"content_block_delta","index":0,';
  const teil2 = '"delta":{"type":"text_delta","text":"geteilt"}}';
  const roh = ev('message_start', { message: {} }) +
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    'event: content_block_delta\ndata: ' + teil1 + '\ndata: ' + teil2 + '\n\n' +
    ev('message_delta', { delta: { stop_reason: 'end_turn' } }) + ev('message_stop', {});
  const { acc, parser } = lies(roh);
  assert.equal(ClaudeAPI.textOf(acc.finish('', parser.rest())), 'geteilt');
});

test('Keepalive-Kommentare und ping-Ereignisse stoeren nicht', () => {
  const roh = ': keepalive\n\n' + ev('ping', {}) + strom(['Text']);
  const { acc, parser } = lies(roh);
  assert.equal(ClaudeAPI.textOf(acc.finish('', parser.rest())), 'Text');
});

test('Unlesbares JSON in einer data-Zeile bricht den Stream nicht ab', () => {
  // Ein einzelnes kaputtes Ereignis darf nicht den ganzen Lauf kosten; fehlt
  // dadurch Inhalt, faellt es ueber das fehlende message_stop auf.
  const roh = strom(['Anfang']).replace(
    'event: content_block_stop',
    'event: irgendwas\ndata: {kein json\n\nevent: content_block_stop');
  const { acc, parser } = lies(roh);
  assert.equal(ClaudeAPI.textOf(acc.finish('', parser.rest())), 'Anfang');
});

test('Mehrere Content-Bloecke bleiben in ihrer Reihenfolge', () => {
  const roh = ev('message_start', { message: {} }) +
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'A' } }) +
    ev('content_block_stop', { index: 0 }) +
    ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'B' } }) +
    ev('message_delta', { delta: { stop_reason: 'end_turn' } }) + ev('message_stop', {});
  const { acc, parser } = lies(roh);
  assert.equal(ClaudeAPI.textOf(acc.finish('', parser.rest())), 'AB');
});

test('onText meldet jedes Stueck einzeln an die Oberflaeche', () => {
  const gesehen = [];
  const acc = ClaudeAPI._createMessageAccumulator();
  const parser = ClaudeAPI._createSSEParser(e => acc.handle(e, t => gesehen.push(t)));
  parser.push(strom(['eins', 'zwei', 'drei']));
  acc.finish('', parser.rest());
  assert.deepEqual(gesehen, ['eins', 'zwei', 'drei']);
});

/* ---------- Transport: sendStream ---------- */

/* Ein Response-Mock mit lesbarem Body, so wie fetch ihn liefert. */
function streamResponse(text, { ok = true, status = 200, headers = {}, stuecke = 3 } = {}) {
  const enc = new TextEncoder();
  const teile = [];
  const n = Math.ceil(text.length / stuecke);
  for (let i = 0; i < text.length; i += n) teile.push(enc.encode(text.slice(i, i + n)));
  let i = 0;
  const lower = {};
  Object.keys(headers).forEach(k => { lower[k.toLowerCase()] = headers[k]; });
  return {
    ok, status, statusText: '',
    headers: { get: (nm) => (nm.toLowerCase() in lower ? lower[nm.toLowerCase()] : null) },
    text: async () => text,
    body: { getReader: () => ({ read: async () => (i < teile.length ? { done: false, value: teile[i++] } : { done: true }) }) }
  };
}

function setupStream(responses) {
  const calls = [], sleeps = [];
  let i = 0;
  ClaudeAPI._resetThrottleForTests();
  ClaudeAPI.configure({
    proxyUrl: 'https://proxy.test/', maxPerMin: 1000, maxAttempts: 3,
    sleepImpl: async (ms) => { sleeps.push(ms); },
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      const next = responses[Math.min(i, responses.length - 1)];
      i++;
      if (typeof next === 'function') return next();
      return next;
    }
  });
  return { calls, sleeps };
}

test('sendStream setzt stream:true und liefert die fertige Antwort', async () => {
  const { calls } = setupStream([streamResponse(strom(['Hallo ', 'Welt']))]);
  const d = await ClaudeAPI.sendStream({ model: 'm', max_tokens: 64000 });
  assert.equal(calls[0].stream, true);
  assert.equal(ClaudeAPI.textOf(d), 'Hallo Welt');
  assert.equal(d._gestreamt, true);
});

test('sendStream aendert den uebergebenen Body nicht', async () => {
  // Der Aufrufer nutzt denselben Body evtl. fuer einen zweiten, ungestreamten
  // Versuch - ein hineinmutiertes stream:true waere dort ein Fehler.
  setupStream([streamResponse(strom(['x']))]);
  const body = { model: 'm', max_tokens: 100 };
  await ClaudeAPI.sendStream(body);
  assert.ok(!('stream' in body));
});

test('Ein abgebrochener Stream wird NICHT als Erfolg gemeldet', async () => {
  const halb = strom(['Ein halber Satz']).replace(/event: message_stop[\s\S]*$/, '');
  setupStream([streamResponse(halb)]);
  await assert.rejects(() => ClaudeAPI.sendStream({ model: 'm' }), /brach ab/);
});

test('Ein HTTP-Fehler VOR dem Stream wird wiederholt', async () => {
  const { calls } = setupStream([
    streamResponse('{"error":{"type":"overloaded_error"}}', { ok: false, status: 529 }),
    streamResponse(strom(['ok']))
  ]);
  const d = await ClaudeAPI.sendStream({ model: 'm' });
  assert.equal(calls.length, 2);
  assert.equal(ClaudeAPI.textOf(d), 'ok');
});

test('Ein HTTP 400 wird nicht wiederholt', async () => {
  const { calls } = setupStream([streamResponse(
    '{"error":{"type":"invalid_request_error","message":"max_tokens zu gross"}}',
    { ok: false, status: 400 })]);
  await assert.rejects(() => ClaudeAPI.sendStream({ model: 'm' }), /max_tokens zu gross/);
  assert.equal(calls.length, 1);
});

test('Nach dem ersten Token wird NICHT mehr wiederholt', async () => {
  /* Ein Retry waere hier eine vollstaendige zweite Generierung: doppelte
     Kosten, und der Nutzer sieht seinen Text von vorn beginnen. */
  const halb = strom(['schon sichtbarer Text']).replace(/event: message_stop[\s\S]*$/, '');
  const { calls } = setupStream([streamResponse(halb), streamResponse(strom(['zweiter Versuch']))]);
  await assert.rejects(() => ClaudeAPI.sendStream({ model: 'm' }), /brach ab/);
  assert.equal(calls.length, 1, 'genau ein Request, obwohl maxAttempts 3 ist');
});

test('Ein Fehler im Stream nach Textbeginn wird ebenfalls nicht wiederholt', async () => {
  const roh = ev('message_start', { message: {} }) +
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Anfang' } }) +
    ev('error', { error: { type: 'overloaded_error', message: 'Overloaded' } });
  const { calls } = setupStream([streamResponse(roh), streamResponse(strom(['neu']))]);
  await assert.rejects(() => ClaudeAPI.sendStream({ model: 'm' }), /Overloaded/);
  assert.equal(calls.length, 1);
});

test('Ein Proxy ohne lesbaren Body scheitert verstaendlich', async () => {
  // Eine alte Worker-Fassung puffert und liefert JSON statt eines Streams.
  setupStream([{ ok: true, status: 200, headers: { get: () => null }, text: async () => '{}' }]);
  await assert.rejects(() => ClaudeAPI.sendStream({ model: 'm' }), /keinen lesbaren Stream/);
});

test('onText erreicht die Oberflaeche waehrend des Laufs', async () => {
  setupStream([streamResponse(strom(['a', 'b', 'c']))]);
  const gesehen = [];
  await ClaudeAPI.sendStream({ model: 'm' }, { onText: t => gesehen.push(t) });
  assert.deepEqual(gesehen, ['a', 'b', 'c']);
});

test('Die request-id landet auch am gestreamten Ergebnis', async () => {
  setupStream([streamResponse(strom(['x']), { headers: { 'request-id': 'req_stream1' } })]);
  const d = await ClaudeAPI.sendStream({ model: 'm' });
  assert.equal(d._requestId, 'req_stream1');
});

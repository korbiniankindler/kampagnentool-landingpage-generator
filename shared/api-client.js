/* Gemeinsamer Claude-Client fuer Modul 1 und Modul 2.

   Vorher existierte diese Logik in beiden Modul-HTMLs wortgleich, und beide
   Kopien hatten dieselben Luecken:
   - kein resp.ok-Check: ein 502 mit Cloudflare-HTML lief in resp.json() und
     erschien dem Nutzer als "Unexpected token '<'"
   - kein Timeout: ein haengender Request blockierte die Seite unbegrenzt
   - Retry nur bei Rate-Limit, erkannt per String-Matching im Fehlertext
   - feste 14s Wartezeit, kein Retry-After, kein Backoff
   - keine request-id in der Fehlermeldung

   Zum eingesetzten Proxy (worker/index.js, docs/proxy-capabilities.md): Seit
   dem Deploy der ueberarbeiteten Fassung reicht er den HTTP-Status von
   Anthropic durch und gibt `request-id`, `retry-after` und die Rate-Limit-
   Header frei (Access-Control-Expose-Headers). Damit ist der `resp.ok`-Zweig
   der Hauptpfad fuer API-Fehler: 429 kommt als 429 an, `retry-after` wird
   tatsaechlich befolgt statt geschaetzt, und jede Fehlermeldung traegt die
   request-id.

   Der Body-Fehler-Zweig weiter unten bleibt trotzdem bestehen. Er ist kein
   toter Code: Ein Browser mit gecachter Preflight-Antwort, ein Rollback auf
   die alte Worker-Fassung oder ein zwischengeschalteter Proxy, der Status
   normalisiert, liefern weiterhin 200 mit Fehler-Body. Faellt dieser Zweig
   weg, wird so ein Fehler still als Erfolg geparst - genau das Fehlerbild,
   das Phase 0 beseitigt hat.

   WICHTIG zum Rate-Limiting: Der Throttle unten ist eine HOEFLICHKEITSBREMSE
   pro Browser-Tab, keine organisationsweite Garantie. Ein Reload, ein zweiter
   Tab oder ein zweiter Mitarbeiter umgeht ihn vollstaendig. Echtes
   organisationsweites Limiting gehoert in den Proxy - siehe
   docs/proxy-capabilities.md. Der Throttle bleibt, weil er die Zahl der
   vermeidbaren 429er real senkt; er darf nur nicht als Garantie gelesen
   werden. */
var ClaudeAPI = (function () {
  'use strict';

  var cfg = {
    proxyUrl: null,
    maxPerMin: 4,          // Sicherheitsmarge unter dem Org-Limit von 5
    windowMs: 61000,
    maxAttempts: 3,
    fetchImpl: (typeof fetch !== 'undefined') ? fetch.bind(typeof globalThis !== 'undefined' ? globalThis : null) : null,
    sleepImpl: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); },
    nowImpl: function () { return Date.now(); }
  };

  var _timestamps = [];
  /* Vom Server gemeldeter Zustand des ORGANISATIONSWEITEN Limits, gefuellt aus
     den anthropic-ratelimit-*-Headern. Der lokale Zaehler oben sieht nur den
     eigenen Tab; diese Angabe sieht das ganze Konto. Sie ersetzt keinen
     serverseitigen Zaehler (siehe docs/proxy-capabilities.md), macht den
     Throttle aber von einer reinen Schaetzung zu einer Beobachtung. */
  var _limitZustand = { remaining: null, resetAt: null };

  function configure(opts) {
    Object.keys(opts || {}).forEach(function (k) { cfg[k] = opts[k]; });
  }

  /* Timeout je Call statt pauschal: ein Chunk mit max_tokens 16000 laeuft
     ungestreamt deutlich laenger als ein Section-Vorschlag mit 1000. Ein
     pauschaler Wert ist entweder fuer den einen zu kurz oder fuer den
     anderen sinnlos lang. Grundlast + grosszuegige Reserve pro Output-Token,
     gedeckelt, damit ein haengender Proxy nicht ewig blockiert. */
  function timeoutForBody(body) {
    var maxTokens = (body && body.max_tokens) || 4000;
    return Math.min(360000, 30000 + maxTokens * 20);
  }

  function isRetryableStatus(status) {
    return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  }

  /* Wartezeit nach einem fehlgeschlagenen Versuch, in dieser Reihenfolge:
     1. Retry-After des Servers (Sekunden oder HTTP-Datum) - der Server weiss
        es am besten.
     2. Bei 429 ohne Retry-After: bis das aelteste Request im Zeitfenster
        herausfaellt. Bei 4 Requests/Minute ist ein 2s-Backoff sinnlos, weil
        das Limit erst mit dem Fenster faellt.
     3. Sonst exponentiell mit Jitter. */
  function retryDelayMs(status, retryAfterHeader, attempt) {
    if (retryAfterHeader) {
      var secs = parseInt(retryAfterHeader, 10);
      if (!isNaN(secs) && secs >= 0) return Math.min(secs * 1000 + 250, 120000);
      var when = Date.parse(retryAfterHeader);
      if (!isNaN(when)) return Math.min(Math.max(when - cfg.nowImpl(), 0) + 250, 120000);
    }
    if (status === 429) {
      /* Der Server nennt den Zeitpunkt, zu dem das Fenster faellt. Das ist
         praeziser als der lokale Zaehler, weil es auch die Requests anderer
         Tabs und Mitarbeiter beruecksichtigt. */
      if (_limitZustand.resetAt) {
        var bisReset = _limitZustand.resetAt - cfg.nowImpl() + 500;
        if (bisReset > 0) return Math.min(bisReset, 120000);
      }
      var oldest = _timestamps.length ? _timestamps[0] : null;
      if (oldest !== null) {
        var wait = cfg.windowMs - (cfg.nowImpl() - oldest) + 500;
        if (wait > 0) return Math.min(wait, 120000);
      }
      return 15000;
    }
    var base = Math.pow(2, attempt) * 1000;          // 2s, 4s, 8s
    return Math.min(base + Math.random() * 1000, 30000);
  }

  async function throttle() {
    var now = cfg.nowImpl();
    /* Hat der Server zuletzt "0 uebrig" gemeldet, ist ein weiterer Request
       garantiert ein 429 - unabhaengig davon, was der lokale Zaehler glaubt.
       Dann lieber gleich bis zum Reset warten, statt den Fehlversuch zu
       provozieren. */
    if (_limitZustand.remaining === 0 && _limitZustand.resetAt && _limitZustand.resetAt > now) {
      await cfg.sleepImpl(Math.min(_limitZustand.resetAt - now + 500, 120000));
      _limitZustand.remaining = null;
      now = cfg.nowImpl();
    }
    _timestamps = _timestamps.filter(function (t) { return now - t < cfg.windowMs; });
    if (_timestamps.length >= cfg.maxPerMin) {
      var oldest = _timestamps[0];
      await cfg.sleepImpl(cfg.windowMs - (now - oldest) + 250);
      return throttle();
    }
    _timestamps.push(cfg.nowImpl());
  }

  function apiError(message, extra) {
    var e = new Error(message);
    Object.keys(extra || {}).forEach(function (k) { e[k] = extra[k]; });
    return e;
  }

  /* Haengt die request-id an die Fehlermeldung, damit ein Nutzer sie beim
     Melden mitschicken kann - ohne sie ist ein Proxy-Fehler nicht nachverfolgbar. */
  function withRequestId(message, requestId) {
    return requestId ? message + ' (request-id: ' + requestId + ')' : message;
  }

  /* Liest die Rate-Limit-Header, die der Worker seit der ueberarbeiteten
     Fassung durchreicht. Fehlen sie (alte Worker-Fassung, anderer Proxy),
     bleibt der Zustand unveraendert und es greift weiter die lokale
     Schaetzung - deshalb wird hier nichts zurueckgesetzt. */
  function merkeLimitZustand(headers) {
    if (!headers || !headers.get) return;
    try {
      var rem = headers.get('anthropic-ratelimit-requests-remaining');
      if (rem !== null && rem !== '' && !isNaN(parseInt(rem, 10))) _limitZustand.remaining = parseInt(rem, 10);
      var reset = headers.get('anthropic-ratelimit-requests-reset');
      if (reset) {
        var t = Date.parse(reset);
        if (!isNaN(t)) _limitZustand.resetAt = t;
      }
    } catch (e) { /* Header nicht lesbar - lokale Schaetzung bleibt gueltig */ }
  }

  /* Ein Claude-Request. Liefert den geparsten Antwort-Body.
     opts:
       onRetry(attempt, info)  Rueckmeldung an die UI vor jedem Wiederholversuch
       timeoutMs               ueberschreibt die Ableitung aus max_tokens
       maxAttempts             ueberschreibt cfg.maxAttempts
       label                   erscheint in Fehlermeldungen ("Hero, Trust Bar") */
  async function send(body, opts) {
    opts = opts || {};
    if (!cfg.proxyUrl) throw apiError('ClaudeAPI ist nicht konfiguriert (proxyUrl fehlt).');
    var maxAttempts = opts.maxAttempts || cfg.maxAttempts;
    var timeoutMs = opts.timeoutMs || timeoutForBody(body);
    var label = opts.label ? ' [' + opts.label + ']' : '';
    var lastErr = null;

    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        var delay = retryDelayMs(lastErr && lastErr.status, lastErr && lastErr.retryAfter, attempt - 1);
        if (opts.onRetry) opts.onRetry(attempt, { reason: lastErr && lastErr.message, waitMs: delay, status: lastErr && lastErr.status });
        await cfg.sleepImpl(delay);
      }
      await throttle();

      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
      var resp;
      try {
        resp = await cfg.fetchImpl(cfg.proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller ? controller.signal : undefined
        });
      } catch (netErr) {
        if (timer) clearTimeout(timer);
        var aborted = netErr && (netErr.name === 'AbortError' || /abort/i.test(netErr.message || ''));
        if (aborted) {
          /* Timeout wird bewusst NICHT wiederholt: bei max_tokens 16000 wuerde
             ein zweiter Versuch die Wartezeit des Nutzers verdoppeln, ohne dass
             sich an der Ursache (zu langer ungestreamter Request) etwas aendert. */
          throw apiError('Zeitueberschreitung nach ' + Math.round(timeoutMs / 1000) + ' s' + label +
            '. Die Antwort war zu lang oder der Proxy antwortet nicht.', { status: 0, timeout: true, attempts: attempt });
        }
        lastErr = apiError('Netzwerkfehler' + label + ': ' + (netErr && netErr.message ? netErr.message : 'unbekannt'),
          { status: 0, network: true });
        if (attempt === maxAttempts) throw apiError(lastErr.message + ' (nach ' + maxAttempts + ' Versuchen)',
          { status: 0, network: true, attempts: attempt });
        continue;
      }
      if (timer) clearTimeout(timer);

      var requestId = null;
      try { requestId = resp.headers && resp.headers.get ? (resp.headers.get('request-id') || resp.headers.get('x-request-id')) : null; } catch (e) {}
      var retryAfter = null;
      try { retryAfter = resp.headers && resp.headers.get ? resp.headers.get('retry-after') : null; } catch (e) {}
      merkeLimitZustand(resp.headers);

      var rawText = '';
      try { rawText = await resp.text(); } catch (e) { rawText = ''; }

      /* HTTP-Status ZUERST. Vorher lief jede Antwort direkt in resp.json() -
         eine Cloudflare-Fehlerseite wurde damit zu "Unexpected token '<'". */
      if (!resp.ok) {
        var detail = '';
        try {
          var errJson = JSON.parse(rawText);
          detail = (errJson && errJson.error && errJson.error.message) ? errJson.error.message : '';
        } catch (e) {
          detail = rawText ? rawText.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : '';
        }
        var msg = 'HTTP ' + resp.status + (resp.statusText ? ' ' + resp.statusText : '') + label +
          (detail ? ': ' + detail : '');
        lastErr = apiError(withRequestId(msg, requestId), { status: resp.status, requestId: requestId, retryAfter: retryAfter });
        if (!isRetryableStatus(resp.status) || attempt === maxAttempts) {
          throw apiError(withRequestId(msg, requestId) + (attempt > 1 ? ' (nach ' + attempt + ' Versuchen)' : ''),
            { status: resp.status, requestId: requestId, attempts: attempt });
        }
        continue;
      }

      var data;
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        throw apiError(withRequestId('Antwort des Proxys ist kein JSON' + label + ': ' +
          rawText.replace(/\s+/g, ' ').trim().slice(0, 200), requestId), { status: resp.status, requestId: requestId, attempts: attempt });
      }

      /* Fehler-Body trotz HTTP 200. Mit der aktuellen Worker-Fassung sollte
         das nicht mehr vorkommen (der Status wird durchgereicht), aber ein
         Rollback oder ein statusnormalisierender Zwischenproxy fuehrt genau
         hierher. Ohne diesen Zweig wuerde so eine Antwort still als Erfolg
         durchgehen und der Aufrufer fiele erst beim Parsen des fehlenden
         `content` um - mit einer Fehlermeldung, die nichts mit der Ursache
         zu tun hat. Die Retry-Erkennung bleibt deshalb vollstaendig. */
      if (data && data.error) {
        var errText = JSON.stringify(data.error);
        var bodyMsg = (data.error.message || data.error.type || 'Unbekannter API-Fehler') + label;
        /* Voruebergehend und damit wiederholbar: Rate-Limit, Ueberlastung
           (529 overloaded_error) und serverseitige Fehler (api_error, 5xx).
           NICHT wiederholbar: invalid_request_error, authentication_error,
           permission_error - die aendern sich durch einen zweiten Versuch nicht. */
        var retrybar = /rate.?limit|overloaded|529|\bapi_error\b|timeout|\b5\d\d\b/i.test(errText);
        lastErr = apiError(withRequestId(bodyMsg, requestId), {
          status: /rate.?limit|overloaded|529/i.test(errText) ? 429 : (retrybar ? 503 : 400),
          requestId: requestId, retryAfter: retryAfter
        });
        if (!retrybar || attempt === maxAttempts) {
          throw apiError(withRequestId(bodyMsg, requestId) + (attempt > 1 ? ' (nach ' + attempt + ' Versuchen)' : ''),
            { status: lastErr.status, requestId: requestId, attempts: attempt });
        }
        continue;
      }

      if (data && data.usage) console.log('Claude usage:', JSON.stringify(data.usage));
      if (requestId) data._requestId = requestId;
      return data;
    }
    throw lastErr || apiError('Request fehlgeschlagen' + label);
  }

  /* ---------- Server-Sent Events ----------

     Antworten mit "stream": true kommen als SSE. Der Worker reicht sie seit
     dem Deploy unveraendert durch (worker/index.js); hier fehlte bisher die
     Gegenseite.

     Warum von Hand und nicht mit dem Anthropic-SDK: Das Tool ist eine
     statische Seite ohne Build-Schritt, ohne npm zur Laufzeit und laeuft auch
     per file://. Ein SDK ist hier nicht einsetzbar - deshalb rohes SSE, aber
     gekapselt und einzeln getestet.

     Wire-Format (event-Zeile, data-Zeile, Leerzeile als Trenner):

       event: content_block_delta
       data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hallo"}}

     Der Parser ist eine Zustandsmaschine ueber Chunks, weil ein Chunk
     JEDERZEIT mitten in einer Zeile enden kann - das ist der Normalfall, nicht
     die Ausnahme, und der haeufigste Fehler in selbstgebauten SSE-Lesern. */
  function createSSEParser(onEvent) {
    var puffer = '';
    return {
      /* Nimmt ein Stueck Text entgegen und ruft onEvent fuer jedes
         vollstaendige Event. Unvollstaendiges bleibt im Puffer. */
      push: function (chunk) {
        puffer += chunk;
        /* \r\n normalisieren: SSE erlaubt beide Zeilenenden, und ein
           Zwischenproxy kann sie umschreiben. */
        puffer = puffer.replace(/\r\n/g, '\n');
        var teile = puffer.split('\n\n');
        puffer = teile.pop();          // der Rest ist angefangen
        teile.forEach(function (block) {
          var daten = [];
          block.split('\n').forEach(function (zeile) {
            /* Nur das data-Feld traegt Inhalt. Die event-Zeile wiederholt,
               was ohnehin im JSON unter `type` steht - sie zu ignorieren
               vermeidet zwei Quellen fuer dieselbe Wahrheit.
               Ein Kommentar (":" am Zeilenanfang, von manchen Proxys als
               Keepalive gesendet) wird ebenso uebergangen. */
            if (zeile.indexOf('data:') !== 0) return;
            daten.push(zeile.slice(5).replace(/^ /, ''));
          });
          if (!daten.length) return;
          /* Mehrere data-Zeilen gehoeren laut SSE zu EINEM Wert, verbunden
             mit Zeilenumbruch. Anthropic sendet praktisch immer eine, aber
             ein Parser, der das annimmt, bricht ohne Vorwarnung. */
          var roh = daten.join('\n');
          var ev;
          try { ev = JSON.parse(roh); } catch (e) { return; }
          onEvent(ev);
        });
      },
      /* Nach dem Ende des Streams: Bleibt etwas im Puffer, war das Event
         unvollstaendig - der Stream ist also abgebrochen. */
      rest: function () { return puffer; }
    };
  }

  /* Baut aus den Events wieder eine Antwort in der Form, die send() liefert.
     Damit funktionieren textOf() und isTruncated() unveraendert und kein
     Aufrufer muss zwischen gestreamt und ungestreamt unterscheiden. */
  function createMessageAccumulator() {
    var nachricht = null;
    var bloecke = [];
    var fertig = false;
    var fehler = null;

    return {
      handle: function (ev, onText) {
        if (!ev || !ev.type) return;
        if (ev.type === 'error') {
          /* Ein Fehler MITTEN im Stream: Ueberlastung, Timeout serverseitig.
             HTTP-Status war da laengst 200 - ohne diesen Zweig gaelte die
             halbe Antwort als vollstaendig. */
          fehler = (ev.error && (ev.error.message || ev.error.type)) || 'Fehler im Stream';
          fehler = { message: fehler, type: (ev.error && ev.error.type) || 'api_error' };
          return;
        }
        if (ev.type === 'message_start' && ev.message) {
          nachricht = Object.assign({}, ev.message);
          bloecke = [];
          return;
        }
        if (ev.type === 'content_block_start') {
          bloecke[ev.index] = Object.assign({ text: '' }, ev.content_block || {});
          return;
        }
        if (ev.type === 'content_block_delta' && ev.delta) {
          var b = bloecke[ev.index] || (bloecke[ev.index] = { type: 'text', text: '' });
          if (ev.delta.type === 'text_delta') {
            b.text = (b.text || '') + ev.delta.text;
            if (onText) onText(ev.delta.text);
          } else if (ev.delta.type === 'input_json_delta') {
            b.partial_json = (b.partial_json || '') + ev.delta.partial_json;
          }
          return;
        }
        if (ev.type === 'message_delta') {
          if (!nachricht) nachricht = {};
          if (ev.delta) Object.keys(ev.delta).forEach(function (k) { nachricht[k] = ev.delta[k]; });
          /* usage kommt hier mit den Output-Tokens; die Input-Tokens standen
             schon in message_start. Zusammenfuehren statt ersetzen. */
          if (ev.usage) nachricht.usage = Object.assign({}, nachricht.usage || {}, ev.usage);
          return;
        }
        if (ev.type === 'message_stop') { fertig = true; }
      },
      /* Liefert die fertige Antwort - oder wirft, wenn der Stream nicht
         sauber zu Ende kam. */
      finish: function (label, restImPuffer) {
        if (fehler) {
          throw apiError((fehler.message || 'Fehler im Stream') + label, {
            status: /rate.?limit|overloaded/i.test(fehler.type + ' ' + fehler.message) ? 429 : 503,
            streamFehler: true
          });
        }
        /* OHNE message_stop ist die Antwort abgebrochen. Sie enthaelt dann
           Text und sieht brauchbar aus - genau deshalb muss sie hier
           scheitern statt still als Erfolg durchzugehen. Dasselbe Prinzip wie
           bei der Truncation-Erkennung in shared/json-extract.js. */
        if (!fertig) {
          throw apiError('Die Antwort brach ab, bevor sie fertig war' + label +
            '. Bisher empfangen: ' + bloecke.reduce(function (n, b) { return n + ((b && b.text) || '').length; }, 0) +
            ' Zeichen.' + (restImPuffer ? ' Letztes Ereignis unvollstaendig.' : ''),
            { status: 0, abgebrochen: true });
        }
        var out = nachricht || {};
        out.content = bloecke.filter(Boolean);
        out._gestreamt = true;
        return out;
      }
    };
  }

  /* Ein gestreamter Claude-Request.

     Drei Entscheidungen, die ihn von send() unterscheiden:

     1. INAKTIVITAETS-Timeout statt Gesamt-Timeout. Ein Stream, der fliesst,
        darf beliebig lange laufen - genau dafuer ist er da. Abgebrochen wird
        nur, wenn laengere Zeit nichts mehr ankommt. Ein Gesamt-Timeout wuerde
        den Zweck des Streamings aufheben.

     2. Wiederholt wird nur, solange noch KEIN Text geflossen ist. Danach
        waere ein Retry eine vollstaendige zweite Generierung - er kostet das
        Doppelte und verwirft, was der Nutzer schon gesehen hat.

     3. Der Rueckgabewert hat dieselbe Form wie bei send(). */
  async function sendStream(body, opts) {
    opts = opts || {};
    if (!cfg.proxyUrl) throw apiError('ClaudeAPI ist nicht konfiguriert (proxyUrl fehlt).');
    var maxAttempts = opts.maxAttempts || cfg.maxAttempts;
    var stilleMs = opts.stilleMs || 120000;
    var label = opts.label ? ' [' + opts.label + ']' : '';
    var mitStream = Object.assign({}, body, { stream: true });
    var lastErr = null;

    for (var attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        var delay = retryDelayMs(lastErr && lastErr.status, lastErr && lastErr.retryAfter, attempt - 1);
        if (opts.onRetry) opts.onRetry(attempt, { reason: lastErr && lastErr.message, waitMs: delay, status: lastErr && lastErr.status });
        await cfg.sleepImpl(delay);
      }
      await throttle();

      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = null;
      var etwasEmpfangen = false;
      function stilleNeuStarten() {
        if (!controller) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () { controller.abort(); }, stilleMs);
      }

      try {
        stilleNeuStarten();
        var resp = await cfg.fetchImpl(cfg.proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
          body: JSON.stringify(mitStream),
          signal: controller ? controller.signal : undefined
        });
        merkeLimitZustand(resp.headers);
        var requestId = null;
        try { requestId = resp.headers && resp.headers.get ? resp.headers.get('request-id') : null; } catch (e) {}

        if (!resp.ok) {
          var text = '';
          try { text = await resp.text(); } catch (e) {}
          var detail = '';
          try { detail = (JSON.parse(text).error || {}).message || ''; } catch (e) {
            detail = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
          }
          var msg = 'HTTP ' + resp.status + label + (detail ? ': ' + detail : '');
          var retryAfter = null;
          try { retryAfter = resp.headers.get('retry-after'); } catch (e) {}
          lastErr = apiError(withRequestId(msg, requestId), { status: resp.status, requestId: requestId, retryAfter: retryAfter });
          if (!isRetryableStatus(resp.status) || attempt === maxAttempts) throw lastErr;
          continue;
        }
        if (!resp.body || !resp.body.getReader) {
          throw apiError('Der Proxy liefert keinen lesbaren Stream' + label + '.', { status: 0 });
        }

        var acc = createMessageAccumulator();
        var parser = createSSEParser(function (ev) { acc.handle(ev, opts.onText); });
        var reader = resp.body.getReader();
        var decoder = (typeof TextDecoder !== 'undefined') ? new TextDecoder() : null;

        while (true) {
          var st = await reader.read();
          if (st.done) break;
          etwasEmpfangen = true;
          stilleNeuStarten();
          parser.push(decoder ? decoder.decode(st.value, { stream: true }) : String(st.value));
        }
        var data = acc.finish(label, parser.rest());
        if (requestId) data._requestId = requestId;
        if (data.usage) console.log('Claude usage (stream):', JSON.stringify(data.usage));
        return data;

      } catch (e) {
        var abgebrochen = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
        if (abgebrochen) {
          throw apiError('Der Stream lieferte ' + Math.round(stilleMs / 1000) + ' s lang keine Daten mehr' +
            label + '.', { status: 0, timeout: true, attempts: attempt });
        }
        /* Nach dem ersten Token nicht mehr wiederholen (Entscheidung 2). */
        if (etwasEmpfangen || attempt === maxAttempts || !isRetryableStatus(e.status || 0)) throw e;
        lastErr = e;
      } finally {
        /* In finally, nicht in den einzelnen Zweigen: Der `continue` beim
           wiederholbaren HTTP-Fehler uebersprang das Aufraeumen, und der
           Inaktivitaets-Timer lief zwei Minuten weiter - er haette danach
           einen laengst abgeschlossenen Request abgebrochen. Aufgefallen,
           weil der Testlauf nicht mehr terminierte. */
        if (timer) clearTimeout(timer);
      }
    }
    throw lastErr || apiError('Stream fehlgeschlagen' + label);
  }

  /* Text aller Textbloecke einer Antwort, wie beide Module ihn brauchen. */
  function textOf(data) {
    if (!data || !Array.isArray(data.content)) return '';
    return data.content.map(function (b) { return b.text || ''; }).join('');
  }

  function isTruncated(data) {
    return !!(data && data.stop_reason === 'max_tokens');
  }

  /* Erkennt, ob ein Fehler daher kommt, dass der Proxy oder die API
     output_config nicht akzeptiert. Dann laesst sich derselbe Request ohne
     Schemabindung wiederholen, statt den Nutzer scheitern zu lassen. */
  function istSchemaAbgelehnt(err) {
    if (!err || !err.message) return false;
    return /output_config|json_schema|unexpected (parameter|keyword)|unrecognized (request )?(argument|field)/i.test(err.message);
  }

  /* Request mit Structured Outputs, mit automatischem Rueckfall.
     `body.output_config` wird beim Rueckfall entfernt und der Request
     unveraendert wiederholt; `onFallback` meldet das dem Aufrufer, damit es
     nicht still passiert. */
  async function sendMitSchema(body, outputConfig, opts) {
    opts = opts || {};
    if (!outputConfig) return send(body, opts);
    var mitSchema = Object.assign({}, body, { output_config: outputConfig });
    try {
      var d = await send(mitSchema, opts);
      d._schemaGenutzt = true;
      return d;
    } catch (e) {
      if (!istSchemaAbgelehnt(e)) throw e;
      if (opts.onFallback) opts.onFallback(e);
      console.warn('Structured Outputs abgelehnt, Wiederholung ohne Schema:', e.message);
      var d2 = await send(body, opts);
      d2._schemaGenutzt = false;
      return d2;
    }
  }

  function _resetThrottleForTests() { _timestamps = []; _limitZustand = { remaining: null, resetAt: null }; }

  return {
    configure: configure,
    send: send,
    sendStream: sendStream,
    sendMitSchema: sendMitSchema,
    _createSSEParser: createSSEParser,
    _createMessageAccumulator: createMessageAccumulator,
    istSchemaAbgelehnt: istSchemaAbgelehnt,
    textOf: textOf,
    isTruncated: isTruncated,
    timeoutForBody: timeoutForBody,
    retryDelayMs: retryDelayMs,
    _limitZustandForTests: function () { return _limitZustand; },
    _resetThrottleForTests: _resetThrottleForTests
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ClaudeAPI;

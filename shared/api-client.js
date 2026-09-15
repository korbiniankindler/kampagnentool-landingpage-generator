/* Gemeinsamer Claude-Client fuer Modul 1 und Modul 2.

   Vorher existierte diese Logik in beiden Modul-HTMLs wortgleich, und beide
   Kopien hatten dieselben Luecken:
   - kein resp.ok-Check: ein 502 mit Cloudflare-HTML lief in resp.json() und
     erschien dem Nutzer als "Unexpected token '<'"
   - kein Timeout: ein haengender Request blockierte die Seite unbegrenzt
   - Retry nur bei Rate-Limit, erkannt per String-Matching im Fehlertext
   - feste 14s Wartezeit, kein Retry-After, kein Backoff
   - keine request-id in der Fehlermeldung

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

      /* Manche Proxys liefern Anthropic-Fehler mit HTTP 200 im Body. */
      if (data && data.error) {
        var bodyMsg = (data.error.message || data.error.type || 'Unbekannter API-Fehler') + label;
        var looksRateLimited = /rate.?limit|overloaded|529/i.test(JSON.stringify(data.error));
        lastErr = apiError(withRequestId(bodyMsg, requestId), {
          status: looksRateLimited ? 429 : 400, requestId: requestId, retryAfter: retryAfter
        });
        if (!looksRateLimited || attempt === maxAttempts) {
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

  /* Text aller Textbloecke einer Antwort, wie beide Module ihn brauchen. */
  function textOf(data) {
    if (!data || !Array.isArray(data.content)) return '';
    return data.content.map(function (b) { return b.text || ''; }).join('');
  }

  function isTruncated(data) {
    return !!(data && data.stop_reason === 'max_tokens');
  }

  function _resetThrottleForTests() { _timestamps = []; }

  return {
    configure: configure,
    send: send,
    textOf: textOf,
    isTruncated: isTruncated,
    timeoutForBody: timeoutForBody,
    retryDelayMs: retryDelayMs,
    _resetThrottleForTests: _resetThrottleForTests
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ClaudeAPI;

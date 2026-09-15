/**
 * Cloudflare Worker: Proxy zwischen Kampagnen-Tool und der Claude-API.
 *
 * Der API-Key liegt hier, nicht im Frontend. Das Tool spricht ausschliesslich
 * mit diesem Worker.
 *
 * Gegenueber der ersten Fassung geaendert (jeweils mit Begruendung im Code):
 *   1. Der HTTP-Status von Anthropic wird durchgereicht. Vorher kam JEDE
 *      Antwort mit 200 an - ein 429 war fuer den Client nicht als solcher
 *      erkennbar.
 *   2. request-id, retry-after und die Rate-Limit-Header werden weitergegeben
 *      und per Access-Control-Expose-Headers fuer den Browser sichtbar
 *      gemacht. Ohne beides kann der Client weder einen Fehler nachverfolgen
 *      noch die vom Server vorgegebene Wartezeit einhalten.
 *   3. Streaming wird unterstuetzt: bei "stream": true wird der Body
 *      unveraendert durchgereicht statt gepuffert. Vorher konnte der Worker
 *      keine SSE-Antwort verarbeiten, wodurch lange Generierungen in einem
 *      Request unmoeglich waren.
 *   4. Nicht-JSON-Antworten (z.B. eine HTML-Fehlerseite) ueberleben den
 *      Proxy, statt im catch zu einem irrefuehrenden Worker-500 zu werden.
 *   5. anthropic-beta wird durchgereicht, falls der Client ihn setzt.
 *   6. Organisationsweites Rate-Limiting ueber ein Durable Object, sofern
 *      das Binding RATE_LIMITER existiert. Die Bremse im Frontend zaehlt nur
 *      den eigenen Browser-Tab; ein Reload, ein zweiter Tab oder eine zweite
 *      Person umgeht sie vollstaendig. Erst hier gibt es einen Zaehler, den
 *      alle teilen.
 *
 * Optional ueber Environment-Variablen (Wrangler-Secrets):
 *   ANTHROPIC_KEY   Pflicht.
 *   SHARED_SECRET   Wenn gesetzt, muss der Client denselben Wert im Header
 *                   x-tool-secret senden. Ohne Wert bleibt der Endpunkt offen
 *                   (Verhalten wie bisher).
 *   ALLOWED_ORIGIN  Wenn gesetzt, wird CORS auf diesen Origin beschraenkt.
 *                   Ohne Wert gilt "*" (noetig fuer file://-Aufrufe).
 *   RATE_LIMIT_PER_MIN  Requests pro Minute fuer das ganze Konto. Ohne Wert 5
 *                   (das Anthropic-Limit). Wirkt nur mit RATE_LIMITER-Binding.
 *
 * Optionales Binding (im Dashboard oder per wrangler.toml anzulegen):
 *   RATE_LIMITER    Durable-Object-Namespace auf die Klasse RateLimiter
 *                   weiter unten. Fehlt es, verhaelt sich der Worker exakt
 *                   wie ohne Rate-Limiting - der Code laesst sich also
 *                   deployen, bevor das Binding existiert.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/* Header, die der Client braucht. Ohne Expose-Headers sieht JavaScript im
   Browser sie trotz Weitergabe nicht - das ist die haeufigste Stolperfalle. */
const DURCHREICHEN = [
  'request-id',
  'retry-after',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-requests-reset',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-tokens-reset'
];

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, x-tool-secret, anthropic-beta',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': DURCHREICHEN.join(', '),
    'Access-Control-Max-Age': '86400'
  };
}

function fehler(message, status, env, extra) {
  /* Im selben Format wie ein Anthropic-Fehler, damit der Client nur einen
     Fehlerpfad braucht. */
  return new Response(JSON.stringify({
    type: 'error',
    error: Object.assign({ type: 'proxy_error', message }, extra || {})
  }), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) }
  });
}

/* Durable Object als gemeinsamer Zaehler.
   Ein Durable Object und nicht KV: KV ist eventually consistent, ein Zaehler
   braucht aber starke Konsistenz. Zwei gleichzeitige Requests wuerden in KV
   denselben Wert lesen und beide durchgelassen - genau der Fall, den das
   Limit verhindern soll.

   Gleitendes Fenster statt fester Minutenblock: bei festen Bloecken laufen
   zehn Requests durch, wenn fuenf am Ende des einen und fuenf am Anfang des
   naechsten Blocks liegen. */
export class RateLimiter {
  constructor(state) {
    this.state = state;
    /* Im Speicher, nicht in der Storage-API: Der Zaehler darf ruhig
       vergessen werden, wenn das Objekt evakuiert wird. Ein zu grosszuegiger
       Moment nach einem Neustart ist harmlos, ein langsamer Storage-Roundtrip
       vor jedem einzelnen Request nicht. */
    this.zeitstempel = [];
  }

  async fetch(request) {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit'), 10) || 5;
    const fenster = 60000;
    const jetzt = Date.now();
    this.zeitstempel = this.zeitstempel.filter((t) => jetzt - t < fenster);

    if (this.zeitstempel.length >= limit) {
      /* Wartezeit bis zum Freiwerden des aeltesten Platzes, aufgerundet auf
         volle Sekunden - Retry-After kennt keine Millisekunden. */
      const frei = this.zeitstempel[0] + fenster - jetzt;
      return Response.json({ erlaubt: false, retryAfter: Math.max(1, Math.ceil(frei / 1000)) });
    }
    this.zeitstempel.push(jetzt);
    return Response.json({ erlaubt: true, uebrig: limit - this.zeitstempel.length });
  }
}

/* Fragt den gemeinsamen Zaehler. Ohne Binding und bei JEDEM Fehler wird
   durchgelassen (fail open).

   Das ist die wichtigste Entscheidung hier: Ein Rate-Limiter, der bei einer
   eigenen Stoerung das ganze Werkzeug lahmlegt, richtet mehr Schaden an als
   das Limit, das er schuetzen soll. Ein kurzzeitig ungebremster Betrieb
   endet in einem 429 von Anthropic - den der Client seit jeher behandelt. */
async function pruefeLimit(env) {
  if (!env.RATE_LIMITER) return { erlaubt: true };
  try {
    const limit = parseInt(env.RATE_LIMIT_PER_MIN, 10) || 5;
    const id = env.RATE_LIMITER.idFromName('global');
    const antwort = await env.RATE_LIMITER.get(id).fetch(
      'https://rate-limiter/slot?limit=' + limit);
    return await antwort.json();
  } catch (e) {
    return { erlaubt: true, fehler: e.message };
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }
    if (request.method !== 'POST') {
      return fehler('Nur POST wird unterstuetzt.', 405, env);
    }
    if (!env.ANTHROPIC_KEY) {
      return fehler('ANTHROPIC_KEY ist im Worker nicht gesetzt.', 500, env);
    }

    /* Optionaler Zugriffsschutz. Ohne gesetztes SHARED_SECRET bleibt der
       Endpunkt offen - dann kann allerdings jeder, der die URL kennt, das
       organisationsweite Rate-Limit von 5 Requests/Minute aufbrauchen, und
       das Tool laeuft ohne erkennbaren Grund in Retries. */
    if (env.SHARED_SECRET && request.headers.get('x-tool-secret') !== env.SHARED_SECRET) {
      return fehler('Nicht autorisiert.', 401, env);
    }

    /* Vor dem Upstream-Call, aber nach der Autorisierung: ein unberechtigter
       Request soll keinen Platz im Fenster verbrauchen. */
    const limit = await pruefeLimit(env);
    if (!limit.erlaubt) {
      const r = fehler(
        'Das Kontingent von ' + (parseInt(env.RATE_LIMIT_PER_MIN, 10) || 5) +
        ' Anfragen pro Minute fuer das gesamte Konto ist ausgeschoepft. ' +
        'Vermutlich arbeitet gerade jemand anderes mit dem Werkzeug.',
        429, env, { type: 'proxy_rate_limit' });
      /* Retry-After setzt der Client direkt in seine Wartezeit um - er muss
         nicht raten, wie lange das Fenster noch laeuft. */
      r.headers.set('retry-after', String(limit.retryAfter || 30));
      return r;
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return fehler('Request-Body ist kein gueltiges JSON: ' + e.message, 400, env);
    }

    /* Der Body wird unveraendert weitergereicht. Das ist Absicht: neue
       API-Parameter (z.B. output_config fuer Structured Outputs) funktionieren
       damit ohne Aenderung am Worker. */
    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_KEY,
      'anthropic-version': ANTHROPIC_VERSION
    };
    /* Beta-Features brauchen diesen Header. Wird er nicht durchgereicht, sind
       sie ueber den Proxy grundsaetzlich nicht nutzbar. */
    const beta = request.headers.get('anthropic-beta');
    if (beta) headers['anthropic-beta'] = beta;

    let upstream;
    try {
      upstream = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body)
      });
    } catch (e) {
      /* Netzwerkfehler zwischen Worker und Anthropic. 502 ist hier korrekt:
         der Fehler liegt beim Gateway, nicht beim Client. */
      return fehler('Anthropic nicht erreichbar: ' + e.message, 502, env);
    }

    /* Antwort-Header aufbauen: CORS plus die Diagnose-Header von Anthropic. */
    const out = new Headers(cors);
    for (const name of DURCHREICHEN) {
      const wert = upstream.headers.get(name);
      if (wert) out.set(name, wert);
    }

    /* Streaming: Body unveraendert durchreichen, nichts puffern. Nur so sind
       lange Generierungen (max_tokens weit ueber 16000) moeglich, ohne dass
       die Verbindung minutenlang ohne Daten offen steht. */
    if (body && body.stream === true) {
      out.set('Content-Type', upstream.headers.get('content-type') || 'text/event-stream');
      out.set('Cache-Control', 'no-cache');
      out.set('Connection', 'keep-alive');
      return new Response(upstream.body, { status: upstream.status, headers: out });
    }

    /* Nicht gestreamt: als Text lesen und unveraendert weitergeben. Bewusst
       kein response.json() - eine HTML-Fehlerseite wuerde dort werfen und im
       catch zu einem irrefuehrenden Worker-500 statt zum echten Status des
       Upstreams. */
    const text = await upstream.text();
    out.set('Content-Type', upstream.headers.get('content-type') || 'application/json');

    /* Der Status von Anthropic wird durchgereicht. Das ist die wichtigste
       Aenderung: vorher kam jede Antwort mit 200 an, weshalb der Client 429,
       500 und 529 nicht als solche erkennen und nicht gezielt wiederholen
       konnte. */
    return new Response(text, { status: upstream.status, headers: out });
  }
};

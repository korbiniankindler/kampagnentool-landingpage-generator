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
 *
 * Optional ueber Environment-Variablen (Wrangler-Secrets):
 *   ANTHROPIC_KEY   Pflicht.
 *   SHARED_SECRET   Wenn gesetzt, muss der Client denselben Wert im Header
 *                   x-tool-secret senden. Ohne Wert bleibt der Endpunkt offen
 *                   (Verhalten wie bisher).
 *   ALLOWED_ORIGIN  Wenn gesetzt, wird CORS auf diesen Origin beschraenkt.
 *                   Ohne Wert gilt "*" (noetig fuer file://-Aufrufe).
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

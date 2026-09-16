# Cloudflare Worker

Proxy zwischen Kampagnen-Tool und Claude-API. Der API-Key liegt hier, nicht im
Frontend.

Der Worker lag bisher **nicht** im Repository. Damit war nicht nachvollziehbar,
welche Fassung deployt ist, und Aenderungen am Tool konnten nicht gegen sein
tatsaechliches Verhalten geprueft werden. `tests/worker.test.mjs` prueft ihn
jetzt mit.

## Deployment

Der Code in `index.js` ist ein vollstaendiger Ersatz fuer die bisherige
Fassung. Einspielen per Wrangler (empfohlen, weil nur so das Durable Object
fuer das Rate-Limiting angelegt wird):

```bash
npx wrangler deploy --config worker/wrangler.toml
npx wrangler secret put ANTHROPIC_KEY --config worker/wrangler.toml
```

Alternativ im Cloudflare-Dashboard (Workers → den Worker öffnen → Quick Edit →
Inhalt ersetzen → Deploy). Dann fehlt das Binding `RATE_LIMITER`, und das
Rate-Limiting bleibt wirkungslos — der Worker laeuft ansonsten unveraendert.

Nach dem Deploy pruefen:

```bash
curl -sS -D - -o /dev/null -X POST https://claude.korbinian.workers.dev/ \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-5","max_tokens":999999,"messages":[{"role":"user","content":"x"}]}'
```
Erwartet: HTTP **400** (nicht 200) und ein `request-id`-Header. Kommt weiterhin
200, ist die alte Fassung aktiv.

**Ergebnis der Pruefung nach dem Deploy:** `HTTP/2 400`, `request-id:
req_011Cf5erGJp7Z8yZLHazJByM`, `access-control-expose-headers: request-id,
retry-after, anthropic-ratelimit-requests-remaining, ...` — beide Punkte
bestaetigt. `shared/api-client.js` nutzt seitdem `retry-after` und die
Rate-Limit-Header (siehe `docs/proxy-capabilities.md`).

## Environment

| Variable | Pflicht | Bedeutung |
|---|---|---|
| `ANTHROPIC_KEY` | ja | API-Key. Als Secret setzen, nicht als Plaintext-Variable. |
| `SHARED_SECRET` | nein | Wenn gesetzt, muss der Client denselben Wert als `x-tool-secret` senden. Ohne Wert bleibt der Endpunkt offen wie bisher. |
| `ALLOWED_ORIGIN` | nein | Beschraenkt CORS. Ohne Wert gilt `*` — noetig, solange das Tool auch per `file://` geoeffnet wird. |
| `RATE_LIMIT_PER_MIN` | nein | Requests pro Minute fuer das ganze Konto. Ohne Wert 5 (das Anthropic-Limit). Wirkt nur mit `RATE_LIMITER`-Binding. |

| Binding | Pflicht | Bedeutung |
|---|---|---|
| `RATE_LIMITER` | nein | Durable-Object-Namespace auf die Klasse `RateLimiter`. Fehlt es, gibt es kein organisationsweites Limit. |

`SHARED_SECRET` setzt voraus, dass das Tool den Header mitschickt. Der
Frontend-Code tut das derzeit **nicht** — erst aktivieren, wenn beides
zusammen ausgerollt wird, sonst laeuft niemand mehr durch.

## Was sich gegenueber der ersten Fassung geaendert hat

| # | Vorher | Jetzt | Warum |
|---|---|---|---|
| 1 | jede Antwort mit HTTP 200 | Status von Anthropic durchgereicht | Ein 429 war fuer den Client nicht als solcher erkennbar; gezieltes Wiederholen war unmoeglich. |
| 2 | alle Anthropic-Header verworfen | `request-id`, `retry-after`, Rate-Limit-Header weitergegeben und per `Access-Control-Expose-Headers` sichtbar | Ohne `request-id` ist kein Fehler nachverfolgbar; ohne `retry-after` muss der Client die Wartezeit raten. |
| 3 | `response.json()` puffert | bei `"stream": true` Body unveraendert durchgereicht | Ohne Streaming sind lange Generierungen in einem Request nicht moeglich. |
| 4 | HTML-Fehlerseite → Worker-500 | echter Upstream-Status | Der 500 verdeckte den eigentlichen Fehler. |
| 5 | `anthropic-beta` nicht weitergereicht | durchgereicht, falls gesetzt | Sonst sind Beta-Features grundsaetzlich nicht nutzbar. |
| 6 | kein Zugriffsschutz | optional per `SHARED_SECRET` | Standardmaessig aus, Verhalten unveraendert. |

## Organisationsweites Rate-Limiting

Die Bremse im Frontend (`shared/api-client.js`) zaehlt nur den eigenen
Browser-Tab. Ein Reload, ein zweiter Tab oder eine zweite Person umgeht sie
vollstaendig. Der Zaehler im Durable Object wird von allen geteilt.

**Durable Object und nicht KV:** KV ist eventually consistent. Zwei
gleichzeitige Requests wuerden denselben Wert lesen und beide durchgelassen —
genau der Fall, den das Limit verhindern soll.

**Gleitendes Fenster und nicht fester Minutenblock:** Bei festen Bloecken
laufen zehn Requests durch, wenn fuenf am Ende des einen und fuenf am Anfang
des naechsten Blocks liegen.

**Fail open.** Fehlt das Binding oder faellt das Durable Object aus, wird
durchgelassen. Ein Rate-Limiter, der bei einer eigenen Stoerung das ganze
Werkzeug lahmlegt, richtet mehr Schaden an als das Limit, das er schuetzen
soll. Ein ungebremster Moment endet schlimmstenfalls in einem 429 von
Anthropic, und den behandelt der Client seit jeher.

Eine Abweisung kommt als **HTTP 429** mit `Retry-After` und dem Fehlertyp
`proxy_rate_limit` — unterscheidbar von einem Limit der API, sonst sucht man
den Fehler bei Anthropic. Der Client setzt `Retry-After` direkt in seine
Wartezeit um.

**Der Zaehler haelt nichts dauerhaft.** Er lebt im Speicher des Durable
Objects; wird das Objekt nach laengerer Ruhe evakuiert, faengt er bei null an.
Das ist gewollt: Nach einer Ruhephase ist das Fenster ohnehin abgelaufen. Ein
Storage-Roundtrip vor jedem einzelnen Request waere der teurere Fehler.

**Was das im Alltag bedeutet:** Eine Generierung sind ein Content-Plan plus
drei bis vier Chunks, also 4-5 Requests. Bei 5/Minute passt genau eine
Generierung pro Minute ins Konto. Arbeiten zwei Personen gleichzeitig, wartet
die zweite — das ist keine Eigenheit dieser Bremse, sondern das Limit selbst.
Vorher aeusserte sich derselbe Engpass als 429 von Anthropic mitten in der
Generierung.

## Streaming

Der Worker reicht `stream: true` unveraendert durch, und `shared/api-client.js`
liest SSE seit `sendStream`. Genutzt wird das vom Ein-Call-Benchmark-Arm
(`node eval/runner.js --variante eincall`), der 25.000 bis 35.000
Output-Tokens in einem Request erzeugt.

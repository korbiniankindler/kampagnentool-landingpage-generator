# Cloudflare Worker

Proxy zwischen Kampagnen-Tool und Claude-API. Der API-Key liegt hier, nicht im
Frontend.

Der Worker lag bisher **nicht** im Repository. Damit war nicht nachvollziehbar,
welche Fassung deployt ist, und Aenderungen am Tool konnten nicht gegen sein
tatsaechliches Verhalten geprueft werden. `tests/worker.test.mjs` prueft ihn
jetzt mit.

## Deployment

Der Code in `index.js` ist ein vollstaendiger Ersatz fuer die bisherige
Fassung. Einspielen im Cloudflare-Dashboard (Workers → den Worker öffnen →
Quick Edit → Inhalt ersetzen → Deploy) oder per Wrangler:

```bash
npx wrangler deploy worker/index.js --name claude-korbinian
```

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

## Was der Worker weiterhin NICHT tut

**Organisationsweites Rate-Limiting.** Er zaehlt keine Requests. Die Bremse im
Frontend (`shared/api-client.js`, 4/Minute) ist eine Hoeflichkeitsbremse pro
Browser-Tab: ein Reload, ein zweiter Tab oder ein zweiter Mitarbeiter umgeht
sie vollstaendig.

Eine echte Loesung braucht einen gemeinsamen Zaehler — in Cloudflare entweder
ein Durable Object oder KV mit kurzer TTL. Beides setzt ein Binding voraus,
das im Dashboard angelegt werden muss. **Offener Punkt**, bewusst nicht
mitgebaut, weil die Infrastruktur dafuer nicht bekannt ist.

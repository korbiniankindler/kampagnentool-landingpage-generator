# Proxy-Faehigkeiten (Phase 0.3) — GEKLAERT UND BEHOBEN

> **Stand:** Die ueberarbeitete Fassung aus `worker/index.js` ist **deployt und
> verifiziert**. Der Pruefrequest aus `worker/README.md` liefert HTTP **400**
> (statt vorher 200) und einen `request-id`-Header; `access-control-expose-headers`
> nennt `request-id, retry-after, anthropic-ratelimit-*`. Die drei Befunde unten
> sind damit historisch — sie stehen hier, weil `shared/api-client.js` die
> Behandlung fuer beide Faelle behaelt (Rollback, Zwischenproxy).

Zwischen Browser und Claude-API sitzt ein Cloudflare Worker unter
`https://claude.korbinian.workers.dev/`. Der Worker-Code wurde bereitgestellt;
die Fragen waren damit **aus dem Code beantwortet**, ohne Testrequests.

Die **alte** Fassung in Kurzform:

```js
const body = await request.json();
const response = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': ..., 'x-api-key': env.ANTHROPIC_KEY,
             'anthropic-version': '2023-06-01' },
  body: JSON.stringify(body)          // Body 1:1 weitergereicht
});
const data = await response.json();   // puffert vollstaendig, kein Streaming
return new Response(JSON.stringify(data), {
  headers: { 'Content-Type': 'application/json', ...corsHeaders }
});                                    // IMMER Status 200, Header verworfen
```

## Ergebnisse

| # | Frage | Alte Fassung | Jetzt (deployt) |
|---|---|---|---|
| P1 | `output_config` durchgereicht? | Ja | Ja (Body unveraendert) |
| P2 | `output_config.effort` durchgereicht? | Ja | Ja |
| P3 | Fehlerformat bei Upstream-Fehlern | JSON, aber **immer HTTP 200** | **Status durchgereicht** (verifiziert: 400) |
| P4 | `retry-after` / `request-id` weitergereicht? | Nein | **Ja**, inkl. `anthropic-ratelimit-*` und Expose-Headers |
| P5 | Langer ungestreamter Request? | offen, gepuffert | `stream: true` wird durchgereicht; ungestreamt weiterhin gepuffert |

## Drei Befunde der alten Fassung — behoben, aber weiterhin abgesichert

### 1. Jede Antwort kam mit HTTP 200 an — behoben

`return new Response(...)` setzt keinen Status. Ein 429, ein 500 oder ein 529
von Anthropic erreicht den Browser als **200 mit Fehler-Body**. Nur
Worker-interne Fehler (`catch`) liefern 500.

Konsequenz für `shared/api-client.js`: Der `resp.ok`-Zweig ist jetzt der
Hauptpfad — ein 429 kommt als 429 an und wird gezielt wiederholt. Die
Auswertung von `data.error` bei HTTP 200 **bleibt** trotzdem bestehen: Ein
Rollback auf die alte Fassung oder ein statusnormalisierender Zwischenproxy
fuehrt wieder dorthin, und ohne diesen Zweig gaelte so eine Antwort still als
Erfolg. Beide Pfade sind in `tests/api-client.test.js` abgedeckt.

### 2. `retry-after` war nicht verfuegbar — behoben

Die Anthropic-Header wurden verworfen; der Client musste immer auf das
berechnete Rate-Limit-Fenster zurueckfallen — eine Schaetzung statt der Angabe
des Servers. Ebenso fehlte die `request-id`, womit sich kein Fehler gegenueber
Anthropic nachverfolgen liess.

Beides ist jetzt verfuegbar, und `shared/api-client.js` nutzt es:

* `retry-after` wird befolgt statt geschaetzt.
* `anthropic-ratelimit-requests-reset` bestimmt bei einem 429 ohne
  `retry-after` die Wartezeit.
* `anthropic-ratelimit-requests-remaining === 0` laesst den naechsten Request
  bis zum Reset warten, statt einen sicheren 429 zu provozieren. Das ist die
  einzige Information im System, die das **organisationsweite** Limit
  tatsaechlich kennt — der lokale Zaehler sieht nur den eigenen Tab.
* Jede Fehlermeldung traegt die `request-id`.

Fehlen die Header (Rollback, anderer Proxy), bleibt die lokale Schaetzung
gueltig — der Client wird dadurch nicht schlechter als vorher.

Die urspruenglich vorgeschlagene Minimalloesung war:

```js
return new Response(JSON.stringify(data), {
  status: response.status,                                    // (1)
  headers: { 'Content-Type': 'application/json', ...corsHeaders,
             'request-id': response.headers.get('request-id') || '',
             'retry-after': response.headers.get('retry-after') || '' }  // (2)
});
```
Dazu gehoert `Access-Control-Expose-Headers: request-id, retry-after` in
`corsHeaders`, sonst sieht der Browser sie trotz allem nicht.

### 3. Streaming war nicht moeglich — behoben

`await response.json()` puffert die vollstaendige Antwort. Ein Request mit
`stream: true` wuerde eine SSE-Antwort liefern, die `response.json()` nicht
parsen kann.

Die deployte Fassung reicht bei `"stream": true` den Body unveraendert durch
(`return new Response(upstream.body, ...)`). Die **Ein-Call-Generierung einer
kompletten Landingpage** (~25-35k Output-Tokens) ist damit infrastrukturell
nicht mehr blockiert und kann als Benchmark-Arm antreten.

Offen bleibt die Client-Seite: `shared/api-client.js` liest die Antwort mit
`resp.text()` und kann SSE noch nicht verarbeiten. Solange kein Benchmark-Arm
Streaming braucht, wird das bewusst nicht gebaut — der ungestreamte Pfad mit
`max_tokens`-abhaengigem Timeout deckt die aktuellen Calls ab.

## Was damit entblockt ist

**Structured Outputs (1.7) sind machbar.** Der Body wird unveraendert
weitergereicht, und `output_config` ist GA ohne Beta-Header.

Eine Einschraenkung bleibt: Der Worker setzt **keinen** `anthropic-beta`-Header
und reicht auch keinen aus dem Request weiter. Jedes Feature, das einen
Beta-Header braucht, ist mit diesem Worker nicht nutzbar.

## Organisationsweites Rate-Limiting

`shared/api-client.js` enthaelt eine Anfragebremse (4/Minute). Sie ist eine
**Hoeflichkeitsbremse pro Browser-Tab**, keine Garantie: ein Reload, ein
zweiter Tab oder ein zweiter Mitarbeiter umgeht sie vollstaendig.

Die durchgereichten `anthropic-ratelimit-*`-Header entschaerfen das teilweise —
der Client sieht nach jedem Request den **echten** Kontostand und wartet bei
`remaining: 0` bis zum Reset. Das verhindert vermeidbare 429er, ersetzt aber
keinen Zaehler: zwei Tabs, die gleichzeitig starten, wissen voneinander erst
nach ihrem jeweils ersten Request.

**Geloest:** `worker/index.js` enthaelt jetzt ein Durable Object als
gemeinsamen Zaehler (`RateLimiter`). Es greift, sobald das Binding
`RATE_LIMITER` existiert — `worker/wrangler.toml` legt es an. Ohne Binding
verhaelt sich der Worker unveraendert, der Code laesst sich also deployen,
bevor das Binding da ist.

Begruendung der Entwurfsentscheidungen steht in `worker/README.md`; die drei
wichtigsten: Durable Object statt KV (Konsistenz), gleitendes Fenster statt
Minutenblock, und **fail open** — ein Rate-Limiter, der bei eigener Stoerung
alles blockiert, richtet mehr Schaden an als das Limit, das er schuetzen
soll. Echtes organisationsweites Limiting gehoert
dorthin (Durable Object oder KV als gemeinsamer Zaehler). **Offener Blocker**,
kein geloestes Problem.

## Nebenbefund: der Endpunkt ist unauthentifiziert

Die alte Fassung prueft nichts ausser der HTTP-Methode. Wer die URL kennt, kann
auf Kosten des Kontos Anthropic-Tokens verbrauchen. Das ist fuer ein internes
Tool eine bewusste Vereinfachung, hat aber eine Auswirkung auf die
**Zuverlaessigkeit**: Ein Fremdzugriff wuerde das Org-Limit von 5
Requests/Minute aufbrauchen, und das Tool liefe ohne erkennbaren Grund in
429-Retries.

`worker/index.js` bringt dafuer ein optionales `SHARED_SECRET` mit
(Header `x-tool-secret`). Es ist **nicht aktiviert**: das Frontend schickt den
Header derzeit nicht, ein gesetztes Secret wuerde also alle aussperren. Erst
aktivieren, wenn beide Seiten zusammen ausgerollt werden.

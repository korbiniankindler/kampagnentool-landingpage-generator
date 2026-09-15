# Proxy-Faehigkeiten (Phase 0.3) — GEKLAERT

> **Stand:** Eine ueberarbeitete Worker-Fassung liegt in `worker/index.js` und
> behebt die Punkte 1-3 unten. Sie ist **noch nicht deployt** — bis dahin gilt
> fuer den laufenden Betrieb weiterhin das hier beschriebene Verhalten, und
> `shared/api-client.js` ist entsprechend darauf ausgelegt.

Zwischen Browser und Claude-API sitzt ein Cloudflare Worker unter
`https://claude.korbinian.workers.dev/`. Der Worker-Code wurde bereitgestellt;
die Fragen sind damit **aus dem Code beantwortet**, ohne Testrequests.

Der Worker in Kurzform:

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

| # | Frage | Antwort | Beleg |
|---|---|---|---|
| P1 | `output_config` durchgereicht? | **Ja** | `JSON.stringify(body)` ohne Filterung |
| P2 | `output_config.effort` durchgereicht? | **Ja** | dito |
| P3 | Fehlerformat bei Upstream-Fehlern | **JSON, aber mit HTTP 200** | Status wird nicht weitergereicht |
| P4 | `retry-after` / `request-id` weitergereicht? | **Nein** | Response-Header werden komplett neu gebaut |
| P5 | Langer ungestreamter Request? | **offen, aber riskant** | `response.json()` puffert; Wall-Clock-Grenze des Workers ungetestet |

## Drei Befunde mit Konsequenzen für den Code

### 1. Jede Antwort kommt mit HTTP 200 an

`return new Response(...)` setzt keinen Status. Ein 429, ein 500 oder ein 529
von Anthropic erreicht den Browser als **200 mit Fehler-Body**. Nur
Worker-interne Fehler (`catch`) liefern 500.

Konsequenz für `shared/api-client.js`: Der `resp.ok`-Check greift bei
API-Fehlern faktisch nie. Der relevante Pfad ist die Auswertung von
`data.error` — dort muss die Retry-Erkennung vollstaendig sein. Der
`resp.ok`-Check bleibt trotzdem: er faengt Worker-Ausfaelle, Cloudflare-
Fehlerseiten und einen spaeter korrigierten Worker ab.

### 2. `retry-after` ist nicht verfuegbar

Die Anthropic-Header werden verworfen. Der Client faellt deshalb immer auf das
berechnete Rate-Limit-Fenster zurueck — das ist implementiert und funktioniert,
aber es ist eine Schaetzung statt der Angabe des Servers.

Ebenso fehlt die `request-id`. Ein Fehler laesst sich damit gegenueber
Anthropic nicht nachverfolgen. **Zwei Zeilen im Worker wuerden das loesen:**

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

### 3. Streaming ist mit diesem Worker nicht moeglich

`await response.json()` puffert die vollstaendige Antwort. Ein Request mit
`stream: true` wuerde eine SSE-Antwort liefern, die `response.json()` nicht
parsen kann.

Konsequenz: Die **Ein-Call-Generierung einer kompletten Landingpage**
(~25-35k Output-Tokens) ist mit diesem Worker nicht sinnvoll machbar. Sie
braucht Streaming, und Streaming braucht einen geaenderten Worker
(`return new Response(response.body, ...)`). Im Benchmark faellt dieser Arm
damit aus — nicht aus Prinzip, sondern aus Infrastruktur.

## Was damit entblockt ist

**Structured Outputs (1.7) sind machbar.** Der Body wird unveraendert
weitergereicht, und `output_config` ist GA ohne Beta-Header.

Eine Einschraenkung bleibt: Der Worker setzt **keinen** `anthropic-beta`-Header
und reicht auch keinen aus dem Request weiter. Jedes Feature, das einen
Beta-Header braucht, ist mit diesem Worker nicht nutzbar.

## Bekannte Grenze: organisationsweites Rate-Limiting

`shared/api-client.js` enthaelt eine Anfragebremse (4/Minute). Sie ist eine
**Hoeflichkeitsbremse pro Browser-Tab**, keine Garantie: ein Reload, ein
zweiter Tab oder ein zweiter Mitarbeiter umgeht sie vollstaendig.

Der Worker haelt keinen Zaehler. Echtes organisationsweites Limiting gehoert
dorthin (Durable Object oder KV als gemeinsamer Zaehler). **Offener Blocker**,
kein geloestes Problem.

## Nebenbefund: der Endpunkt ist unauthentifiziert

Der Worker prueft nichts ausser der HTTP-Methode. Wer die URL kennt, kann auf
Kosten des Kontos Anthropic-Tokens verbrauchen. Das ist fuer ein internes Tool
eine bewusste Vereinfachung, hat aber eine Auswirkung auf die
**Zuverlaessigkeit**: Ein Fremdzugriff wuerde das Org-Limit von 5
Requests/Minute aufbrauchen, und das Tool liefe ohne erkennbaren Grund in
429-Retries.

Ein geteiltes Geheimnis im Header waere ein Dreizeiler — sinnvoll, sobald
ohnehin am Worker gearbeitet wird (siehe Punkt 2).

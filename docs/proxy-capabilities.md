# Proxy-Faehigkeiten (offener Punkt aus Phase 0.3)

Zwischen Browser und Claude-API sitzt ein Cloudflare Worker unter
`https://claude.korbinian.workers.dev/`. **Dieser Worker liegt nicht in diesem
Repository.** Mehrere geplante Massnahmen haengen davon ab, was er
durchreicht - solange das ungeklaert ist, sind sie Annahmen, keine Optionen.

## Was zu pruefen ist

Jede Zeile mit einem einzelnen Request klaerbar, Aufwand insgesamt ~15 Minuten.

| # | Frage | Warum sie zaehlt | Ergebnis |
|---|---|---|---|
| P1 | Reicht der Proxy `output_config` im Body durch? | Voraussetzung fuer Structured Outputs (Titel, Bullets, Content-Plan, feste Sections) | **offen** |
| P2 | Akzeptiert er `output_config.effort`? | Voraussetzung fuer aufgabenspezifische Denktiefe | **offen** |
| P3 | Was liefert er bei einem Upstream-Fehler - JSON oder HTML? | Der api-client behandelt beides, aber die Fehlermeldung wird nur mit JSON praezise | **offen** |
| P4 | Gibt er `retry-after` und `request-id` als Header weiter? | Ohne `retry-after` faellt der Client auf ein berechnetes Fenster zurueck; ohne `request-id` ist kein Fehler nachverfolgbar | **offen** |
| P5 | Traegt er einen ungestreamten Request mit ~30.000 Output-Tokens? | Entscheidet, ob eine Landingpage in EINEM Call generiert werden kann | **offen** |

## Warum das nicht in der Claude-Code-Sitzung geklaert werden kann

Die Egress-Policy der Umgebung laesst `claude.korbinian.workers.dev` nicht zu:

    curl: (56) CONNECT tunnel failed, response 403

Das ist eine Richtlinie der Session, kein Problem des Workers. Sie laesst sich
von innen nicht umgehen und soll es auch nicht. Zwei Wege:

1. **Lokal ausfuehren** (empfohlen, ~2 Minuten):
   `bash docs/check-proxy.sh` - klaert P1-P4 ohne nennenswerte Kosten.
   `bash docs/check-proxy.sh --with-p5` ergaenzt den langen Request (~0,30 EUR).
   Ein API-Key wird nicht gebraucht, den haelt der Worker.
2. **Domain fuer die Umgebung freischalten**, falls die Netzwerkrichtlinie das
   hergibt: https://code.claude.com/docs/en/claude-code-on-the-web

## Wie pruefen

```bash
# P1/P2 - wird der Body durchgereicht?
curl -sS -X POST https://claude.korbinian.workers.dev/ \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "claude-sonnet-5",
    "max_tokens": 200,
    "output_config": { "effort": "low" },
    "messages": [{"role":"user","content":"Antworte nur mit OK."}]
  }' | head -c 600
# 200 mit content -> durchgereicht. 400 mit "unexpected parameter" -> der
# Proxy filtert. Fehler von Anthropic selbst -> Parametername pruefen.

# P3/P4 - Header und Fehlerformat
curl -sS -D - -o /tmp/body.txt -X POST https://claude.korbinian.workers.dev/ \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-5","max_tokens":999999,"messages":[{"role":"user","content":"x"}]}'
head -c 400 /tmp/body.txt
# Interessant: HTTP-Status, request-id / x-request-id, retry-after,
# und ob der Body JSON ist oder eine HTML-Fehlerseite.

# P5 - traegt ein langer ungestreamter Request?
time curl -sS -X POST https://claude.korbinian.workers.dev/ \
  -H 'Content-Type: application/json' \
  -d '{"model":"claude-sonnet-5","max_tokens":30000,
       "messages":[{"role":"user","content":"Schreibe einen zusammenhaengenden deutschen Text von etwa 12000 Woertern ueber Ablaufplanung."}]}' \
  -o /tmp/long.json -w '\nHTTP %{http_code}, %{size_download} Bytes, %{time_total}s\n'
# Timeout / 524 / abgeschnittener Body -> Ein-Call-Generierung faellt aus.
```

## Was dranhaengt

- **P1 negativ** -> Structured Outputs sind nicht machbar. Die bestehende
  Reparatur- und Retry-Logik in `shared/json-extract.js` bleibt der einzige
  Schutz. Kein Ersatz noetig, aber die Erwartung muss angepasst werden.
- **P2 negativ** -> aufgabenspezifische Denktiefe entfaellt. Kein Verlust,
  solange der Nutzen ohnehin unbelegt ist.
- **P4 negativ** -> `shared/api-client.js` faellt auf das berechnete
  Rate-Limit-Fenster zurueck (bereits implementiert), Fehlermeldungen tragen
  keine `request-id`.
- **P5 negativ** -> die Ein-Call-Variante scheidet im Benchmark aus. Nicht aus
  Prinzip, sondern aus Infrastruktur.

## Nebenbefund: der Endpunkt ist unauthentifiziert

Der Worker nimmt Requests ohne Authentifizierung entgegen - der API-Key liegt
bei ihm. Das ist fuer ein internes Tool eine bewusste Vereinfachung, hat aber
eine Auswirkung auf die **Zuverlaessigkeit**, nicht nur auf die Sicherheit:
Wer die URL kennt, kann das Org-Rate-Limit von 5 Requests/Minute aufbrauchen.
Das Tool wuerde dann ohne erkennbaren Grund in 429-Retries laufen.

Kein Handlungsbedarf fuer Phase 0. Erwaehnenswert, sobald ohnehin am Worker
gearbeitet wird (siehe naechster Abschnitt).

## Bekannte Grenze: organisationsweites Rate-Limiting

`shared/api-client.js` enthaelt eine Anfragebremse (4/Minute). Sie ist eine
**Hoeflichkeitsbremse pro Browser-Tab**, keine Garantie: ein Reload, ein
zweiter Tab oder ein zweiter Mitarbeiter umgeht sie vollstaendig, weil der
Zaehler nur im Speicher der Seite lebt.

Echtes organisationsweites Limiting laesst sich im Frontend nicht herstellen.
Es gehoert in den Proxy (z.B. Cloudflare Durable Object oder KV als
gemeinsamer Zaehler). **Das ist ein offener Blocker, kein geloestes Problem** -
Frontend-Code darf hier nicht als vollstaendige Loesung dargestellt werden.

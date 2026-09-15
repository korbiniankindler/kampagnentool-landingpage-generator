# Eval-Harness

Faehrt die Landingpage-Pipeline kopflos und misst das Ergebnis. Zweck ist der
Vergleich mehrerer Generierungsvarianten vor einer Architekturentscheidung
(Gate G1), nicht das Ersetzen des Tools.

Der Runner nutzt **dieselben** `shared/`-Module wie Modul 2: denselben
Prompt-Builder, dieselbe Register-Heuristik fuer die Referenz-Copy, denselben
Hero-Merge, dasselbe Quality Gate. Ein Runner mit eigener Prompt-Logik wuerde
etwas anderes messen als das, was die Mitarbeiter benutzen.

## Aufruf

```bash
node eval/runner.js --dry                    # alle Faelle, gemockte Antworten, kostenlos
node eval/runner.js --dry --variante zweiblock
node eval/runner.js --fall hellinger-b2c --live
node eval/runner.js --live --wiederholungen 3   # Varianz ueber Wiederholungen
```

**Ohne `--live` geht kein Request an die API.** Der Trockenlauf prueft den
Runner selbst, die Prompt-Erzeugung und das Gate - nicht die Copy-Qualitaet.

## Varianten

| `--variante` | Bedeutung |
|---|---|
| `chunk` | Ist-Zustand: bis zu 4 Sections je Request, parallel |
| `zweiblock` | zwei sequenzielle Bloecke; der zweite sieht den echten Text des ersten |

Eine Ein-Call-Variante fehlt bewusst: Sie braucht Streaming, und der
eingesetzte Cloudflare Worker puffert die Antwort vollstaendig
(`response.json()`). Siehe `docs/proxy-capabilities.md`.

## Faelle

Ein Fall ist ein JSON in `faelle/` mit `id`, `beschreibung`, `preset`,
`lpVorlage`, `hardfacts` und `sections`. Die vier vorhandenen sind ein
Startpunkt, kein vollstaendiger Satz:

| Fall | deckt ab |
|---|---|
| `hellinger-b2c` | Kernfall, vollstaendiges Briefing, Du-Anrede |
| `hellinger-b2b` | anderes Register - die Keyword-Heuristik muss die B2B-Referenz waehlen |
| `hh-b2c` | zweite Marke, Sie-Anrede, andere Verbotsliste, 5 Bulletpoints |
| `hh-luecken` | unvollstaendiges Briefing: kein Host, kein Termin, keine Zielgruppe |

**Was noch fehlt** (laut Benchmark-Plan 8 Faelle): ein kostenpflichtiges
Angebot, zwei Faelle mit PDF-Kontext, ein Fall mit abweichender
Bulletpoint-Anzahl. Am besten aus echten Laeufen uebernehmen - der
Session-Export in Modul 2 liefert das passende Format.

## Metriken

Pro Lauf in `ergebnisse/<fall>_<variante>_<n>.json`:

| Metrik | Bedeutung |
|---|---|
| `befundeKritisch` | Befunde, die den Export sperren |
| `presetVerstoesse` | Treffer der Verbotsliste des Regelwerks |
| `faktenAbweichungen` | wie oft das Modell von bestaetigten Werten abweichen wollte (der Merge hat korrigiert) |
| `redundanzen` | woertliche Dopplungen zwischen Sections |
| `leereFelder`, `anzahlFehler` | strukturelle Maengel |
| `dauerMs`, `calls`, `truncations` | Laufzeit und Zuverlaessigkeit |

**Was der Harness NICHT misst:** ob die Copy ueberzeugt, zur Zielgruppe passt
oder argumentativ traegt. Das ist die Aufgabe der blinden menschlichen
Bewertung im Benchmark - die Zahlen hier ersetzen sie nicht.

## Vor einem Live-Lauf

- Jeder Lauf kostet echtes Geld. 4 Faelle x 3 Wiederholungen x 4 Requests
  sind rund 50 Requests.
- Das Rate-Limit liegt bei 5 Requests/Minute organisationsweit. Der
  api-client bremst auf 4/Minute - ein voller Lauf dauert entsprechend.
- `PROMPT_VERSION` in `shared/versions.js` vor dem Lauf pruefen. Ohne sie ist
  spaeter nicht zuzuordnen, gegen welche Prompt-Fassung gemessen wurde.

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
node eval/runner.js --live --reviewer            # mit semantischem Reviewer
```

**Ohne `--live` geht kein Request an die API.** Der Trockenlauf prueft den
Runner selbst, die Prompt-Erzeugung und das Gate - nicht die Copy-Qualitaet.

## Varianten

| `--variante` | Bedeutung |
|---|---|
| `chunk` | Ist-Zustand: bis zu 4 Sections je Request, parallel |
| `zweiblock` | zwei sequenzielle Bloecke; der zweite sieht den echten Text des ersten |

Eine Ein-Call-Variante fehlt noch. Sie war infrastrukturell blockiert, solange
der Cloudflare Worker die Antwort vollstaendig pufferte; die deployte Fassung
reicht `stream: true` durch (siehe `docs/proxy-capabilities.md`). Offen ist
jetzt nur noch die Client-Seite: `shared/api-client.js` kann SSE noch nicht
lesen.

## Semantischer Reviewer (`--reviewer`)

Das Quality Gate misst, was sich deterministisch messen laesst. Ob die Copy
*gut* ist, misst es nicht. Der Reviewer in `shared/reviewer.js` ergaenzt genau
das: ein zusaetzlicher Call pro Lauf, der die fertige Seite gegen eine Rubrik
mit sechs Dimensionen bewertet (Regelkonformitaet, Konkretheit,
Zielgruppenpassung, Deckung der Versprechen, Dramaturgie, inhaltliche
Redundanz).

Vier Entwurfsentscheidungen, die den Unterschied machen:

* **Anderes Modell als der Generator.** Ein Modell, das seinen eigenen Text
  bewertet, findet systematisch zu wenig.
* **Kein Zugriff auf die Referenz-Copy** — nur Regelwerk und Wissensdatenbank.
  Mit der Referenz im Kontext bewertet ein Modell Aehnlichkeit zum Vorbild,
  und der Generator wuerde fuer Nachahmung belohnt.
* **Erfundene Testimonials sind ausdruecklich erlaubt.** Ohne diesen Hinweis
  meldet jeder Reviewer sie als erfundene Fakten — eine Produktentscheidung,
  die er sonst massenhaft als Befund zurueckmeldet.
* **Nur Befunde, keine Umschreibung.** Sein `vorschlag` wird nirgends
  automatisch uebernommen; ein automatischer Rewrite waere eine zweite,
  ungepruefte Generierung.

Jeder Befund braucht ein **woertliches Zitat** aus der Copy.
`Reviewer.pruefeBelege` verwirft anschliessend deterministisch jeden Befund,
dessen Zitat sich im generierten Text nicht wiederfindet — jedes Feld wird
einzeln geprueft, damit ein ueber Feldgrenzen zusammengesetzter Satz nicht als
Beleg durchgeht. Das ist die einzige wirksame Bremse gegen halluzinierte
Befunde. Die verworfenen Befunde werden mitgeschrieben: eine hohe Quote ist
eine Aussage ueber den **Reviewer**, nicht ueber die Copy.

Im Trockenlauf liefert `mockReview` absichtlich drei belegte und einen
erfundenen Befund, damit beide Zweige der Belegpruefung durchlaufen werden.

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
| `reviewSchnitt` | Mittel der sechs Rubrik-Dimensionen (nur mit `--reviewer`) |
| `reviewKritisch`, `reviewHinweise` | belegte Befunde des Reviewers |
| `reviewVerworfen` | unbelegte Befunde — Guete des Reviewers, nicht der Copy |

Die vier Review-Metriken sind `null` statt `0`, wenn ohne `--reviewer`
gelaufen wurde. `0` hiesse "geprueft, nichts gefunden"; ein Lauf ohne Reviewer
hat aber gar nichts geprueft.

**Was der Harness NICHT misst:** ob die Copy ueberzeugt. Der Reviewer ist ein
Naeherungswert, kein Ersatz — er ist selbst ein Sprachmodell und teilt die
Vorlieben des Generators. Die blinde menschliche Bewertung im Benchmark bleibt
die entscheidende Messung; die Zahlen hier ordnen nur vor.

Wie belastbar der Reviewer ist, ist selbst noch ungemessen. Die
naheliegendste Pruefung: dieselbe Seite zweimal bewerten lassen und sehen, wie
weit die Punkte auseinanderliegen. Solange das nicht gemacht ist, sind
Unterschiede von unter einem Punkt nicht zu deuten.

## Vor einem Live-Lauf

- Jeder Lauf kostet echtes Geld. 4 Faelle x 3 Wiederholungen x 4 Requests
  sind rund 50 Requests; mit `--reviewer` kommt je Lauf ein weiterer,
  teurerer Request dazu.
- Das Rate-Limit liegt bei 5 Requests/Minute organisationsweit. Der
  api-client bremst auf 4/Minute - ein voller Lauf dauert entsprechend.
- `PROMPT_VERSION` in `shared/versions.js` vor dem Lauf pruefen. Ohne sie ist
  spaeter nicht zuzuordnen, gegen welche Prompt-Fassung gemessen wurde.
  Dasselbe gilt fuer `RUBRIK_VERSION` in `shared/reviewer.js`: aendert sich
  die Rubrik, sind Review-Punkte aus zwei Laeufen nicht vergleichbar.

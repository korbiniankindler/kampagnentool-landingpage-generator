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

Ein unbekannter Variantenname bricht ab, statt still als `chunk` zu laufen.
Genau das war passiert: Ein `--variante eincall` gegen eine aeltere Fassung,
die die Variante noch nicht kannte, fuhr vier Chunk-Requests und schrieb
trotzdem `"variante": "eincall"` ins Ergebnis. Das Ergebnis-JSON nennt seither
zusaetzlich `bloeckeGefahren` - die tatsaechliche Aufteilung, nicht nur die
angeforderte.

## Varianten

| `--variante` | Bedeutung |
|---|---|
| `chunk` | Ist-Zustand: bis zu 4 Sections je Request, parallel |
| `zweiblock` | zwei sequenzielle Bloecke; der zweite sieht den echten Text des ersten |
| `eincall` | die ganze Seite in EINEM gestreamten Request, ohne Content-Plan |

Die Ein-Call-Variante war lange blockiert: Der alte Worker pufferte die Antwort
vollstaendig, und ungestreamt liegt die Obergrenze bei rund 16.000
Output-Tokens — eine komplette Seite braucht 25.000 bis 35.000. Der deployte
Worker reicht `stream: true` durch, und `shared/api-client.js` liest jetzt SSE
(`sendStream`). Damit kann der dritte Benchmark-Arm antreten.

**Ihr Content-Plan entfaellt bewusst.** Ihre These ist, dass ein Modell, das
die ganze Seite auf einmal schreibt, den Bogen besser baut als vier parallele
Chunks entlang eines vorgegebenen Plans. Mit Plan waere es weder ein Call noch
die These. Das macht sie zur teuersten Variante in der Wartezeit (ein langer
Request statt vier kurzer parallelen) und zur riskantesten: Bricht sie ab, ist
die ganze Seite weg statt eines Viertels.

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

Er erfaehrt ausserdem, **welche Regeln maschinell geprueft werden**, und soll
sie nicht noch einmal melden. Im ersten Live-Lauf waren drei von fuenf
kritischen Reviewer-Befunden "nicht ... sondern" — das findet die Regex im
Quality Gate bereits, Wort fuer Wort und ohne Kosten. Entscheidend ist dabei
die genaue Formulierung: nicht "ignoriere diese Regeln", sondern "die
**woertliche** Form ist abgedeckt, such die **sinngemaesse**". Denn genau dort
war er stark — er meldete "Statt einer weiteren Erklaerung erlebst Du ...":
derselbe Korrekturgestus ohne die verbotene Wortfolge, fuer keine Regex
auffindbar.

Felder, die deterministisch aus dem bestaetigten Briefing gesetzt werden
(Hero-Titel, Bullets, CTA), sind in der Copy als solche markiert. Ein Befund
dort richtet sich an den Menschen, der das Briefing verantwortet; einer auf
generierter Copy an die Generierung. Ohne die Markierung las sich beides
gleich.

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
`lpVorlage`, `hardfacts` und `sections`. Die acht Faelle aus dem
Benchmark-Plan sind vollstaendig:

| Fall | deckt ab |
|---|---|
| `hellinger-b2c` | Kernfall, vollstaendiges Briefing, Du-Anrede, 4 Bulletpoints |
| `hellinger-b2b` | anderes Register - die Keyword-Heuristik muss die B2B-Referenz waehlen |
| `hellinger-viele-bullets` | 7 Bulletpoints statt 4, Vorlage `ausbildung` (Bewerbung statt Anmeldung) |
| `hellinger-dokument` | Dokument-Kontext ohne Widerspruch |
| `hh-b2c` | zweite Marke, Sie-Anrede, andere Verbotsliste, 5 Bulletpoints |
| `hh-luecken` | unvollstaendiges Briefing: kein Host, kein Termin, keine Zielgruppe |
| `hh-salespage` | **kostenpflichtiges** Angebot - der Preis darf hier stehen, Conversion ist ein Kauf |
| `hh-dokument-konflikt` | Dokument-Kontext, dessen Termin dem Briefing widerspricht |

Die Faelle sind konstruiert, nicht aus echten Laeufen uebernommen. Fuer die
Baseline-Messung braucht es echte Kampagnen; der Session-Export in Modul 2
liefert das passende Format.

### Dokument-Kontext ohne PDF

Der Runner kennt keine Dateien. Ein Fall bringt deshalb einen **fertigen
Digest** mit (`digest`, dazu optional `digestSeiten`) statt eines PDFs. Das
ist kein Notbehelf, sondern besser: Eine echte Extraktion faellt bei jedem
Lauf anders aus und waere als Fixture wertlos. Geprueft wird genau das, was im
Tool nach der Extraktion passiert - `Digest.pruefe`, die Konflikt-Erkennung
und der Prompt-Block.

`hh-dokument-konflikt` ist dabei der interessante Fall: Das Dokument nennt
einen anderen Termin als das bestaetigte Briefing, und `digest.konflikte` ist
**leer** - das Modell hat den Widerspruch uebersehen. Die deterministische
Pruefung muss ihn finden, und der falsche Termin darf nicht in der Copy
landen.

### Die Faelle werden selbst geprueft

`tests/runner.test.js` prueft jeden Fall gegen das Regelwerk seiner Marke.
Beim Anlegen von `hellinger-viele-bullets` enthielt die Sub-Headline
"nicht nur lernst, sondern" - ein Verstoss gegen die Hellinger-Regel zur
Perspektivverschiebung. Der Hero-Merge uebernimmt die Sub-Headline
unveraendert, das Gate meldet den Verstoss, und der Fall haette einen
Fixture-Fehler gemessen statt der Bulletpoint-Anzahl. Ein Fixture, das still
kaputtgeht, ist schlechter als keines.

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
| `digestKonflikte` | Widersprueche zwischen Dokument und bestaetigtem Briefing |
| `digestBefunde` | alle Befunde zum Digest (inkl. Struktur) |

Dazu `schemaFallbacks` je Lauf: wie oft der Proxy `output_config` abgelehnt hat
und der Client still auf einen Request ohne Schema zurueckgefallen ist. Ohne
Schema ist die Struktur der Antwort nicht mehr garantiert — das darf nicht
unbemerkt bleiben.

Die vier Review-Metriken sind `null` statt `0`, wenn ohne `--reviewer`
gelaufen wurde. `0` hiesse "geprueft, nichts gefunden"; ein Lauf ohne Reviewer
hat aber gar nichts geprueft.

**Was der Harness NICHT misst:** ob die Copy ueberzeugt. Der Reviewer ist ein
Naeherungswert, kein Ersatz — er ist selbst ein Sprachmodell und teilt die
Vorlieben des Generators. Die blinde menschliche Bewertung im Benchmark bleibt
die entscheidende Messung; die Zahlen hier ordnen nur vor.

### Gemessene Streuung: mindestens ein halber Punkt

Zwei Live-Laeufe von `hellinger-b2c` unter **identischer** Konfiguration
(gleiche Variante, gleiche Referenz-Copy, gleiche Prompt-Version) ergaben:

| | Lauf 1 | Lauf 2 |
|---|---|---|
| Review-Schnitt | 3,83 | 4,33 |
| Preset-Verstoesse | 5 | 3 |
| Reviewer-Befunde kritisch | 5 | 3 |
| Woerter | 1130 | 1195 |
| unbelegte Reviewer-Befunde | 0 | 0 |

**Ein halber Punkt Unterschied entsteht ohne jede Aenderung.** Ein
Variantenvergleich, der auf 0,5 Punkte hinauslaeuft, misst damit nichts. Vor
jeder Aussage ueber Varianten braucht es Wiederholungen
(`--wiederholungen 3`) und einen Abstand, der deutlich ueber dieser Streuung
liegt.

Die Streuung vermischt zwei Quellen - die Generierung und die Bewertung -, die
diese zwei Laeufe nicht trennen. Um den Reviewer allein zu messen, muesste
**dieselbe** Copy zweimal bewertet werden. Bis dahin ist die halbe Punkt-Marke
die Untergrenze, nicht die gemessene Reviewer-Varianz.

Unbelegte Befunde blieben in beiden Laeufen bei **null**: Jedes der 23 Zitate
liess sich in der Copy wiederfinden. Die Belegpflicht traegt.

## Vor einem Live-Lauf

- Jeder Lauf kostet echtes Geld. 8 Faelle x 3 Wiederholungen x 4 Requests
  sind rund 100 Requests; mit `--reviewer` kommt je Lauf ein weiterer,
  teurerer Request dazu. Bei 4 Requests/Minute ist das ueber eine halbe
  Stunde reine Wartezeit - erst einen einzelnen Fall fahren.
- Das Rate-Limit liegt bei 5 Requests/Minute organisationsweit. Der
  api-client bremst auf 4/Minute - ein voller Lauf dauert entsprechend.
- `PROMPT_VERSION` in `shared/versions.js` vor dem Lauf pruefen. Ohne sie ist
  spaeter nicht zuzuordnen, gegen welche Prompt-Fassung gemessen wurde.
  Dasselbe gilt fuer `RUBRIK_VERSION` in `shared/reviewer.js`: aendert sich
  die Rubrik, sind Review-Punkte aus zwei Laeufen nicht vergleichbar.

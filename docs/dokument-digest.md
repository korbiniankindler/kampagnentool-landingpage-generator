# Dokument-Digest (1.3)

Was passiert, wenn in Modul 2 ein PDF als Kampagnen-Kontext hochgeladen wird.

## Vorher

Die PDFs hingen als `document`-Bloecke an **jedem** Request: Content-Plan,
drei bis vier Section-Chunks, dazu jede einzelne Regenerierung. Bei der
zugelassenen Obergrenze von 20 Seiten sind das grob 40.000 Input-Tokens, die
bei jedem Request erneut anfallen — der Prompt-Cache senkt den Preis, nicht
die Menge.

Das zweite, groessere Problem war inhaltlich: Das Modell musste die relevanten
Stellen in zwanzig Seiten **suchen**, waehrend es gleichzeitig Copy schrieb.
Zwei Aufgaben in einem Call, und die Suche geht auf Kosten des Schreibens.

## Jetzt

Ein einzelner Extraktions-Call liest die Dokumente und liefert Fakten mit
woertlichem Beleg und Seitenangabe (`shared/digest.js`). Die Generierung
bekommt nur noch diesen kompakten Block.

```
PDF-Upload ──► Extraktions-Call (1x) ──► Digest ──► Generierungs-Prompts
                                            │
                                            └────► Anzeige in Schritt 1
```

Der Digest entsteht erst, **nachdem** die Hardfacts uebernommen wurden. Vorher
liesse sich kein Widerspruch zum Briefing erkennen, und genau der ist der
teuerste Fall.

## Rangfolge der Quellen

Uebernommen aus den Regelwerken beider Marken (`presets/hellinger/regeln.md`,
Konfliktregeln; `presets/holistic-house/regeln.md`, Vorrangregel):

    bestaetigte Hardfacts  >  hochgeladenes Dokument
                           >  Wissensdatenbank  >  Referenz-Copy

Die bestaetigten Hardfacts sind der vom Menschen abgenommene Teil des
Briefings. Ein Dokument darf sie **ergaenzen, nie ueberschreiben**.

## Widersprueche

Sie werden aus zwei Quellen gesammelt:

1. **Vom Modell gemeldet** (`konflikte` im Digest). Es bekommt die
   bestaetigten Daten mit und wird ausdruecklich angewiesen, einen
   Widerspruch zu melden statt ihn aufzuloesen.
2. **Deterministisch gefunden** (`Digest.pruefe`). Fuer den Termin gibt es
   einen echten Datumsvergleich mit deutschen Monatsnamen: `20.09.2026`,
   `20. September 2026` und `20.9.26` gelten als derselbe Tag, `27.10.2026`
   als Widerspruch. Ein fehlendes Jahr widerspricht nicht. Laesst sich eine
   Angabe nicht eindeutig lesen, wird **nicht** verglichen — ein falsch
   geratener Konflikt kostet Vertrauen in jede weitere Meldung.

Beide Quellen landen **im Prompt und in der Oberflaeche**. Das ist keine
Doppelung: Ein Widerspruch, den nur der Mensch sieht, verhindert nicht, dass
das Modell den falschen Termin schreibt; der betroffene Fakt wird im Prompt
zusaetzlich mit `[ACHTUNG: weicht vom verbindlichen Briefing ab]` entwertet.

Fuer Textfelder (Titel, Kampagnenname, Headlines) gibt es nur eine
Wortueberdeckung — deshalb `hinweis` statt `kritisch`. Ein Datum laesst sich
exakt pruefen, ein Titel nicht.

## Was das Tool NICHT pruefen kann

Anders als beim Reviewer (`shared/reviewer.js`), wo jedes Zitat gegen die
generierte Copy geprueft wird, laesst sich ein Digest-Zitat **nicht**
deterministisch gegen seine Quelle pruefen: Das Tool liest PDFs nicht selbst,
es reicht sie an die API weiter. Ein erfundenes Zitat faellt nur einem
Menschen auf.

Genau deshalb wird der Digest in Schritt 1 **angezeigt** statt im Hintergrund
zu verschwinden — mit Zitat und Seitenzahl je Fakt, aufklappbar.

Deterministisch geprueft wird, was ohne die Quelle pruefbar ist:

| Befund | Schwere | Bedeutung |
|---|---|---|
| `digest-leer` | kritisch | kein einziger Fakt gewonnen |
| `fakt-ohne-beleg` | kritisch | ohne Zitat nicht von einer Erfindung zu unterscheiden |
| `fakt-leer` | kritisch | Fakt ohne Aussage |
| `termin-konflikt` | kritisch | Datum im Dokument weicht vom Briefing ab |
| `moeglicher-konflikt` | hinweis | Textfeld weicht ab (Wortueberdeckung) |
| `seite-unplausibel` | hinweis | Fundstelle liegt ausserhalb der hochgeladenen Seiten |
| `kategorie-unbekannt` | hinweis | Kategorie ausserhalb der Liste |

Die Seitenpruefung entfaellt, wenn `countPdfPages` die Seitenzahl nicht
ermitteln konnte (komprimierte Object-Streams) — lieber nicht pruefen als
falsch Alarm schlagen.

## Der Rueckweg

Eine Checkbox haengt die vollstaendigen PDFs zusaetzlich an jeden Request.
Standardmaessig aus. Der Digest ist eine Verdichtung, und jede Verdichtung
kann etwas verlieren — ohne Rueckweg waere das eine Einbahnstrasse.

Schlaegt die Extraktion fehl, faellt das Tool automatisch auf das alte
Verhalten zurueck (PDFs an jedem Request) und sagt das auch.

## Abgrenzung

Das ist **kein** Claim-/Citation-/Evidence-System. Die fertige Landingpage
traegt keine Quellenangaben, und niemand muss Belege pflegen. Die Zitate
dienen einzig dazu, den Digest selbst nachpruefbar zu machen; sie erscheinen
nie auf der Seite und stehen bewusst auch nicht im Generierungs-Prompt — dort
waeren sie Ballast und eine Einladung, sie woertlich zu uebernehmen.

## Export

`buildSessionExport()` schreibt den Digest mit (`kontext.digest`). Ohne ihn
waere ein Lauf mit PDF-Kontext nicht nachvollziehbar: Die PDFs liegen nicht im
Export, und die Generierung sah nur noch den Digest.

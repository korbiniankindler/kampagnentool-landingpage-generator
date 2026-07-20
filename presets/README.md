# Copywriter-Presets

Jedes Kundenprojekt bekommt einen eigenen Ordner. Der Preset-Katalog liegt zentral in `shared/copywriter-presets.js` (→ `CATALOG`) und wird von **beiden Modulen** genutzt: Modul 1 (`hardfacts-generator.html`, Titel + Bulletpoints) und Modul 2 (`landingpage-generator.html`, Landingpage-Copy). Die Tools laden beim Generieren alle unter `files` eingetragenen Dateien des gewählten Presets (Regelwerk, Wissensdatenbank) und hängen sie in dieser Reihenfolge in den System-Prompt. Definiert ein Preset zusätzlich `referenzen` (Referenz-Copys nach Register), wird davon **genau eine** pro Auftrag mitgeladen - die Auswahl trifft das Tool automatisch: die `keywords` jeder Referenz werden gegen das Kampagnen-Briefing gematcht (Beschreibung, Zielgruppe, Offer, zusätzlicher Kontext), die Referenz mit den meisten Treffern wird geladen. Ohne Treffer gilt der erste Eintrag als Default. Es gibt keinen manuellen Auswahlschritt und keine Obergrenze für die Anzahl der Referenzen:

```
presets/
  <projekt>/
    regeln.md            Pflicht. Tonalität, Sprachregeln, Compliance, LP-Architektur.
    wissensdatenbank.md  Optional. Belegte Fakten, Zahlen, O-Töne, Produkte, Zielgruppen.
    referenzen/          Optional. Vollständige, real veröffentlichte Copys als Stil-Vorbilder.
      <lp-typ>-<kampagne>-<zielgruppe>.md
```

## Warum drei Ebenen?

- **regeln.md** sagt dem Modell, *was erlaubt und verboten* ist. Regeln allein reichen aber nicht, um Tonalität zu treffen.
- **wissensdatenbank.md** verhindert erfundene Zahlen, Zitate und Features (Source-Discipline).
- **referenzen/** sind der größte Qualitätshebel: echte Copys, aus denen das Modell Satzrhythmus, Dramaturgie und Wortwahl lernt (Few-Shot-Prinzip). Pro Auftrag wird genau eine Referenz geladen - die zum Register des Auftrags passende (z. B. B2C-Webinar, B2B/Fachpublikum, Themen-Webinar mit Produktnähe). Mehrere Referenzen gleichzeitig würden die Register-Tonalitäten mischen.

## Konventionen für Referenz-Dateien

Jede Referenz beginnt mit einem Metadaten-Block:

1. **Tabelle:** LP-Typ, Zielgruppe, Kampagne, Status (`⭐ Gold-Standard` oder `Referenz mit Abweichungen (Altbestand)`).
2. **Abweichungs-Hinweis:** welche Muster in dieser Copy gegen das aktuelle Regelwerk verstoßen und nicht übernommen werden dürfen.

Danach folgt die Original-Copy **wortgetreu** (nichts umschreiben!), gegliedert nach Sections (`## Above the Fold`, `## Testimonials`, …), damit das Modell die Section-Logik des Tools wiedererkennt.

## Neues Projekt-Preset anlegen

1. Ordner `presets/<projekt>/` mit mindestens `regeln.md` anlegen.
2. Optional `wissensdatenbank.md` und `referenzen/*.md` ergänzen (2-5 kuratierte Referenzen reichen; Masse verwässert).
3. In `shared/copywriter-presets.js` einen Eintrag in `CATALOG` ergänzen (gilt damit automatisch für Modul 1 und Modul 2):

```js
{id:'projekt', name:'Projekt', desc:'Marken-Stilvorgabe + Referenzen', files:[
  'presets/projekt/regeln.md',
  'presets/projekt/wissensdatenbank.md'
], referenzen:[
  {id:'b2c', name:'B2C-Webinar', desc:'Gold-Standard (Default)', file:'presets/projekt/referenzen/beispiel-b2c.md'},
  {id:'b2b', name:'B2B / Fachpublikum', desc:'…', file:'presets/projekt/referenzen/beispiel-b2b.md',
    keywords:['b2b', 'arzt', 'ärzt', 'heilpraktiker', 'therapeut']}
]}
```

Reihenfolge = Prompt-Reihenfolge: Regeln zuerst, dann Fakten, dann die eine automatisch gewählte Referenz. `referenzen` ist optional: Presets ohne Register-Varianten tragen einfach alle Dateien in `files` ein. Der erste `referenzen`-Eintrag ist der Default bei unklarem Auftrag und braucht keine `keywords`; alle weiteren definieren `keywords` (Kleinschreibung, Wortanfänge reichen: `'ärzt'` matcht Ärzte/Ärztin), an denen ihr Register im Briefing erkannt wird. Welche Referenz geladen wurde, steht bei jeder Generierung in der Browser-Konsole.

4. **Wichtig:** danach einmal `node sync-presets.js` im Repo-Root ausführen und die geänderten `landingpage-generator.html` **und** `hardfacts-generator.html` mitcommitten. Das Script bettet alle Preset-Dateien als Fallback-Snapshots in beide Modul-HTMLs ein — nur so laden die Presets auch, wenn die Datei per `file://` geöffnet oder ohne den `presets/`-Ordner deployt wird. Die Tools bevorzugen immer die Live-Dateien vom Server und nutzen die Snapshots nur als Fallback (sichtbar in der Browser-Konsole: „Quellen: live" vs. „eingebettet").

## Token-Budget

Der gesamte Preset-Inhalt wird per Prompt Caching nur einmal pro 5-Minuten-Fenster voll bezahlt; Folge-Requests lesen ihn für ~10 % des Preises. Richtwert: 40-80 KB Gesamtumfang pro Preset sind unkritisch. Kuratieren statt kippen: lieber wenige, starke Referenzen pro LP-Typ als das ganze Archiv.

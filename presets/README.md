# Copywriter-Presets

Jedes Kundenprojekt bekommt einen eigenen Ordner. Das Tool lädt beim Generieren **alle** in `landingpage-generator.html` (→ `COPYWRITER_PRESETS`) eingetragenen Dateien des gewählten Presets und hängt sie in dieser Reihenfolge in den System-Prompt:

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
- **referenzen/** sind der größte Qualitätshebel: echte Copys, aus denen das Modell Satzrhythmus, Dramaturgie und Wortwahl lernt (Few-Shot-Prinzip).

## Konventionen für Referenz-Dateien

Jede Referenz beginnt mit einem Metadaten-Block:

1. **Tabelle:** LP-Typ, Zielgruppe, Kampagne, Status (`⭐ Gold-Standard` oder `Referenz mit Abweichungen (Altbestand)`).
2. **Abweichungs-Hinweis:** welche Muster in dieser Copy gegen das aktuelle Regelwerk verstoßen und nicht übernommen werden dürfen.

Danach folgt die Original-Copy **wortgetreu** (nichts umschreiben!), gegliedert nach Sections (`## Above the Fold`, `## Testimonials`, …), damit das Modell die Section-Logik des Tools wiedererkennt.

## Neues Projekt-Preset anlegen

1. Ordner `presets/<projekt>/` mit mindestens `regeln.md` anlegen.
2. Optional `wissensdatenbank.md` und `referenzen/*.md` ergänzen (2-5 kuratierte Referenzen reichen; Masse verwässert).
3. In `landingpage-generator.html` einen Eintrag in `COPYWRITER_PRESETS` ergänzen:

```js
{id:'projekt', name:'Projekt', desc:'Marken-Stilvorgabe + Referenzen', files:[
  'presets/projekt/regeln.md',
  'presets/projekt/wissensdatenbank.md',
  'presets/projekt/referenzen/beispiel.md'
]}
```

Reihenfolge = Prompt-Reihenfolge: Regeln zuerst, dann Fakten, dann Referenzen.

## Token-Budget

Der gesamte Preset-Inhalt wird per Prompt Caching nur einmal pro 5-Minuten-Fenster voll bezahlt; Folge-Requests lesen ihn für ~10 % des Preises. Richtwert: 40-80 KB Gesamtumfang pro Preset sind unkritisch. Kuratieren statt kippen: lieber wenige, starke Referenzen pro LP-Typ als das ganze Archiv.

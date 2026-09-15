# Fixtures: rohe Modellantworten

Jede Datei ist eine **rohe** Claude-Antwort, wie sie in
`d.content.map(b => b.text).join('')` ankommt - vor jeder Verarbeitung.

## Herkunft

Die Dateien hier sind **nachgebaute** Faelle. Sie bilden exakt die
Fehlerbilder ab, die in `shared/json-extract.js` im Kopfkommentar
dokumentiert sind, sind aber nicht aus Produktivlaeufen gesammelt.

**Bitte bei jedem echten Fehlerfall die rohe Antwort hier ablegen**
(Konsole -> `Claude usage` Log erweitern oder Session-Export) und im
Test referenzieren. Echte Antworten decken Kombinationen ab, die man
nicht erfindet.

## Konvention

| Datei | Fehlerbild | Erwartung |
|---|---|---|
| `valid.json.txt` | sauber | parst, `repaired: false`, `salvaged: false` |
| `markdown-fence.txt` | in ```json eingerahmt | parst |
| `prose-before.txt` | Fliesstext vor dem JSON | parst |
| `unescaped-quote.txt` | inneres Zitat nicht escaped | parst, `repaired: true` |
| `real-newline.txt` | echter Umbruch im String | parst, `repaired: true` |
| `missing-comma.txt` | fehlendes Trennkomma | parst, `repaired: true` |
| `trailing-comma.txt` | Komma vor `}` | parst, `repaired: true` |
| `literal-backslash-n.txt` | `\n` als ZEICHEN im Text | parst, Umbruch aufgeloest |
| `truncated.txt` | Token-Limit, Struktur offen | wirft ohne salvage, `salvaged: true` mit |
| `truncated-mid-string.txt` | Abbruch mitten im String | wirft ohne salvage, `salvaged: true` mit |
| `no-json.txt` | gar kein JSON | wirft immer |

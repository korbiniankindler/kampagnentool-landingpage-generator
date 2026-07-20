# Webinar-Kampagnen Tool

Zwei eigenständige, lose gekoppelte Module für Webinar-Kampagnen. Jedes Modul ist eine in sich geschlossene HTML-Datei — individuell anpassbar, ohne das jeweils andere Modul zu berühren.

## Module

| Datei | Modul | Zweck |
|---|---|---|
| `hardfacts-generator.html` | **Modul 1 – Hardfacts** | Copywriter-Preset wählen, Webinar-Titel und Inhalts-Bulletpoints generieren, als Hardfacts bestätigen |
| `landingpage-generator.html` | **Modul 2 – Landingpage** | Aus den Hardfacts (oder eigenem Briefing) die komplette Landingpage-Copy generieren |

**Ablauf:** Modul 1 → Preset wählen → Titel + Inhalte generieren → „Weiter zu Modul 2" → Landingpage. Über die Navigation oben rechts kann Modul 2 auch **direkt** genutzt werden (JSON-Import oder Freitext-Briefing, Preset-Auswahl dann dort).

## Kopplung zwischen den Modulen (bewusst minimal)

Die Module kennen sich nur über zwei `sessionStorage`-Keys und relative Links:

| Key | Inhalt | Richtung |
|---|---|---|
| `wkt_copy_preset` | Gewähltes Copywriter-Preset (`holistic-house`, `hellinger` oder leer) | beide Richtungen |
| `wkt_hardfacts` | Bestätigte Hardfacts als JSON | Modul 1 → Modul 2 |

Beide Dateien müssen als Geschwister im selben Verzeichnis liegen. Bei Deployment mit eigenen Routen: Konstanten `MODUL1_URL` / `MODUL2_URL` am Anfang des jeweiligen `<script>`-Blocks anpassen.

## Copywriter-Presets

Markenwissen (Regelwerk, Wissensdatenbank, Referenz-Copys) liegt in `presets/<projekt>/` — Aufbau und Pflege siehe `presets/README.md`. Beide Module laden dieselben Preset-Dateien und betten sie zusätzlich als Fallback-Snapshots ein.

**Nach jeder Änderung an `presets/*.md`:**

```sh
node sync-presets.js
```

Das Script bettet die Preset-Inhalte in **beide** HTML-Dateien ein (Fallback für `file://` oder Deployments ohne `presets/`-Ordner). Geänderte HTML-Dateien mitcommitten.

## API-Zugriff

Beide Module rufen die Claude-API ausschließlich über den Cloudflare-Worker-Proxy auf (`PROXY_URL`) — **kein API-Key im Frontend**. Der System-Prompt (Preset) wird mit Prompt Caching (1h TTL) gecacht; Folge-Requests und Feedback-Regenerierungen kosten dadurch nur einen Bruchteil.

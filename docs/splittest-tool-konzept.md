# BRANDLIFT Splittest-Tool – Konzept

Status: Entwurf zur Abstimmung, noch keine Implementierung.
Stand: 2026-08-12

## 1. Ziel

Ein Werkzeug, mit dem für Webflow-Landingpages A/B/n-Tests angelegt, ausgesteuert
und ausgewertet werden können:

- pro Webflow-Site beliebig viele Tests, pro Test beliebig viele Varianten
- Gewichtung je Variante in Prozent, jederzeit änderbar
- Conversion-Messung über die Dankeseite (gleiche Domain wie die Landingpage)
- Auswertungs-Dashboard mit Live-Zahlen: Besucher, Conversions, CR je Variante
- verlustfreie Übergabe aller Kampagnen-Parameter (UTM, fbclid, gclid …)
- ein Besucher sieht dauerhaft dieselbe Variante

## 2. Getroffene Entscheidungen

| Thema | Entscheidung |
|---|---|
| Backend | Cloudflare Workers + D1, eigene Subdomain (z. B. `ab.brandlift.de`) |
| Webflow-Domains | bleiben unangetastet, laufen **nicht** über Cloudflare |
| Dankeseite | liegt auf derselben Domain wie die Landingpage |
| Stickiness | First-Party-Cookie, 90 Tage, plus localStorage-Spiegel |
| Datenschutz | Cookie-Modus, keine IP-Speicherung, kein Fingerprinting, EU-Region |
| Mandanten | von Anfang an mehrere Webflow-Sites |
| Login | v1 ohne User-Accounts; Schreib-Endpunkte per Admin-Key geschützt |

## 3. Architektur im Überblick

```
Meta/Google Ad
      │  https://kunde.de/go/webinar-mai?utm_source=…&fbclid=…
      ▼
┌─────────────────────┐   Splitter-Page (leere Webflow-Seite, nur Head-Script)
│  Variantenzuweisung │   gewichteter Zufall, Cookie prüfen/setzen
└──────────┬──────────┘
           │ location.replace(), kompletter Query-String + #hash bleiben erhalten
           ▼
┌─────────────────────┐   Varianten-Page A / B / C (echte Webflow-Seiten)
│  Exposure-Event     │──────────────┐
└──────────┬──────────┘              │
           │ Formular                │
           ▼                         ▼
┌─────────────────────┐      ┌──────────────────────────────┐
│  Dankeseite         │─────▶│ Cloudflare Worker            │
│  Conversion-Event   │      │  /s/<siteId>.js  Snippet     │
└─────────────────────┘      │  /e              Collector   │
                             │  /api/*          Dashboard   │
                             └──────────┬───────────────────┘
                                        ▼
                                   D1 (SQLite)
                                        ▲
                             ┌──────────┴───────────────────┐
                             │ Dashboard (statisch, in      │
                             │ diesem Repo, Modul 3)        │
                             └──────────────────────────────┘
```

## 4. Das Snippet

Ein einziges Skript, einmalig im **site-weiten Head-Code** der Webflow-Site:

```html
<script src="https://ab.brandlift.de/s/SITE_ID.js"></script>
```

Danach muss in Webflow für neue Tests nichts mehr angefasst werden – nur noch
Varianten-Seiten bauen und publishen. Die Testkonfiguration ist in die
ausgelieferte JS-Datei einkompiliert (kurzer Cache, Invalidierung beim
Speichern im Dashboard), damit der Splitter **vor dem Redirect keinen
Netzwerk-Roundtrip** braucht.

Das Skript entscheidet anhand der aktuellen URL selbst, in welcher Rolle es läuft:

1. **Splitter-URL** → Variante bestimmen, Cookie setzen, weiterleiten
2. **Varianten-URL** → Exposure-Event senden
3. **Conversion-URL** → Conversion-Event senden, für jeden Test mit gültigem Cookie

### 4.1 Weiterleitung ohne Parameterverlust

- der **komplette** Query-String wird übernommen, nicht nur `utm_*`
  (deckt `fbclid`, `gclid`, `ttclid`, `msclkid`, `wbraid`, `gbraid` automatisch ab)
- eigene Parameter der Ziel-URL werden gemergt, Ad-Parameter gewinnen bei Konflikt
- `#hash` bleibt erhalten
- ergänzt werden `bl_t=<testId>` und `bl_v=<variantId>`
- `location.replace()` statt `href`, damit der Back-Button nicht in die
  Zuweisung zurückspringt
- die Landing-Parameter werden zusätzlich einmalig in `localStorage` abgelegt,
  weil das Webflow-Formular beim Redirect auf die Dankeseite alle Query-Parameter
  verliert. Dadurch kennt auch die Conversion noch Quelle und Kampagne.

### 4.2 Stickiness

- `bl_vid` – zufällige UUID des Besuchers, kein Fingerprinting
- `bl_v_<testId>=<variantId>` – Zuweisung je Test, `SameSite=Lax`, 90 Tage
- Spiegel in `localStorage`; Cookie hat Vorrang, fehlt es, wird aus dem
  localStorage wiederhergestellt
- vor jeder Zuweisung wird zuerst gelesen: geänderte Gewichte betreffen nur
  neue Besucher
- Bekannte Grenze: Safari/ITP kappt per JavaScript gesetzte Cookies auf 7 Tage.
  Für Funnels mit Conversion in derselben Session ohne Auswirkung; bei längeren
  Zyklen geht ein Teil der Wiederkehrer-Zuordnung verloren. Betrifft alle
  Varianten gleichermaßen, verzerrt die CR also nicht.

### 4.3 Zuweisung

Gewichteter Zufall über kumulierte Gewichte gegen `Math.random()`.
Gewichte müssen in Summe 100 ergeben, `0 %` pausiert eine Variante, ohne
bereits zugewiesene Besucher zu verlieren.

### 4.4 Conversion-Ziel: Dankeseite im Tool hinterlegen

Die Dankeseiten-URL wird **pro Test im Dashboard hinterlegt**, nicht im Code.
Es muss auf der Dankeseite selbst nichts eingebaut werden – das site-weite
Snippet läuft dort ohnehin mit.

Konfiguration je Test:

- **Regeltyp**: Pfad *ist genau* / *beginnt mit* / *enthält* / Regex
- **Wert**: z. B. `/danke-webinar`
- **mehrere Dankeseiten** je Test erlaubt (Liste, ODER-verknüpft), falls
  Varianten eigene Dankeseiten haben
- optionale Query-Bedingung (z. B. nur bei `?status=ok`)
- Vorbelegung aus einer Site-Vorgabe

Ablauf auf der Dankeseite: Für jeden Test mit gültigem Zuweisungs-Cookie prüft
das Snippet, ob die aktuelle URL auf dessen Conversion-Regel passt. Trifft sie
zu, geht ein Conversion-Event mit `testId` und `variantId` aus dem Cookie raus.

Beim Speichern prüft das Dashboard die Regel gegen eine eingegebene Beispiel-URL
und zeigt Treffer/kein Treffer an. Eine vertippte Dankeseite ist sonst der
Fehler, der einen kompletten Test still auf 0 % CR laufen lässt.

### 4.5 Keine Doppelzählung bei Reload

Dreifach abgesichert, weil jede einzelne Ebene umgangen werden kann:

1. **Client** – nach dem Senden wird `bl_c_<testId>_<goalId>` in Cookie und
   localStorage gesetzt. Bei Reload sieht das Snippet das Flag und sendet nicht.
2. **Server (die eigentliche Garantie)** – jedes Event trägt einen
   Idempotenz-Schlüssel `hash(visitorId + testId + goalId)` mit
   UNIQUE-Constraint in D1, geschrieben per `INSERT OR IGNORE`. Auch bei
   gelöschten Cookies, Inkognito-Reload oder doppeltem Beacon entsteht kein
   zweiter Zähler.
3. **Transport** – jedes Event hat zusätzlich eine eigene Event-UUID, die
   Retries und den bekannten `sendBeacon`-Doppelversand beim Tab-Wechsel abfängt.

Analog bei den Aufrufen: **Besucher** wird pro Besucher/Test/Session einmal
gezählt (Reload ändert nichts – das ist der Nenner der CR), **Aufrufe** zählt
jeden View. Die Differenz zwischen beiden ist selbst eine nützliche Kennzahl.

Bewusste Festlegung für v1: Wer zweimal echt konvertiert, wird einmal gezählt.
Für CR-Vergleiche ist das korrekt. Sobald Umsatz je Variante gemessen werden
soll, kommt ein Schalter „wiederholte Conversions zählen" dazu.

### 4.6 Sauberkeit der Daten

- `?bl_force=<variantId>` erzwingt eine Variante (QA)
- `?bl_debug=1` setzt ein Flag, das Events dauerhaft aus der Statistik ausschließt
- gefiltert werden: bekannte Bot-User-Agents, `navigator.webdriver`,
  Prefetch/Prerender (`document.prerendering`), Webflow-Editor und
  `*.webflow.io`-Staging (optional zuschaltbar für Tests)
- Direktaufrufe einer Varianten-Seite ohne Zuweisung werden separat gezählt und
  fließen nicht in den Variantenvergleich ein

## 5. Datenmodell (D1)

```
sites      (id, name, domain, snippet_key, default_goal_json, settings_json,
            created_at)
tests      (id, site_id, name, slug, splitter_path, status,
            created_at, started_at, ended_at)
goals      (id, test_id, name, match_type, match_value, query_condition, sort)
variants   (id, test_id, name, target_path, weight, is_control, sort)
events     (id, ts, site_id, test_id, variant_id, goal_id, visitor_id,
            session_id, type, dedupe_key, path, referrer, utm_source,
            utm_medium, utm_campaign, utm_content, utm_term, click_id,
            device, country, excluded)
             └── UNIQUE(dedupe_key)
rollups    (site_id, test_id, variant_id, day, visitors, views, conversions)
```

- `goals` als eigene Tabelle, damit ein Test mehrere Dankeseiten haben kann und
  später mehrere Ziele nebeneinander möglich sind (Lead und Kauf getrennt)
- `dedupe_key` ist der Idempotenz-Schlüssel aus 4.5 und trägt die
  Doppelzählungs-Sperre auf Datenbankebene
- `events` ist das Rohlog für Breakdowns und Nachrechnen
- `rollups` wird fortgeschrieben und trägt das Dashboard (schnell, günstig)
- gespeichert wird **keine IP**; das Land wird aus dem Cloudflare-Header
  abgeleitet, die IP selbst nicht persistiert

## 6. Auswertung

Je Variante: Besucher (unique), Aufrufe, Conversions, CR, Uplift gegenüber
Control. Dazu:

- **Signifikanz bayesianisch** (Beta-Binomial): „Variante B ist mit 94 %
  Wahrscheinlichkeit besser." Jederzeit ablesbar statt erst am Testende, und
  für Marketing-Entscheidungen verständlicher als ein p-Wert.
- **SRM-Check**: erwartete vs. tatsächliche Verteilung. Warnt, wenn die
  Weiterleitung irgendwo klemmt – der häufigste stille Fehler in A/B-Tests.
- **Mindest-Stichprobe**: Hinweis, ab wann die Daten überhaupt tragfähig sind
- Zeitverlauf, Breakdown nach UTM-Quelle/Kampagne und Gerät, CSV-Export
- **Live**: Zähler pollen alle 5–10 s, dazu ein Ticker der letzten Events,
  damit beim Kampagnenstart sofort sichtbar ist, ob alles läuft

## 7. Dashboard

Als weiteres statisches Modul in diesem Repo (`splittest-dashboard.html`,
Modul 3, Look der bestehenden Tools), spricht nur per `fetch` mit dem Worker.

- Site auswählen, Test anlegen: Name, Splitter-Pfad
- Conversion-Ziel: Dankeseiten-URL mit Regeltyp, mehrere möglich, inkl.
  Live-Prüfung gegen eine Beispiel-URL beim Speichern
- Varianten: Name, Zielpfad, Gewicht; Summenprüfung auf 100 %
- Status: Entwurf / läuft / pausiert / beendet
- Snippet zum Kopieren inkl. Einbau-Anleitung für Webflow
- Ergebnis-Ansicht je Test

Schreibende Endpunkte (`POST/PATCH/DELETE /api/*`) verlangen einen Admin-Key,
der im Dashboard einmal eingegeben und lokal gespeichert wird. Ohne diesen
Schutz könnte jeder mit der Dashboard-URL laufende Tests umkonfigurieren.
Der Collector `/e` bleibt offen (muss er), akzeptiert aber nur Events zu
existierenden, laufenden Tests und ist ratenbegrenzt.

## 8. Betriebsdetails

- **Adblocker**: eigene Subdomain, unauffällige Pfade (`/s/`, `/e`),
  `navigator.sendBeacon`. Ein Restverlust von wenigen Prozent bleibt, trifft
  aber alle Varianten gleich und verzerrt den CR-Vergleich nicht.
- **SEO**: Splitter- und Varianten-Seiten auf `noindex`, Canonical auf die
  Control-Variante. Es sind Ad-Landingpages, das ist unkritisch.
- **Performance**: das Snippet ist ein synchrones Head-Script (~3–4 KB gzip),
  Redirect-Hop ~100–200 ms.

## 9. Datenschutz

- First-Party-Cookie, 90 Tage, Zweck A/B-Test; Aufnahme in die
  Datenschutzerklärung der jeweiligen Marke erforderlich
- keine IP-Speicherung, kein Fingerprinting, keine Third-Party-Cookies
- Besucher-ID ist eine Zufalls-UUID ohne Personenbezug
- Datenhaltung in der EU (D1 mit EEA-Location-Hint), AV-Vertrag mit Cloudflare
- offener Punkt für die Rechtsprüfung: Nach strenger TTDSG-Lesart ist ein
  A/B-Test-Cookie einwilligungspflichtig. Der Consent-Banner erscheint jedoch
  erst nach dem Redirect, der Splitter läuft also immer vor der Einwilligung.
  Ein cookieloser Session-Modus ist als Rückfallebene vorgesehen und kann pro
  Site aktiviert werden, falls die Prüfung das verlangt.

## 10. Phasen

**P1 – MVP**
Worker mit `/s/`, `/e`, `/api/`; D1-Schema; Snippet mit Split, Stickiness,
UTM-Durchreichung, Exposure und Conversion; Dashboard zum Anlegen von Tests
und Varianten; Live-Zahlen mit CR. Ziel: erster echter Test läuft.

**P2 – Auswertung**
Bayesianische Signifikanz, SRM-Warnung, Zeitverlauf, Breakdowns, CSV-Export,
QA-Modus, Rollup-Job.

**P3 – Komfort**
Webflow-API-Anbindung: Varianten aus der echten Seitenliste per Dropdown statt
getippter Pfade, Snippet automatisch installieren und publishen. Danach
optional echte User-Accounts und Rechte je Marke.

## 11. Offene Punkte

1. Zieldomain für das Tool: `ab.brandlift.de` – die Zone `brandlift.de` müsste
   dafür bei Cloudflare liegen (nur DNS, die Webflow-Kundendomains bleiben
   außen vor). Alternativ eine separate Domain.
2. Mehrere Dankeseiten je Test sind vorgesehen (Abschnitt 4.4). Offen bleibt,
   ob v1 schon **mehrere getrennt ausgewertete Ziele** braucht (Lead und Kauf
   nebeneinander) oder ob ein Ziel je Test reicht – das Schema kann beides.
3. Umsatzwert je Conversion mitschreiben – erst später relevant?
4. Rechtsprüfung Cookie-Modus (siehe Abschnitt 9).

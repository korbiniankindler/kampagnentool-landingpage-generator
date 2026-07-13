/* Gemeinsamer Copywriter-Preset-Katalog für alle Module (Modul 1 Hardfacts,
   Modul 2 Landingpage, Startseite). Neue Kunden-Presets werden NUR hier
   eingetragen - beide Module lesen denselben Katalog. Siehe presets/README.md

   Die Auswahl wird in sessionStorage ('wkt_copy_preset') gehalten, damit sie
   beim Wechsel zwischen den Modulen erhalten bleibt. Geladene Preset-Inhalte
   werden pro Seite gecacht, damit keine Datei doppelt geladen wird. */
var CopyPresets = (function () {
  'use strict';

  /* Presets mit `referenzen` laden Regelwerk + Wissensdatenbank immer und
     dazu GENAU EINE Referenz-Copy pro Auftrag (Vorgabe im Regelwerk,
     Abschnitt 0: Referenz-Auswahl nach Register). Die Auswahl trifft das
     Tool automatisch anhand der `keywords` gegen das Kampagnen-Briefing
     (siehe pickRef) - kein manueller Auswahlschritt, keine feste Obergrenze
     an Referenzen. Der erste Eintrag ist der Default bei unklarem Auftrag
     und braucht keine Keywords. */
  var CATALOG = [
    {id: 'holistic-house', name: 'Holistic House', desc: 'Regelwerk der Brand, Referenz-Copy automatisch nach Auftrag', files: [
      'presets/holistic-house/regeln.md',
      'presets/holistic-house/wissensdatenbank.md'
    ], referenzen: [
      {id: 'b2c', name: 'B2C-Webinar', desc: 'Gold-Standard „Gesundheit neu denken" (Default)',
        file: 'presets/holistic-house/referenzen/webinar-gesundheit-neu-denken-b2c.md'},
      {id: 'b2b', name: 'B2B / Fachpublikum', desc: '„Evolution der Medizin" für Ärzte, Heilpraktiker, Coaches',
        file: 'presets/holistic-house/referenzen/webinar-evolution-der-medizin-b2b.md',
        keywords: ['b2b', 'arzt', 'ärzt', 'heilpraktiker', 'therapeut', 'mediziner', 'fachpublikum', 'fachkreise', 'behandler']},
      {id: 'nem', name: 'Themen-Webinar NEM/DAYA', desc: '„Vom Chaos zum System" mit Produktnähe',
        file: 'presets/holistic-house/referenzen/webinar-supplements-vom-chaos-zum-system.md',
        keywords: ['nem', 'supplement', 'nahrungsergänzung', 'daya', 'präparat', 'vitalstoff', 'mikronährstoff']}
    ]},
    {id: 'hellinger', name: 'Hellinger', desc: 'Regelwerk der Brand', files: [
      'presets/hellinger/regeln.md'
    ]}
  ];

  var STORAGE_KEY = 'wkt_copy_preset';
  var cache = {};

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getSelected() {
    try { return sessionStorage.getItem(STORAGE_KEY) || null; } catch (e) { return null; }
  }

  function setSelected(id) {
    try {
      if (id) sessionStorage.setItem(STORAGE_KEY, id);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  }

  /* Automatische Referenz-Wahl: zählt Treffer der `keywords` jeder Referenz
     im Kampagnen-Briefing (case-insensitiv, mit linker Wortgrenze, damit
     z.B. "nem" nicht in "einem" matcht) und nimmt die Referenz mit den
     meisten Treffern. Ohne Treffer gilt der erste Eintrag - laut Regelwerk
     der Default bei unklarem Auftrag. Bewusst eine Heuristik statt eines
     Klassifikator-Requests: kostet null Tokens und null Latenz; die
     Register-Begriffe (Ärzte, NEM, ...) stehen in echten Briefings praktisch
     immer wörtlich drin. Gibt null zurück, wenn das Preset keine Referenzen
     hat. */
  function pickRef(preset, briefing) {
    if (!preset || !preset.referenzen || !preset.referenzen.length) return null;
    var t = String(briefing || '').toLowerCase();
    var best = preset.referenzen[0], bestScore = 0;
    preset.referenzen.forEach(function (r) {
      var score = 0;
      (r.keywords || []).forEach(function (kw) {
        var m = t.match(new RegExp('(^|[^a-z0-9äöüß])' + kw, 'g'));
        if (m) score += m.length;
      });
      if (score > bestScore) { best = r; bestScore = score; }
    });
    return best;
  }

  /* Öffentliche Variante für Anzeige/Diagnose (z.B. Tests, Hinweistexte). */
  function autoRef(presetId, briefing) {
    return pickRef(CATALOG.find(function (p) { return p.id === presetId; }), briefing);
  }

  /* Lädt eine einzelne Preset-Datei. Reihenfolge:
     1. fetch vom Server (immer aktuellste Version, wenn gehostet)
     2. Fallback: eingebetteter Snapshot aus dem PRESET-DATA-Block der
        jeweiligen Modul-HTML (funktioniert auch bei file:// oder wenn
        presets/ nicht mit deployed wurde). Snapshots erzeugt
        `node sync-presets.js`. */
  async function fetchFile(file) {
    try {
      var resp = await fetch(file);
      if (resp.ok) {
        var text = (await resp.text()).trim();
        if (text) return { text: text, source: 'live' };
        console.warn('Preset-Datei ist leer auf dem Server: ' + file);
      } else {
        console.warn('Preset-Datei nicht auf dem Server (HTTP ' + resp.status + '): ' + file + ' - nutze eingebetteten Snapshot.');
      }
    } catch (e) {
      console.warn('Preset-Datei nicht per fetch ladbar (' + e.message + '): ' + file + ' - nutze eingebetteten Snapshot.');
    }
    var el = document.querySelector('script[type="text/plain"][data-preset-file="' + file + '"]');
    var embedded = el ? el.textContent.trim() : '';
    if (embedded) return { text: embedded, source: 'eingebettet' };
    throw new Error('Preset-Datei weder vom Server ladbar noch eingebettet: ' + file + '. Nach Änderungen an presets/ muss "node sync-presets.js" ausgeführt werden.');
  }

  /* Lädt die Dateien eines Presets als einen zusammengefügten Text:
     alle `files` (Regelwerk, Wissensdatenbank) plus - falls das Preset
     Referenzen definiert - genau die eine per Briefing-Heuristik gewählte
     Referenz-Copy (ohne Briefing: der Default). Wirft bei Fehlern, statt
     still ohne Markenwissen weiterzumachen. */
  async function load(id, briefing) {
    if (!id) return '';
    var preset = CATALOG.find(function (p) { return p.id === id; });
    // Unbekannte IDs sind ein Programmier-/Datenfehler: laut scheitern statt
    // still ohne Markenwissen zu generieren.
    if (!preset) throw new Error('Unbekanntes Copywriter-Preset: "' + id + '" (nicht im CATALOG in shared/copywriter-presets.js)');
    var ref = pickRef(preset, briefing);
    var cacheKey = ref ? id + '::' + ref.id : id;
    if (cache[cacheKey] !== undefined) return cache[cacheKey];
    var files = ref ? preset.files.concat([ref.file]) : preset.files;
    var parts = await Promise.all(files.map(fetchFile));
    var text = parts.map(function (p) { return p.text; }).join('\n\n---\n\n');
    var sources = parts.map(function (p) { return p.source; });
    cache[cacheKey] = text;
    console.log('Copywriter-Preset "' + preset.name + '" geladen: ' + files.length + ' Dateien' + (ref ? ' (Referenz: ' + ref.name + ')' : '') + ', ' + Math.round(text.length / 1024) + ' KB (Quellen: ' + sources.join(', ') + ')');
    return text;
  }

  /* Rendert den Preset-Picker (inkl. "Kein Preset") in einen Container.
     onSelect(id|null) wird bei Klick aufgerufen - die Seite kümmert sich
     selbst um State + Re-Render. Nutzt die .preset-card Styles der Module.
     Die Referenz-Copy wird nicht mehr manuell gewählt, sondern beim Laden
     automatisch per Briefing-Heuristik bestimmt (siehe pickRef). */
  function renderPicker(container, selectedId, onSelect) {
    var all = [{ id: null, name: 'Kein Preset', desc: 'Generisch anhand der Kampagnen-Angaben generieren' }].concat(CATALOG);
    var checkedSvg = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
    var html = all.map(function (p, i) {
      var sel = selectedId === p.id;
      return '<div class="preset-card' + (sel ? ' selected' : '') + '" data-preset-idx="' + i + '">' +
        '<div class="preset-card-name"><div class="preset-check">' + (sel ? checkedSvg : '') + '</div>' + esc(p.name) + '</div>' +
        '<div class="preset-card-desc">' + esc(p.desc) + '</div>' +
        '</div>';
    }).join('');
    container.innerHTML = html;
    Array.prototype.forEach.call(container.querySelectorAll('.preset-card[data-preset-idx]'), function (card) {
      card.addEventListener('click', function () {
        onSelect(all[parseInt(card.getAttribute('data-preset-idx'), 10)].id);
      });
    });
  }

  function getName(id) {
    if (!id) return null;
    var p = CATALOG.find(function (x) { return x.id === id; });
    return p ? p.name : id;
  }

  /* Baut die system-Blöcke für Claude-Requests. Das Preset (~22k Tokens)
     steht als eigener, über alle Module byte-identischer Block ZUERST und
     trägt den Cache-Breakpoint. Prompt-Caching ist ein exakter Präfix-Match:
     nur wenn der Anfang des System-Prompts überall identisch ist, teilen
     sich Modul 1 (Titel + Inhalte), Modul 2 (Landingpage) und alle
     Regenerierungen EINEN Prompt-Cache. Vorher baute jedes Modul einen
     leicht anderen System-Prompt und zahlte damit je einen eigenen
     Cache-Write zum 2x-Preis (~50% der Gesamtkosten eines Durchlaufs).
     Die kleinen modulspezifischen Instruktionen folgen dahinter uncached,
     damit sie den gemeinsamen Präfix nicht invalidieren.
     TTL 1h: der einmalige Write kostet 2x statt 1.25x, dafür bleibt der
     Cache über die ganze Arbeitssession (Modulwechsel, Lese-Pausen,
     Feedback-Runden) warm - alle Folge-Requests zahlen nur ~10%. */
  function systemBlocks(presetText, instructions) {
    if (!presetText) return [{ type: 'text', text: instructions }];
    return [
      {
        type: 'text',
        text: 'COPYWRITER-PRESET DER MARKE (Regelwerk, Wissensdatenbank, Referenz-Copys) - die Arbeitsanweisungen dazu folgen am Ende des System-Prompts:\n\n' + presetText,
        cache_control: { type: 'ephemeral', ttl: '1h' }
      },
      { type: 'text', text: instructions }
    ];
  }

  return { CATALOG: CATALOG, getSelected: getSelected, setSelected: setSelected, autoRef: autoRef, load: load, getName: getName, renderPicker: renderPicker, systemBlocks: systemBlocks };
})();

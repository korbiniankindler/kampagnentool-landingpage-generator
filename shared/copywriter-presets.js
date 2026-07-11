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
     Abschnitt 0: Referenz-Auswahl nach Register). Der erste Eintrag ist
     der Default bei unklarem Auftrag. */
  var CATALOG = [
    {id: 'holistic-house', name: 'Holistic House', desc: 'Regelwerk der Brand', files: [
      'presets/holistic-house/regeln.md',
      'presets/holistic-house/wissensdatenbank.md'
    ], referenzen: [
      {id: 'b2c', name: 'B2C-Webinar', desc: 'Gold-Standard „Gesundheit neu denken" (Default)',
        file: 'presets/holistic-house/referenzen/webinar-gesundheit-neu-denken-b2c.md'},
      {id: 'b2b', name: 'B2B / Fachpublikum', desc: '„Evolution der Medizin" für Ärzte, Heilpraktiker, Coaches',
        file: 'presets/holistic-house/referenzen/webinar-evolution-der-medizin-b2b.md'},
      {id: 'nem', name: 'Themen-Webinar NEM/DAYA', desc: '„Vom Chaos zum System" mit Produktnähe',
        file: 'presets/holistic-house/referenzen/webinar-supplements-vom-chaos-zum-system.md'}
    ]},
    {id: 'hellinger', name: 'Hellinger', desc: 'Regelwerk der Brand', files: [
      'presets/hellinger/regeln.md'
    ]}
  ];

  var STORAGE_KEY = 'wkt_copy_preset';
  var STORAGE_KEY_REF = 'wkt_copy_preset_ref'; // Register-/Referenz-Wahl je Preset (JSON-Map)
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

  /* Gewählte Referenz-Copy (Register) eines Presets. Fällt bei fehlender
     oder unbekannter Wahl auf den ersten Eintrag zurück - laut Regelwerk
     der Default bei unklarem Auftrag. Gibt null zurück, wenn das Preset
     keine wählbaren Referenzen hat. */
  function getSelectedRef(presetId) {
    var preset = CATALOG.find(function (p) { return p.id === presetId; });
    if (!preset || !preset.referenzen || !preset.referenzen.length) return null;
    var refId = null;
    try {
      var map = JSON.parse(sessionStorage.getItem(STORAGE_KEY_REF) || '{}');
      refId = map[presetId] || null;
    } catch (e) {}
    return preset.referenzen.find(function (r) { return r.id === refId; }) || preset.referenzen[0];
  }

  function setSelectedRef(presetId, refId) {
    try {
      var map = JSON.parse(sessionStorage.getItem(STORAGE_KEY_REF) || '{}');
      map[presetId] = refId;
      sessionStorage.setItem(STORAGE_KEY_REF, JSON.stringify(map));
    } catch (e) {}
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
     Referenzen definiert - genau die eine gewählte Referenz-Copy.
     Wirft bei Fehlern, statt still ohne Markenwissen weiterzumachen. */
  async function load(id) {
    if (!id) return '';
    var ref = getSelectedRef(id);
    var cacheKey = ref ? id + '::' + ref.id : id;
    if (cache[cacheKey] !== undefined) return cache[cacheKey];
    var preset = CATALOG.find(function (p) { return p.id === id; });
    // Unbekannte IDs sind ein Programmier-/Datenfehler: laut scheitern statt
    // still ohne Markenwissen zu generieren.
    if (!preset) throw new Error('Unbekanntes Copywriter-Preset: "' + id + '" (nicht im CATALOG in shared/copywriter-presets.js)');
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
     Hat das gewählte Preset wählbare Referenzen (Register), erscheint
     darunter die Auswahl "welche Referenz-Copy für diesen Auftrag" -
     es wird immer genau eine geladen. */
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
    var selectedPreset = CATALOG.find(function (p) { return p.id === selectedId; });
    if (selectedPreset && selectedPreset.referenzen && selectedPreset.referenzen.length) {
      var selRef = getSelectedRef(selectedId);
      html += '<div style="grid-column:1/-1;margin-top:2px">' +
        '<div style="font-size:11px;font-weight:600;letter-spacing:.02em;text-transform:uppercase;color:var(--text-tertiary,#888);margin-bottom:6px">Referenz-Copy für diesen Auftrag (genau eine wird geladen)</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px">' +
        selectedPreset.referenzen.map(function (r) {
          var sel = selRef && selRef.id === r.id;
          return '<div class="preset-card' + (sel ? ' selected' : '') + '" data-ref-id="' + esc(r.id) + '">' +
            '<div class="preset-card-name"><div class="preset-check">' + (sel ? checkedSvg : '') + '</div>' + esc(r.name) + '</div>' +
            '<div class="preset-card-desc">' + esc(r.desc) + '</div>' +
            '</div>';
        }).join('') +
        '</div></div>';
    }
    container.innerHTML = html;
    Array.prototype.forEach.call(container.querySelectorAll('.preset-card[data-preset-idx]'), function (card) {
      card.addEventListener('click', function () {
        onSelect(all[parseInt(card.getAttribute('data-preset-idx'), 10)].id);
      });
    });
    Array.prototype.forEach.call(container.querySelectorAll('.preset-card[data-ref-id]'), function (card) {
      card.addEventListener('click', function () {
        setSelectedRef(selectedId, card.getAttribute('data-ref-id'));
        // onSelect mit unveränderter Preset-ID: Seite re-rendert den Picker
        // und lädt das Preset neu (jetzt mit der gewählten Referenz).
        onSelect(selectedId);
      });
    });
  }

  function getName(id) {
    if (!id) return null;
    var p = CATALOG.find(function (x) { return x.id === id; });
    if (!p) return id;
    var ref = getSelectedRef(id);
    return ref ? p.name + ' · Referenz: ' + ref.name : p.name;
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

  return { CATALOG: CATALOG, getSelected: getSelected, setSelected: setSelected, getSelectedRef: getSelectedRef, setSelectedRef: setSelectedRef, load: load, getName: getName, renderPicker: renderPicker, systemBlocks: systemBlocks };
})();

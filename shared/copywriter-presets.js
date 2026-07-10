/* Gemeinsamer Copywriter-Preset-Katalog für alle Module (Modul 1 Hardfacts,
   Modul 2 Landingpage, Startseite). Neue Kunden-Presets werden NUR hier
   eingetragen - beide Module lesen denselben Katalog. Siehe presets/README.md

   Die Auswahl wird in sessionStorage ('wkt_copy_preset') gehalten, damit sie
   beim Wechsel zwischen den Modulen erhalten bleibt. Geladene Preset-Inhalte
   werden pro Seite gecacht, damit keine Datei doppelt geladen wird. */
var CopyPresets = (function () {
  'use strict';

  var CATALOG = [
    {id: 'holistic-house', name: 'Holistic House', desc: 'Regelwerk der Brand', files: [
      'presets/holistic-house/regeln.md',
      'presets/holistic-house/wissensdatenbank.md',
      'presets/holistic-house/referenzen/webinar-gesundheit-neu-denken-b2c.md',
      'presets/holistic-house/referenzen/webinar-stille-gesundheitskrise-b2c.md',
      'presets/holistic-house/referenzen/webinar-supplements-vom-chaos-zum-system.md',
      'presets/holistic-house/referenzen/webinar-supplements-wissenschaftlich-geprueft.md',
      'presets/holistic-house/referenzen/webinar-evolution-der-medizin-b2b.md'
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

  /* Lädt alle Dateien eines Presets als einen zusammengefügten Text.
     Wirft bei Fehlern, statt still ohne Markenwissen weiterzumachen. */
  async function load(id) {
    if (!id) return '';
    if (cache[id] !== undefined) return cache[id];
    var preset = CATALOG.find(function (p) { return p.id === id; });
    if (!preset) return '';
    var parts = await Promise.all(preset.files.map(fetchFile));
    var text = parts.map(function (p) { return p.text; }).join('\n\n---\n\n');
    var sources = parts.map(function (p) { return p.source; });
    cache[id] = text;
    console.log('Copywriter-Preset "' + preset.name + '" geladen: ' + preset.files.length + ' Dateien, ' + Math.round(text.length / 1024) + ' KB (Quellen: ' + sources.join(', ') + ')');
    return text;
  }

  /* Rendert den Preset-Picker (inkl. "Kein Preset") in einen Container.
     onSelect(id|null) wird bei Klick aufgerufen - die Seite kümmert sich
     selbst um State + Re-Render. Nutzt die .preset-card Styles der Module. */
  function renderPicker(container, selectedId, onSelect) {
    var all = [{ id: null, name: 'Kein Preset', desc: 'Generisch anhand der Kampagnen-Angaben generieren' }].concat(CATALOG);
    var checkedSvg = '<svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
    container.innerHTML = all.map(function (p, i) {
      var sel = selectedId === p.id;
      return '<div class="preset-card' + (sel ? ' selected' : '') + '" data-preset-idx="' + i + '">' +
        '<div class="preset-card-name"><div class="preset-check">' + (sel ? checkedSvg : '') + '</div>' + esc(p.name) + '</div>' +
        '<div class="preset-card-desc">' + esc(p.desc) + '</div>' +
        '</div>';
    }).join('');
    Array.prototype.forEach.call(container.querySelectorAll('.preset-card'), function (card) {
      card.addEventListener('click', function () {
        onSelect(all[parseInt(card.getAttribute('data-preset-idx'), 10)].id);
      });
    });
  }

  return { CATALOG: CATALOG, getSelected: getSelected, setSelected: setSelected, load: load, renderPicker: renderPicker };
})();

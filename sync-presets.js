#!/usr/bin/env node
/* Bettet alle presets/**\/*.md (außer README.md) als inaktive
   <script type="text/plain">-Blöcke in landingpage-generator.html ein.
   Das Tool nutzt diese Snapshots als Fallback, wenn die Dateien nicht
   per fetch ladbar sind (file:// oder presets/ nicht mit deployed).

   Nach jeder Änderung an den Preset-Dateien ausführen:
     node sync-presets.js
   und beide (presets/ + landingpage-generator.html) committen. */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_FILE = path.join(__dirname, 'landingpage-generator.html');
const PRESET_DIR = path.join(__dirname, 'presets');
const START = '<!-- PRESET-DATA:START (generiert von sync-presets.js - nicht von Hand editieren, Quelle sind die presets/*.md Dateien) -->';
const END = '<!-- PRESET-DATA:END -->';

function collectMd(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectMd(p));
    else if (entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') out.push(p);
  }
  return out.sort();
}

const files = collectMd(PRESET_DIR);
const blocks = files.map((f) => {
  const rel = path.relative(__dirname, f).split(path.sep).join('/');
  const text = fs.readFileSync(f, 'utf8').trim();
  if (text.toLowerCase().includes('</script')) {
    throw new Error('"</script" darf in Preset-Dateien nicht vorkommen: ' + rel);
  }
  return '<script type="text/plain" data-preset-file="' + rel + '">\n' + text + '\n</script>';
});

const html = fs.readFileSync(HTML_FILE, 'utf8');
const startIdx = html.indexOf(START);
const endIdx = html.indexOf(END);
if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
  throw new Error('PRESET-DATA-Marker nicht in ' + HTML_FILE + ' gefunden');
}
const updated = html.slice(0, startIdx + START.length) + '\n' + blocks.join('\n') + '\n' + html.slice(endIdx);
fs.writeFileSync(HTML_FILE, updated);

const kb = Math.round(blocks.join('\n').length / 1024);
console.log(files.length + ' Preset-Dateien eingebettet (' + kb + ' KB):');
files.forEach((f) => console.log('  ' + path.relative(__dirname, f)));

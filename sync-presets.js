#!/usr/bin/env node
/* Bettet alle presets/**\/*.md (außer README.md) als inaktive
   <script type="text/plain">-Blöcke in die Modul-HTMLs ein.
   Die Tools nutzen diese Snapshots als Fallback, wenn die Dateien nicht
   per fetch ladbar sind (file:// oder presets/ nicht mit deployed).

   Nach jeder Änderung an den Preset-Dateien ausführen:
     node sync-presets.js
   und alles (presets/ + beide Modul-HTMLs) committen.

   --check schreibt nichts und meldet per Exit-Code 1, ob die eingebetteten
   Snapshots noch zu presets/ passen. Laeuft in der CI: driften sie
   auseinander, generiert das Tool still mit veraltetem Markenwissen, sobald
   der Fallback greift (file:// oder presets/ nicht mit deployt) - und genau
   das soll der Fallback ja verhindern. */
'use strict';
const fs = require('fs');
const path = require('path');

const HTML_FILES = [
  path.join(__dirname, 'landingpage-generator.html'),
  path.join(__dirname, 'hardfacts-generator.html'),
];
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

const checkOnly = process.argv.includes('--check');
const stale = [];

for (const htmlFile of HTML_FILES) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  const startIdx = html.indexOf(START);
  const endIdx = html.indexOf(END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error('PRESET-DATA-Marker nicht in ' + htmlFile + ' gefunden');
  }
  const updated = html.slice(0, startIdx + START.length) + '\n' + blocks.join('\n') + '\n' + html.slice(endIdx);
  if (checkOnly) {
    if (updated !== html) stale.push(path.basename(htmlFile));
    continue;
  }
  if (updated === html) {
    console.log(path.basename(htmlFile) + ' war bereits aktuell.');
  } else {
    fs.writeFileSync(htmlFile, updated);
    console.log(path.basename(htmlFile) + ' aktualisiert.');
  }
}

if (checkOnly) {
  if (stale.length) {
    console.error('Eingebettete Preset-Snapshots sind veraltet in: ' + stale.join(', '));
    console.error('Bitte "node sync-presets.js" ausfuehren und die HTMLs mitcommitten.');
    process.exit(1);
  }
  console.log('Preset-Snapshots sind aktuell (' + files.length + ' Dateien).');
  process.exit(0);
}

const kb = Math.round(blocks.join('\n').length / 1024);
console.log(files.length + ' Preset-Dateien eingebettet (' + kb + ' KB pro HTML):');
files.forEach((f) => console.log('  ' + path.relative(__dirname, f)));

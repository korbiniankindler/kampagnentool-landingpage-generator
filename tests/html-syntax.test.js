/* Syntaxpruefung fuer das Inline-JavaScript der Modul-HTMLs.

   Die beiden Module tragen zusammen rund 5.000 Zeilen JavaScript direkt im
   HTML. Ohne Build-Schritt faellt ein Syntaxfehler sonst erst im Browser auf -
   und dann als weisse Seite. Dieser Test parst die Inline-Bloecke und die
   shared/*.js und schlaegt an, bevor irgendetwas deployt wird.

   Geprueft wird die Syntax, nicht das Verhalten. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const HTML_FILES = ['index.html', 'hardfacts-generator.html', 'landingpage-generator.html'];
const SHARED = ['json-extract.js', 'copywriter-presets.js', 'api-client.js', 'versions.js'];

/* Holt nur echte Skriptbloecke: kein src-Attribut und kein
   type="text/plain" (das sind die eingebetteten Preset-Snapshots). */
function inlineScripts(html) {
  const out = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    if (/type\s*=\s*["']text\/plain["']/i.test(attrs)) continue;
    out.push(m[2]);
  }
  return out;
}

for (const file of HTML_FILES) {
  test(`${file}: Inline-JavaScript ist syntaktisch gueltig`, () => {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const blocks = inlineScripts(html);
    assert.ok(blocks.length > 0, 'mindestens ein Inline-Skriptblock erwartet');
    blocks.forEach((code, i) => {
      assert.doesNotThrow(
        () => new vm.Script(code, { filename: `${file}#inline-${i}` }),
        `Syntaxfehler im Inline-Skript ${i} von ${file}`
      );
    });
  });
}

for (const file of SHARED) {
  test(`shared/${file}: syntaktisch gueltig`, () => {
    const code = fs.readFileSync(path.join(ROOT, 'shared', file), 'utf8');
    assert.doesNotThrow(() => new vm.Script(code, { filename: `shared/${file}` }));
  });
}

test('Modul-HTMLs binden die geteilten Skripte ein', () => {
  // Reihenfolge ist relevant: versions.js und api-client.js muessen vor dem
  // Inline-Block stehen, der sie benutzt.
  for (const file of ['hardfacts-generator.html', 'landingpage-generator.html']) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const s of ['shared/versions.js', 'shared/json-extract.js', 'shared/api-client.js', 'shared/copywriter-presets.js']) {
      assert.ok(html.includes(`src="${s}"`), `${file} bindet ${s} nicht ein`);
    }
    const firstInline = html.indexOf('<script>\nvar PROXY_URL');
    const apiClientTag = html.indexOf('src="shared/api-client.js"');
    assert.ok(apiClientTag !== -1 && (firstInline === -1 || apiClientTag < firstInline),
      `${file}: api-client.js muss vor dem Inline-Block geladen werden`);
  }
});

test('PRESET-DATA-Bloecke bleiben unangetastet und werden nicht als Code geparst', () => {
  for (const file of ['hardfacts-generator.html', 'landingpage-generator.html']) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(html.includes('<!-- PRESET-DATA:START'), `${file}: PRESET-DATA-Startmarker fehlt`);
    assert.ok(html.includes('<!-- PRESET-DATA:END -->'), `${file}: PRESET-DATA-Endmarker fehlt`);
    const plain = (html.match(/type="text\/plain" data-preset-file=/g) || []).length;
    assert.equal(plain, 9, `${file}: 9 eingebettete Preset-Dateien erwartet, gefunden ${plain}`);
  }
});

test('Versionsangabe im Header stimmt mit ToolVersions.APP_VERSION ueberein', () => {
  const versions = require('../shared/versions.js');
  for (const file of HTML_FILES) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const m = html.match(/<span class="brand-version">Version ([\d.]+)<\/span>/);
    assert.ok(m, `${file}: keine Versionsangabe im Header gefunden`);
    assert.equal(m[1], versions.APP_VERSION,
      `${file} zeigt Version ${m[1]}, ToolVersions sagt ${versions.APP_VERSION}`);
  }
});

/* Markiert Zeilen, die in einem Blockkommentar liegen. Bewusst simpel: die
   Modul-HTMLs enthalten keine `/*`-Sequenzen in String-Literalen. */
function commentLineFlags(text) {
  const lines = text.split('\n');
  const flags = [];
  let inBlock = false;
  for (const line of lines) {
    const startedInBlock = inBlock;
    let isComment = startedInBlock;
    let rest = line;
    while (true) {
      if (inBlock) {
        const end = rest.indexOf('*/');
        if (end === -1) break;
        rest = rest.slice(end + 2); inBlock = false;
      } else {
        const start = rest.indexOf('/*');
        if (start === -1) break;
        if (start === 0 || /^\s*$/.test(rest.slice(0, start))) isComment = true;
        rest = rest.slice(start + 2); inBlock = true;
      }
    }
    if (!isComment && /^\s*(\/\/|\*)/.test(line)) isComment = true;
    flags.push(isComment);
  }
  return { lines, flags };
}

test('kein salvage mehr im Erfolgspfad der Module', () => {
  // Regressionsschutz fuer den P0-Fix: {salvage:true} darf nur noch in den
  // ausgewiesenen Quarantaene-Pfaden vorkommen, nie als regulaerer Rueckgabewert.
  for (const file of ['hardfacts-generator.html', 'landingpage-generator.html']) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const { lines, flags } = commentLineFlags(html);
    lines.forEach((line, i) => {
      if (flags[i]) return;                     // Kommentare duerfen den alten Code zitieren
      if (!/salvage:\s*true/.test(line)) return;
      const context = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
      assert.ok(
        /quarantine|recovered|Quarantaene/i.test(context),
        `${file}:${i + 1} nutzt salvage ausserhalb eines Quarantaene-Pfads: ${line.trim()}`
      );
    });
  }
});

test('implizites globales `event` wird nicht mehr benutzt', () => {
  for (const file of HTML_FILES) {
    const html = fs.readFileSync(path.join(ROOT, file), 'utf8');
    inlineScripts(html).forEach((code) => {
      // `event` als freie Variable in Funktionskoerpern (nicht als Parameter,
      // nicht in inline-onclick-Attributen, die ausserhalb der Skripte stehen)
      assert.ok(!/[^.\w]event\.target/.test(code),
        `${file}: benutzt das implizite globale \`event\``);
    });
  }
});

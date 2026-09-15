#!/usr/bin/env node
/* Headless-Runner fuer die Landingpage-Pipeline.

   Faehrt dieselbe Pipeline wie Modul 2, ohne Browser und ohne UI: Preset
   laden, Content-Plan, Section-Generierung, deterministischer Hero-Merge,
   Quality Gate. Er nutzt dafuer die GLEICHEN shared/-Module wie das Tool -
   ein Runner mit eigener Prompt-Logik wuerde etwas anderes messen als das,
   was die Mitarbeiter benutzen.

   Zweck ist der Vergleich mehrerer Generierungsvarianten (Gate G1), nicht
   das Ersetzen des Tools.

   Aufruf:
     node eval/runner.js --dry                 alle Faelle, gemockte Antworten
     node eval/runner.js --fall hellinger-b2c  ein Fall
     node eval/runner.js --variante zweiblock  Generierungsvariante
     node eval/runner.js --live                echte API-Calls (kostet Geld)
     node eval/runner.js --wiederholungen 3    fuer die Varianz-Messung

   Ohne --live wird nichts an die API geschickt. */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
global.SectionSchemas = require(path.join(ROOT, 'shared/section-schemas.js'));
global.BrandConfig = require(path.join(ROOT, 'shared/brand-config.js'));
const PromptBuilder = require(path.join(ROOT, 'shared/prompt-builder.js'));
const Validators = require(path.join(ROOT, 'shared/validators.js'));
const CopyPresets = require(path.join(ROOT, 'shared/copywriter-presets.js'));
const HardfactsIO = require(path.join(ROOT, 'shared/hardfacts.js'));
const ClaudeAPI = require(path.join(ROOT, 'shared/api-client.js'));
const ToolVersions = require(path.join(ROOT, 'shared/versions.js'));
const { extractJSON } = require(path.join(ROOT, 'shared/json-extract.js'));

const PROXY_URL = process.env.PROXY_URL || 'https://claude.korbinian.workers.dev/';
const GEN_CHUNK_SIZE = 4;

/* ---------- Argumente ---------- */
function args() {
  const a = process.argv.slice(2);
  const get = (n, d) => { const i = a.indexOf('--' + n); return i === -1 ? d : a[i + 1]; };
  return {
    live: a.includes('--live'),
    fall: get('fall', null),
    variante: get('variante', 'chunk'),      // chunk | zweiblock
    reviewer: a.includes('--reviewer'),
    wiederholungen: parseInt(get('wiederholungen', '1'), 10),
    out: get('out', path.join(__dirname, 'ergebnisse'))
  };
}

/* ---------- Preset laden (in Node direkt von der Platte) ---------- */
function ladePreset(presetId, briefing) {
  if (!presetId) return { text: '', refId: null };
  const preset = CopyPresets.CATALOG.find(p => p.id === presetId);
  if (!preset) throw new Error('Unbekanntes Preset: ' + presetId);
  const ref = CopyPresets.pickRef(preset, briefing);
  const dateien = ref ? preset.files.concat([ref.file]) : preset.files;
  const text = dateien.map(f => fs.readFileSync(path.join(ROOT, f), 'utf8').trim()).join('\n\n---\n\n');
  return { text, refId: ref ? ref.id : null };
}

/* ---------- API ---------- */
async function call(body, opts) {
  if (!('thinking' in body)) body.thinking = { type: 'disabled' };
  return ClaudeAPI.send(body, opts);
}

/* Gemockte Antwort fuer --dry: strukturell korrekt, inhaltlich Platzhalter.
   Damit laesst sich der Runner selbst pruefen, ohne Tokens zu verbrauchen. */
function mockAntwort(body) {
  /* Den Prompt-Text direkt lesen, nicht JSON.stringify: dort waeren die
     Anfuehrungszeichen escaped und die Section-Keys nicht auffindbar. */
  const usr = (body.messages || []).map(m =>
    typeof m.content === 'string' ? m.content
      : (m.content || []).map(b => b.text || '').join('')).join('\n');
  if (/Erstelle einen Content-Plan/.test(usr)) {
    const keys = [...usr.matchAll(/"([a-z_0-9]+)": "\.\.\."/g)].map(m => m[1]);
    return Object.fromEntries(keys.map(k => [k, 'Kernbotschaft fuer ' + k]));
  }
  const keys = [...usr.matchAll(/"([a-z_0-9]+)": \{/g)].map(m => m[1]);
  const out = {};
  keys.forEach(id => {
    const sch = global.SectionSchemas.get(id);
    if (!sch) { out[id] = { headline: 'Platzhalter', bodyCopy: 'Text fuer ' + id }; return; }
    const d = {};
    global.SectionSchemas.modelFields(id).forEach(f => {
      if (f.kind === 'text') { d[f.name] = 'Platzhalter fuer ' + f.name + ' in ' + id; return; }
      const n = f.min || 3;
      d[f.name] = Array.from({ length: n }, (_, i) =>
        f.of ? Object.fromEntries(f.of.map(k => [k, k + ' ' + (i + 1)])) : 'Absatz ' + (i + 1));
    });
    out[id] = d;
  });
  return out;
}

async function jsonCall(body, live, label) {
  if (!live) return { data: mockAntwort(body), truncated: false, mock: true };
  const d = await call(body, { label });
  return { data: extractJSON(ClaudeAPI.textOf(d)), truncated: ClaudeAPI.isTruncated(d), usage: d.usage };
}

/* ---------- Pipeline ---------- */
async function laufe(fall, opt) {
  const t0 = Date.now();
  const { hf } = HardfactsIO.migrate(fall.hardfacts);
  const active = fall.sections.filter(s => s.active !== false);
  const briefing = [hf.kampagnenname, hf.titel, hf.beschreibung, hf.zielgruppe, hf.offer].filter(Boolean).join('\n');

  const { text: rawPreset, refId } = ladePreset(fall.preset, briefing);
  const brandCfg = global.BrandConfig.forPreset(rawPreset);
  const presetText = rawPreset ? global.BrandConfig.stripFromPrompt(rawPreset) : '';
  const lpVorlage = global.BrandConfig.vorlage(brandCfg, fall.lpVorlage);

  const instr = [
    'Du bist ein Team aus Senior Online-Marketing-Stratege, Conversion-Copywriter und UI/UX-Designer.',
    'Du schreibst komplette deutsche Landingpages fuer Anmeldungen und Angebote.',
    presetText ? 'WICHTIG: Am Anfang dieses System-Prompts steht das Copywriter-Preset der Marke. Halte dich strikt an das Regelwerk.' : '',
    'KRITISCH: Antworte AUSSCHLIESSLICH mit einem einzigen gueltigen JSON-Objekt.'
  ].filter(Boolean).join('\n');
  const sysBlocks = CopyPresets.systemBlocks(presetText, instr);

  const gemeinsam = {
    hf, zielgruppe: HardfactsIO.audience(hf), strategie: hf.strategie || '',
    ctxBlock: fall.kontext ? 'Zusaetzlicher Kontext:\n' + fall.kontext + '\n' : '',
    pageMap: PromptBuilder.buildPageMap(active), brandCfg, lpVorlage
  };

  /* Content-Plan */
  let planText = null, planFehler = null;
  try {
    const planUsr = 'Kampagne:\nTitel: ' + (hf.titel || '') + '\nZielgruppe: ' +
      (HardfactsIO.audience(hf) || '(keine Angabe)') + '\n\nAufbau der Landingpage:\n' +
      gemeinsam.pageMap + '\n\nErstelle einen Content-Plan: eine Kernbotschaft je Section, je ein Satz.\n\n' +
      'Antworte NUR mit einem JSON-Objekt:\n{ ' + active.map(s => '"' + s.id + '": "..."').join(', ') + ' }';
    const r = await jsonCall({
      model: ToolVersions.MODEL, max_tokens: Math.min(4000, 400 + active.length * 120),
      system: sysBlocks, messages: [{ role: 'user', content: planUsr }]
    }, opt.live, 'Plan');
    planText = active.map((s, i) => r.data[s.id] ? `${i + 1}. ${s.name} (${s.id}): ${r.data[s.id]}` : null)
      .filter(Boolean).join('\n') || null;
  } catch (e) { planFehler = e.message; }

  /* Sections nach Variante */
  const bloecke = opt.variante === 'zweiblock'
    ? [active.slice(0, Math.ceil(active.length / 2)), active.slice(Math.ceil(active.length / 2))]
    : Array.from({ length: Math.ceil(active.length / GEN_CHUNK_SIZE) },
        (_, i) => active.slice(i * GEN_CHUNK_SIZE, (i + 1) * GEN_CHUNK_SIZE));

  const sectionData = {};
  let truncations = 0, calls = 0;

  async function generiere(block, vorher) {
    const usr = PromptBuilder.buildChunkPrompt(Object.assign({}, gemeinsam, {
      chunk: block, planText,
      /* Nur die Zwei-Block-Variante sieht den echten Text des Vorgaengers -
         genau das ist ihr erhoffter Vorteil gegenueber parallelen Chunks. */
      nachbarn: vorher || null
    }));
    calls++;
    const r = await jsonCall({
      model: ToolVersions.MODEL, max_tokens: 16000, system: sysBlocks,
      messages: [{ role: 'user', content: usr }]
    }, opt.live, block.map(s => s.name).join(', '));
    if (r.truncated) truncations++;
    return r.data;
  }

  if (opt.variante === 'zweiblock') {
    for (let i = 0; i < bloecke.length; i++) {
      const vorher = i > 0 ? JSON.stringify(sectionData) : null;
      Object.assign(sectionData, await generiere(bloecke[i], vorher));
    }
  } else {
    const res = await Promise.all(bloecke.map(b => generiere(b, null)));
    res.forEach(r => Object.assign(sectionData, r));
  }

  /* Deterministischer Hero-Merge */
  const mergeProtokoll = [];
  if (sectionData.hero) sectionData.hero = Validators.mergeHero(sectionData.hero, hf, lpVorlage, mergeProtokoll);

  /* Quality Gate */
  const befunde = Validators.pruefeAlles({ active, sectionData, hf, brandCfg, lockedFields: {} });

  return {
    fall: fall.id, variante: opt.variante, preset: fall.preset, presetRef: refId,
    versions: ToolVersions.stamp({ preset: fall.preset, presetRef: refId }),
    dauerMs: Date.now() - t0, calls, truncations, planFehler, planVorhanden: !!planText,
    mergeKorrekturen: mergeProtokoll.length, mergeProtokoll,
    befunde: befunde.map(b => ({ schwere: b.schwere, id: b.id, section: b.section, feld: b.feld, text: b.text })),
    metriken: metriken(befunde, sectionData, active, mergeProtokoll),
    sectionData
  };
}

/* Die Groessen, die im Benchmark verglichen werden. */
function metriken(befunde, sectionData, active, mergeProtokoll) {
  const krit = befunde.filter(b => b.schwere === 'kritisch');
  const woerter = Validators.textFelder(sectionData).reduce((n, f) => n + String(f.text).split(/\s+/).filter(Boolean).length, 0);
  return {
    sectionsErwartet: active.length,
    sectionsGeliefert: Object.keys(sectionData).length,
    befundeKritisch: krit.length,
    befundeHinweis: befunde.length - krit.length,
    presetVerstoesse: befunde.filter(b => b.id.startsWith('preset-verstoss')).length,
    redundanzen: befunde.filter(b => b.id === 'redundanz').length,
    faktenAbweichungen: mergeProtokoll.length,
    leereFelder: befunde.filter(b => b.id === 'feld-leer').length,
    anzahlFehler: befunde.filter(b => b.id === 'anzahl').length,
    woerterGesamt: woerter
  };
}

/* ---------- Hauptprogramm ---------- */
async function main() {
  const opt = args();
  ClaudeAPI.configure({ proxyUrl: PROXY_URL });

  const dir = path.join(__dirname, 'faelle');
  const faelle = fs.readdirSync(dir).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .filter(f => !opt.fall || f.id === opt.fall);

  if (!faelle.length) { console.error('Keine Faelle gefunden.'); process.exit(1); }
  if (!opt.live) console.log('TROCKENLAUF - keine API-Calls. Mit --live echte Requests (kostet Geld).\n');

  fs.mkdirSync(opt.out, { recursive: true });
  const alle = [];

  for (const fall of faelle) {
    for (let w = 1; w <= opt.wiederholungen; w++) {
      const r = await laufe(fall, opt);
      r.wiederholung = w;
      alle.push(r);
      const m = r.metriken;
      console.log(
        `${r.fall.padEnd(22)} ${r.variante.padEnd(10)} #${w}  ` +
        `${m.sectionsGeliefert}/${m.sectionsErwartet} Sections  ` +
        `${m.befundeKritisch} kritisch  ${m.presetVerstoesse} Verstoesse  ` +
        `${m.faktenAbweichungen} Faktenabweichungen  ${r.dauerMs}ms`);
      fs.writeFileSync(path.join(opt.out, `${r.fall}_${r.variante}_${w}.json`), JSON.stringify(r, null, 2));
    }
  }

  const summe = (k) => alle.reduce((n, r) => n + r.metriken[k], 0);
  console.log('\n--- Summe ueber ' + alle.length + ' Laeufe ---');
  console.log('  kritische Befunde  :', summe('befundeKritisch'));
  console.log('  Preset-Verstoesse  :', summe('presetVerstoesse'));
  console.log('  Faktenabweichungen :', summe('faktenAbweichungen'), '(vom Merge korrigiert)');
  console.log('  Redundanzen        :', summe('redundanzen'));
  console.log('  Ergebnisse in      :', opt.out);
}

if (require.main === module) main().catch(e => { console.error('FEHLER:', e.stack); process.exit(1); });
module.exports = { laufe, ladePreset, metriken };

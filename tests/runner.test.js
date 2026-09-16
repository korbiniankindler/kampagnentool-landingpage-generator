/* Absicherung des Headless-Runners.

   Der Runner ist nur dann aussagekraeftig, wenn er DIESELBE Pipeline faehrt
   wie das Tool - gleiche Prompts, gleiche Referenzwahl, gleicher Hero-Merge,
   gleiches Gate. Genau das pruefen diese Tests. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const { ladePreset, ladeReviewPreset, metriken, mockReview } = require(path.join(ROOT, 'eval/runner.js'));
const CopyPresets = require(path.join(ROOT, 'shared/copywriter-presets.js'));
global.SectionSchemas = global.SectionSchemas || require(path.join(ROOT, 'shared/section-schemas.js'));
global.BrandConfig = global.BrandConfig || require(path.join(ROOT, 'shared/brand-config.js'));
const Validators = require(path.join(ROOT, 'shared/validators.js'));
const Reviewer = require(path.join(ROOT, 'shared/reviewer.js'));
const Digest = require(path.join(ROOT, 'shared/digest.js'));
const PromptBuilder = require(path.join(ROOT, 'shared/prompt-builder.js'));
const HardfactsIO = require(path.join(ROOT, 'shared/hardfacts.js'));

const FAELLE = path.join(ROOT, 'eval/faelle');

test('alle Eval-Faelle sind gueltig und vollstaendig', () => {
  const dateien = fs.readdirSync(FAELLE).filter(f => f.endsWith('.json'));
  assert.ok(dateien.length >= 4, 'mindestens vier Faelle als Startpunkt');
  const ids = new Set();
  dateien.forEach(f => {
    const fall = JSON.parse(fs.readFileSync(path.join(FAELLE, f), 'utf8'));
    assert.ok(fall.id && !ids.has(fall.id), `${f}: id fehlt oder doppelt`);
    ids.add(fall.id);
    assert.ok(fall.beschreibung, `${f}: ohne Beschreibung ist unklar, was der Fall abdeckt`);
    assert.ok(Array.isArray(fall.sections) && fall.sections.length, `${f}: keine Sections`);
    assert.ok(fall.hardfacts, `${f}: keine Hardfacts`);
    if (fall.preset) {
      assert.ok(CopyPresets.CATALOG.some(p => p.id === fall.preset), `${f}: unbekanntes Preset ${fall.preset}`);
    }
  });
});

test('die Faelle decken beide Marken und beide Register ab', () => {
  const faelle = fs.readdirSync(FAELLE).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(FAELLE, f), 'utf8')));
  const presets = new Set(faelle.map(f => f.preset));
  assert.ok(presets.has('hellinger') && presets.has('holistic-house'), 'beide Marken');
  assert.ok(faelle.some(f => !f.hardfacts.zielgruppe || !f.hardfacts.live_termin),
    'mindestens ein Fall mit Luecken - sonst bleibt ungeprueft, ob Platzhalter statt Erfindungen entstehen');
});

test('Preset-Laden trifft dieselbe Referenz-Wahl wie das Tool', () => {
  // Die Register-Heuristik entscheidet, welche Referenz-Copy in den Prompt
  // geht. Waehlt der Runner anders, misst er eine andere Pipeline.
  const b2b = ladePreset('hellinger', 'Coaches, Therapeutinnen und Berater');
  const b2c = ladePreset('hellinger', 'Menschen mit Vorerfahrung in Aufstellungsarbeit');
  assert.equal(b2b.refId, 'b2b');
  assert.equal(b2c.refId, 'b2c');
  assert.equal(b2b.refId, CopyPresets.autoRef('hellinger', 'Coaches, Therapeutinnen und Berater').id);
});

test('Preset-Text enthaelt Regelwerk, Wissensdatenbank und genau eine Referenz', () => {
  const { text } = ladePreset('hellinger', 'Menschen mit Vorerfahrung');
  assert.match(text, /Copywriter-Regelwerk/);
  assert.match(text, /Wissensdatenbank/);
  // genau eine Referenz: der B2B-Titel darf im B2C-Lauf nicht auftauchen
  assert.ok(!/Coaching loest Symptome, Ordnung loest Ursachen/.test(text),
    'mehrere Referenzen wuerden die Register-Tonalitaeten mischen');
});

test('ohne Preset liefert ladePreset leeren Text statt zu werfen', () => {
  const r = ladePreset(null, 'x');
  assert.equal(r.text, '');
  assert.equal(r.refId, null);
});

test('unbekanntes Preset scheitert laut', () => {
  assert.throws(() => ladePreset('gibtsnicht', 'x'), /Unbekanntes Preset/);
});

test('Metriken zaehlen die Groessen, die der Benchmark vergleicht', () => {
  const befunde = [
    { schwere: 'kritisch', id: 'preset-verstoss' },
    { schwere: 'kritisch', id: 'feld-leer' },
    { schwere: 'kritisch', id: 'anzahl' },
    { schwere: 'hinweis', id: 'redundanz' }
  ];
  const m = metriken(befunde, { hero: { h1: 'Ein Titel mit fuenf Woertern' } },
    [{ id: 'hero' }], [{ feld: 'h1' }]);
  assert.equal(m.befundeKritisch, 3);
  assert.equal(m.befundeHinweis, 1);
  assert.equal(m.presetVerstoesse, 1);
  assert.equal(m.redundanzen, 1);
  assert.equal(m.faktenAbweichungen, 1, 'wie oft das Modell von bestaetigten Werten abweichen wollte');
  assert.equal(m.sectionsErwartet, 1);
  assert.equal(m.woerterGesamt, 5);
});

test('kein Feldname im Schema primt eine verbotene Bezeichnung', () => {
  /* Der Feldname steht im Prompt-Schema und wird vom Modell gelesen.
     "webinarRole" primte bei Hellinger genau das im Regelwerk verbotene Wort -
     aufgefallen erst im Trockenlauf des Runners. */
  const hellinger = global.BrandConfig.forPreset(
    fs.readFileSync(path.join(ROOT, 'presets/hellinger/regeln.md'), 'utf8'));
  global.SectionSchemas.knownIds().forEach(id => {
    const hint = global.SectionSchemas.promptHint(id) || '';
    const treffer = global.BrandConfig.pruefeText(hellinger, hint);
    assert.deepEqual(treffer, [], `Schema von "${id}" primt: ${JSON.stringify(treffer)}`);
  });
});

/* ---- Reviewer-Anbindung (--reviewer) ---- */

test('Der Reviewer bekommt einen ANDEREN Preset-Text als der Generator', () => {
  // Der Generator bekommt zusaetzlich genau eine Referenz-Copy. Waeren beide
  // Texte gleich, wuerde der Reviewer Aehnlichkeit zur Referenz bewerten -
  // eine Bestaetigungsschleife statt einer Pruefung.
  const briefing = 'Webinar fuer Coaches und Therapeuten';
  const gen = ladePreset('hellinger', briefing);
  const rev = ladeReviewPreset('hellinger');
  assert.ok(gen.text.length > rev.length, 'der Generator-Text muss die Referenz zusaetzlich enthalten');
  assert.ok(gen.refId, 'Testannahme: der Generator waehlt eine Referenz');
  const refText = fs.readFileSync(path.join(ROOT,
    CopyPresets.CATALOG.find(p => p.id === 'hellinger').referenzen.find(r => r.id === gen.refId).file), 'utf8');
  const probe = refText.split('\n').find(l => l.trim().length > 40).trim();
  assert.ok(gen.text.includes(probe), 'Testannahme: die Referenz steckt im Generator-Text');
  assert.ok(!rev.includes(probe), 'die Referenz-Copy darf NICHT im Reviewer-Kontext stehen');
});

test('Der Reviewer-Preset-Text enthaelt Regelwerk und Wissensdatenbank', () => {
  CopyPresets.CATALOG.forEach((p) => {
    const rev = ladeReviewPreset(p.id);
    p.files.forEach((f) => {
      const inhalt = fs.readFileSync(path.join(ROOT, f), 'utf8');
      const probe = inhalt.split('\n').find(l => l.trim().length > 40 && !l.includes('"')).trim();
      assert.ok(rev.includes(probe), p.id + ': Inhalt aus ' + f + ' fehlt');
    });
  });
});

test('Der brand-config-Block wird aus dem Reviewer-Text entfernt', () => {
  // Er ist Maschinenkonfiguration, keine Regel fuer einen Leser - und er
  // wird dem Generator ebenfalls nicht gezeigt.
  CopyPresets.CATALOG.forEach((p) => {
    assert.ok(!/```json brand-config/.test(ladeReviewPreset(p.id)), p.id);
  });
});

test('ladeReviewPreset ohne Preset liefert leeren Text statt zu werfen', () => {
  assert.equal(ladeReviewPreset(null), '');
});

test('Die Review-Metriken sind null ohne Reviewer, nicht 0', () => {
  // 0 wuerde "geprueft, nichts gefunden" heissen. Ein Lauf ohne Reviewer hat
  // aber gar nichts geprueft - das darf die Summe nicht beschoenigen.
  const ohne = metriken([], { hero: { h1: 'Ein Titel' } }, [{ id: 'hero' }], []);
  assert.equal(ohne.reviewSchnitt, null);
  assert.equal(ohne.reviewKritisch, null);
  assert.equal(ohne.reviewVerworfen, null);

  const review = { punkte: { schnitt: 3.5 }, befunde: [{ schwere: 'kritisch' }, { schwere: 'hinweis' }], verworfen: [{}] };
  const mit = metriken([], { hero: { h1: 'Ein Titel' } }, [{ id: 'hero' }], [], review);
  assert.equal(mit.reviewSchnitt, 3.5);
  assert.equal(mit.reviewKritisch, 1);
  assert.equal(mit.reviewHinweise, 1);
  assert.equal(mit.reviewVerworfen, 1);
});

test('Die gemockte Review-Antwort laeuft durch BEIDE Zweige der Belegpruefung', () => {
  // Sonst prueft der Trockenlauf die wichtigste Funktion des Reviewers nie.
  const sectionData = { hero: { h1: 'Der Platz, der zu Dir gehoert', h2: 'Warum alte Muster bleiben' } };
  const roh = mockReview(sectionData);
  const g = Reviewer.pruefeBelege(roh.befunde, sectionData);
  assert.ok(g.befunde.length > 0, 'belegte Befunde fehlen');
  assert.ok(g.verworfen.length > 0, 'unbelegter Befund fehlt - der Trockenlauf wuerde den Zweig nie erreichen');
});

test('Die gemockte Bewertung deckt jede Rubrik-Dimension ab', () => {
  const roh = mockReview({ hero: { h1: 'Ein hinreichend langer Titel' } });
  Reviewer.KATEGORIEN.forEach(k => assert.ok(roh.bewertung[k], k + ' fehlt'));
  assert.equal(Reviewer.punkte(roh).schnitt !== null, true);
});

/* ---- Die Faelle selbst ----
   Ein Fixture, das still kaputtgeht, ist schlechter als keines: der Lauf
   bleibt gruen und misst etwas anderes als gedacht. */

function alleFaelle() {
  return fs.readdirSync(FAELLE).filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(fs.readFileSync(path.join(FAELLE, f), 'utf8')));
}
function cfgVon(presetId) {
  const preset = CopyPresets.CATALOG.find(p => p.id === presetId);
  return global.BrandConfig.forPreset(
    fs.readFileSync(path.join(ROOT, preset.files[0]), 'utf8'));
}

test('kein Fall verstoesst mit seinem eigenen Briefing gegen sein Regelwerk', () => {
  /* Genau das ist beim Anlegen von hellinger-viele-bullets passiert: die
     Sub-Headline enthielt "nicht ... sondern". Der Hero-Merge uebernimmt sie
     unveraendert, das Gate meldet einen Verstoss - und der Fall misst dann
     einen Fixture-Fehler statt der Sache, um die es ihm geht. */
  alleFaelle().forEach((fall) => {
    if (!fall.preset) return;
    const cfg = cfgVon(fall.preset);
    const hf = fall.hardfacts;
    const texte = [hf.titel, hf.pre_headline, hf.sub_headline, hf.beschreibung, hf.kampagnenname]
      .concat(hf.bulletpoints || []).filter(Boolean);
    texte.forEach((t) => {
      assert.deepEqual(global.BrandConfig.pruefeText(cfg, t), [],
        fall.id + ': das Briefing selbst verstoesst gegen das Regelwerk: "' + t + '"');
    });
  });
});

test('jeder Fall nennt eine Vorlage, die es im Regelwerk seiner Marke gibt', () => {
  alleFaelle().forEach((fall) => {
    if (!fall.preset || !fall.lpVorlage) return;
    const cfg = cfgVon(fall.preset);
    const v = global.BrandConfig.vorlage(cfg, fall.lpVorlage);
    assert.ok(v && v.name, fall.id + ': unbekannte Vorlage "' + fall.lpVorlage + '"');
  });
});

test('die acht Faelle decken die im Benchmark-Plan genannten Dimensionen ab', () => {
  const faelle = alleFaelle();
  assert.ok(faelle.length >= 8, 'der Plan nennt acht Faelle, vorhanden: ' + faelle.length);

  const cfg = (f) => global.BrandConfig.vorlage(cfgVon(f.preset), f.lpVorlage) || {};
  assert.ok(faelle.some(f => cfg(f).priceStatus === 'kostenpflichtig'),
    'kein Fall mit kostenpflichtigem Angebot - der Preis-Zweig der Regelwerke bleibt sonst ungeprueft');
  assert.ok(faelle.filter(f => f.digest).length >= 2,
    'weniger als zwei Faelle mit Dokument-Kontext');
  assert.ok(faelle.some(f => (f.hardfacts.bulletpoints || []).length >= 6),
    'kein Fall mit unueblich vielen Bulletpoints');
  assert.ok(new Set(faelle.map(f => (f.hardfacts.bulletpoints || []).length)).size >= 3,
    'die Bulletpoint-Anzahl variiert zu wenig');
});

test('ein kostenpflichtiger Fall nennt auch wirklich einen Preis', () => {
  const faelle = alleFaelle().filter(f =>
    (global.BrandConfig.vorlage(cfgVon(f.preset), f.lpVorlage) || {}).priceStatus === 'kostenpflichtig');
  assert.ok(faelle.length);
  faelle.forEach(f => assert.ok((f.hardfacts.angebot || {}).preis,
    f.id + ': kostenpflichtig, aber ohne Preis - dann ist der Fall wirkungslos'));
});

test('die eingecheckten Digests sind strukturell in Ordnung', () => {
  // Ein Fixture mit fehlendem Beleg oder unmoeglicher Seitenzahl wuerde
  // Befunde erzeugen, die nichts mit der Pipeline zu tun haben.
  alleFaelle().filter(f => f.digest).forEach((fall) => {
    const strukturell = Digest.pruefe(fall.digest, { seitenGesamt: fall.digestSeiten || null })
      .filter(b => /konflikt/.test(b.id) === false);
    assert.deepEqual(strukturell, [], fall.id + ': Digest-Fixture ist mangelhaft');
  });
});

test('genau ein Dokument-Fall traegt einen Terminkonflikt, der auch gefunden wird', () => {
  const mitKonflikt = alleFaelle().filter(f => f.digest).filter(f =>
    Digest.pruefe(f.digest, { hf: f.hardfacts }).some(b => b.id === 'termin-konflikt'));
  assert.equal(mitKonflikt.length, 1, 'genau ein Fall soll den Widerspruch abdecken');

  const fall = mitKonflikt[0];
  assert.deepEqual(fall.digest.konflikte, [],
    'der Fall lebt davon, dass das MODELL den Konflikt uebersehen hat');
  const txt = Digest.renderForPrompt(fall.digest, fall.hardfacts,
    Digest.pruefe(fall.digest, { hf: fall.hardfacts }));
  assert.match(txt, /Verbindlich ist immer das Briefing/);
  assert.ok(txt.includes(fall.hardfacts.live_termin), 'der verbindliche Termin fehlt im Prompt');
  assert.match(txt, /ACHTUNG/, 'der abweichende Fakt ist nicht entwertet');
});

test('der konfliktfreie Dokument-Fall erzeugt auch keinen Konflikt', () => {
  const ohne = alleFaelle().filter(f => f.digest).filter(f =>
    !Digest.pruefe(f.digest, { hf: f.hardfacts }).some(b => /konflikt/.test(b.id)));
  assert.ok(ohne.length >= 1, 'ohne Gegenprobe ist nicht zu sehen, ob die Erkennung nur Alarm schlaegt');
  const txt = Digest.renderForPrompt(ohne[0].digest, ohne[0].hardfacts, []);
  assert.ok(!/ACHTUNG/.test(txt));
  assert.ok(!/Verbindlich ist immer das Briefing/.test(txt));
});

test('der Dokument-Kontext landet im Generierungs-Prompt', () => {
  // Sonst waere der ganze Digest-Zweig im Runner wirkungslos und der Fall
  // wuerde dasselbe messen wie ein Fall ohne Dokument.
  const fall = alleFaelle().find(f => f.digest && !f.digest.konflikte.length &&
    !Digest.pruefe(f.digest, { hf: f.hardfacts }).some(b => /konflikt/.test(b.id)));
  const block = Digest.renderForPrompt(fall.digest, fall.hardfacts, []);
  const usr = PromptBuilder.buildChunkPrompt({
    hf: fall.hardfacts, zielgruppe: HardfactsIO.audience(fall.hardfacts),
    strategie: '', ctxBlock: block, chunk: fall.sections.slice(0, 2),
    pageMap: PromptBuilder.buildPageMap(fall.sections), brandCfg: cfgVon(fall.preset),
    lpVorlage: global.BrandConfig.vorlage(cfgVon(fall.preset), fall.lpVorlage)
  });
  assert.match(usr, new RegExp(fall.digest.fakten[0].aussage.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('unuebliche Bulletpoint-Anzahl ueberlebt den Hero-Merge unveraendert', () => {
  const fall = alleFaelle().find(f => (f.hardfacts.bulletpoints || []).length >= 6);
  const soll = fall.hardfacts.bulletpoints;
  const out = Validators.mergeHero(
    { bulletpoints: [{ title: 'Eigener Text', text: 'vom Modell erfunden' }] },
    fall.hardfacts, null, []);
  assert.equal(out.bulletpoints.length, soll.length,
    'weder gekuerzt noch aufgefuellt - die bestaetigten Bullets sind gesetzt');
  assert.equal(out.bulletpoints[0].title, soll[0]);
  assert.equal(out.bulletpoints[soll.length - 1].title, soll[soll.length - 1]);
});

test('der Runner bindet dieselben Schemas wie Modul 2', () => {
  /* Ohne Schema misst der Runner eine andere Pipeline als die, die die
     Mitarbeiter benutzen - und ein Live-Lauf wuerde Structured Outputs fuer
     die Generierung gar nicht pruefen. Modul 2 ruft
     SectionSchemas.outputConfig(chunk) auf; der Runner muss dasselbe tun. */
  const quelle = fs.readFileSync(path.join(ROOT, 'eval/runner.js'), 'utf8');
  assert.match(quelle, /SectionSchemas\.outputConfig\(/,
    'die Chunk-Generierung laeuft ohne Schemabindung');
  assert.match(quelle, /schemaFallbacks/,
    'ein Rueckfall auf einen Request ohne Schema muss sichtbar sein, nicht still');

  const html = fs.readFileSync(path.join(ROOT, 'landingpage-generator.html'), 'utf8');
  assert.match(html, /SectionSchemas\.outputConfig\(chunk\)/, 'Testannahme zu Modul 2 stimmt nicht mehr');
});

test('eigene Sections bekommen kein Schema - fuer sie gibt es keines', () => {
  const chunk = [{ id: 'hero', custom: false }, { id: 'garantie', custom: true }];
  const cfg = global.SectionSchemas.outputConfig(chunk.filter(s => !s.custom));
  assert.ok(cfg, 'fuer bekannte Sections muss ein Schema entstehen');
  assert.ok(cfg.format.schema.properties.hero);
  assert.ok(!cfg.format.schema.properties.garantie);
});

/* ---- Referenz-Wahl ----
   Die folgenschwerste unsichtbare Entscheidung im Werkzeug: Die Referenz-Copy
   steuert Tonalitaet, Satzbau und Argumentationsform der GESAMTEN Seite.
   Im ersten Live-Lauf wurde hellinger-b2c mit der B2B-Referenz getextet, weil
   im Briefing "Coaching" stand - "coach" ohne Wortgrenze traf mitten im Wort. */

function briefingVon(fall) {
  const hf = fall.hardfacts;
  return [hf.kampagnenname, hf.titel, hf.beschreibung, hf.zielgruppe, hf.offer].filter(Boolean).join('\n');
}

test('ein B2C-Briefing kippt nicht mehr wegen des Wortes "Coaching"', () => {
  const fall = JSON.parse(fs.readFileSync(path.join(FAELLE, 'hellinger-b2c.json'), 'utf8'));
  assert.match(fall.hardfacts.zielgruppe, /Coaching/, 'Testannahme: das Briefing nennt Coaching');
  const d = CopyPresets.pickRefDetail(CopyPresets.CATALOG.find(p => p.id === 'hellinger'), briefingVon(fall));
  assert.equal(d.ref.id, 'b2c',
    'die Erfahrung MIT Coaching darf nicht wie der Beruf ALS Coach zaehlen');
});

test('ein echtes B2B-Briefing waehlt weiterhin die B2B-Referenz', () => {
  // Gegenprobe: die Wortgrenze darf die Erkennung nicht abwuergen.
  ['hellinger-b2b', 'hellinger-viele-bullets'].forEach((id) => {
    const fall = JSON.parse(fs.readFileSync(path.join(FAELLE, id + '.json'), 'utf8'));
    const d = CopyPresets.pickRefDetail(CopyPresets.CATALOG.find(p => p.id === 'hellinger'), briefingVon(fall));
    assert.equal(d.ref.id, 'b2b', id);
    assert.equal(d.sicher, true, id + ': eine klare Berufsnennung muss als sicher gelten');
  });
});

test('"Coaching" allein zaehlt nicht, "Coaches" schon', () => {
  const preset = CopyPresets.CATALOG.find(p => p.id === 'hellinger');
  const ref = (t) => CopyPresets.pickRefDetail(preset, t);
  assert.equal(ref('Menschen mit Erfahrung in Coaching und Therapie').ref.id, 'b2c');
  assert.equal(ref('Fuer Coaches, Therapeutinnen und Beraterinnen').ref.id, 'b2b');
  assert.equal(ref('Fuer Fuehrungskraefte in Unternehmen').ref.id, 'b2b');
});

test('eine geratene Wahl wird als unsicher ausgewiesen', () => {
  // Ohne jeden Treffer greift der Default. Das ist eine Annahme, kein
  // Befund - und muss als solche sichtbar sein.
  const preset = CopyPresets.CATALOG.find(p => p.id === 'hellinger');
  const d = CopyPresets.pickRefDetail(preset, 'Ein Seminar ueber wiederkehrende Muster');
  assert.equal(d.ref.id, 'b2c', 'der Default gilt');
  assert.equal(d.sicher, false);
  assert.match(d.grund, /Kein Stichwort/);
});

test('pickRefDetail nennt die Woerter, die den Ausschlag gaben', () => {
  // Ohne Begruendung kann ein Mensch die Wahl nicht beurteilen.
  const d = CopyPresets.pickRefDetail(
    CopyPresets.CATALOG.find(p => p.id === 'holistic-house'),
    'Fortbildung fuer Aerzte und Heilpraktiker');
  assert.equal(d.ref.id, 'b2b');
  assert.ok(d.treffer.length >= 2, JSON.stringify(d.treffer));
  assert.match(d.grund, /Erkannt an/);
});

test('pickRef bleibt kompatibel zu pickRefDetail', () => {
  CopyPresets.CATALOG.forEach((p) => {
    ['', 'Aerzte und Heilpraktiker', 'Coaches und Trainer', 'Menschen mit Coaching-Erfahrung'].forEach((t) => {
      const a = CopyPresets.pickRef(p, t);
      const b = CopyPresets.pickRefDetail(p, t);
      assert.equal(a && a.id, b && b.ref.id, p.id + ' / ' + t);
    });
  });
});

test('eine ungueltige Regex in den Keywords legt die Wahl nicht lahm', () => {
  // Keywords sind Regex-Fragmente. Ein Tippfehler darf die Generierung nicht
  // verhindern, sondern nur dieses eine Stichwort wirkungslos machen.
  const kaputt = { id: 'x', referenzen: [
    { id: 'a', keywords: [] },
    { id: 'b', keywords: ['(unbalanciert'] }
  ]};
  assert.doesNotThrow(() => CopyPresets.pickRefDetail(kaputt, 'irgendein text'));
  assert.equal(CopyPresets.pickRefDetail(kaputt, 'irgendein text').ref.id, 'a');
});

/* ---- Ein-Call-Variante ---- */

test('Die Ein-Call-Variante buendelt alle Sections in einen Block', () => {
  const quelle = fs.readFileSync(path.join(ROOT, 'eval/runner.js'), 'utf8');
  assert.match(quelle, /variante === 'eincall'\s*\n?\s*\? \[active\]/,
    'ein Block mit allen Sections');
  assert.match(quelle, /max_tokens: eincall \? 64000 : 16000/,
    'ungestreamt liegt die Grenze bei 16000 - die ganze Seite braucht mehr');
  assert.match(quelle, /stream: eincall/, 'ohne Streaming steht die Verbindung minutenlang ohne Daten offen');
});

test('Die Ein-Call-Variante laeuft ohne Content-Plan', () => {
  // Ihre These ist, dass ein Modell mit Blick auf die ganze Seite den Bogen
  // besser baut als vier Chunks entlang eines vorgegebenen Plans. Mit Plan
  // waere es weder ein Call noch die These.
  const quelle = fs.readFileSync(path.join(ROOT, 'eval/runner.js'), 'utf8');
  assert.match(quelle, /if \(opt\.variante !== 'eincall'\) try \{/);
});

test('Alle drei Benchmark-Varianten sind dokumentiert', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'eval/README.md'), 'utf8');
  ['chunk', 'zweiblock', 'eincall'].forEach(v =>
    assert.match(readme, new RegExp('`' + v + '`'), v + ' fehlt in eval/README.md'));
});

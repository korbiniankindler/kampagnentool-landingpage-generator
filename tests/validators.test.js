'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

global.SectionSchemas = require('../shared/section-schemas.js');
global.BrandConfig = require('../shared/brand-config.js');
const V = require('../shared/validators.js');
const PromptBuilder = require('../shared/prompt-builder.js');
const S = global.SectionSchemas;
const BC = global.BrandConfig;

const ROOT = path.join(__dirname, '..');
const hellinger = () => BC.forPreset(fs.readFileSync(path.join(ROOT, 'presets/hellinger/regeln.md'), 'utf8'));

const HF = {
  titel: 'Der Platz, der wirklich zu Dir gehoert',
  sub_headline: 'Im kostenfreien Live-Seminar wird sichtbar, welche Ordnung hinter Deinen wiederkehrenden Themen wirkt.',
  pre_headline: 'ORIGINAL HELLINGER METHODE',
  bulletpoints: [
    'Erkenne, welche Ordnung hinter Deinen wiederkehrenden Themen wirkt',
    'Spuere, was sich loest, wenn Du Deinen Platz einnimmst'
  ]
};

/* Eine Seite, die alles richtig macht. Basis fuer die Fehlalarm-Tests. */
function sauber() {
  return {
    hero: {
      announcement: 'Kostenfreies Live-Seminar am 20.09.2026 um 11 Uhr',
      ctaSubline: '100 % kostenfrei, Live am 20.09.2026 um 11 Uhr',
      videoPlaceholder: '[16:9 Video-Platzhalter: Anmeldeseiten-Video mit Referent]',
      h1: HF.titel, h2: HF.sub_headline, preHeadline: HF.pre_headline,
      ctaButton: 'Jetzt kostenfrei anmelden',
      bulletpoints: [
        { title: 'Erkenne, welche Ordnung', text: 'hinter Deinen wiederkehrenden Themen wirkt' },
        { title: 'Spuere, was sich loest', text: 'wenn Du Deinen Platz einnimmst' }
      ]
    },
    social: {
      headline: 'Erfahrungen aus dem Seminar',
      testimonials: [
        { quote: 'Beim Familienessen im Mai fiel mir auf, wie oft ich einlenke.', name: 'Martina K.', role: 'Projektleiterin' },
        { quote: 'Mein aeltester Sohn rief an, und ich blieb zum ersten Mal ruhig.', name: 'Tobias R.', role: 'Selbststaendig' },
        { quote: 'Ich bin noch mittendrin, aber etwas hat sich sortiert.', name: 'Anke B.', role: 'Vater von zwei Kindern' }
      ]
    }
  };
}
const ACTIVE = [{ id: 'hero', name: 'Hero' }, { id: 'social', name: 'Social Proof' }];
const ctx = (over) => Object.assign({ active: ACTIVE, hf: HF, sectionData: sauber(), brandCfg: hellinger() }, over || {});
const ids = (b) => b.map(x => x.id);

/* ---- Der wichtigste Test: keine Fehlalarme ---- */

test('regelkonforme Seite erzeugt keinen einzigen kritischen Befund', () => {
  const b = V.pruefeAlles(ctx());
  const krit = V.kritische(b);
  assert.deepEqual(krit, [], 'Fehlalarme zerstoeren das Vertrauen ins Gate: ' + JSON.stringify(krit, null, 1));
});

/* ---- Vollstaendigkeit ---- */

test('fehlende Section wird erkannt', () => {
  const c = ctx(); delete c.sectionData.social;
  assert.ok(ids(V.pruefeAlles(c)).includes('section-fehlt'));
});

test('leeres Pflichtfeld wird erkannt, optionales nicht', () => {
  const c = ctx(); c.sectionData.hero.announcement = '';
  assert.ok(ids(V.pruefeAlles(c)).includes('feld-leer'));

  const c2 = ctx();
  c2.active = [{ id: 'faq', name: 'FAQ' }];
  c2.sectionData = { faq: { headline: 'Fragen', faqs: Array(5).fill({ question: 'Wann?', answer: 'Am 20.09.' }) } };
  assert.ok(!ids(V.pruefeAlles(c2)).includes('feld-leer'), 'ctaButton ist bei FAQ optional');
});

test('Schema-Platzhalter zaehlen als leer', () => {
  // "..." sieht im Editor wie Inhalt aus und rutscht sonst bis in den Export
  const c = ctx(); c.sectionData.hero.ctaSubline = '...';
  assert.ok(ids(V.pruefeAlles(c)).includes('feld-leer'));
});

/* ---- Anzahlen ---- */

test('falsche Anzahl in Arrays wird erkannt', () => {
  const c = ctx(); c.sectionData.social.testimonials.pop();
  const f = V.pruefeAlles(c).find(x => x.id === 'anzahl');
  assert.ok(f); assert.match(f.text, /2 Eintraege, erwartet sind 3/);
});

/* ---- Faktenerhalt: der Kern ---- */

test('umgeschriebener Titel wird erkannt', () => {
  const c = ctx(); c.sectionData.hero.h1 = 'Ein voellig anderer Titel';
  const f = V.pruefeAlles(c).find(x => x.id === 'fakt-geaendert');
  assert.ok(f); assert.equal(f.autofix, true, 'hier gibt es genau eine richtige Auflösung');
});

test('reine Formatierungsunterschiede sind KEIN Befund', () => {
  const c = ctx();
  // Leerraum, Interpunktion, Anfuehrungszeichen, Gross-/Kleinschreibung
  c.sectionData.hero.h1 = '  \u201eDer Platz, der wirklich zu Dir gehoert!\u201c  ';
  assert.ok(!ids(V.pruefeAlles(c)).includes('fakt-geaendert'),
    'Interpunktion und Leerraum duerfen keinen Fehlalarm ausloesen');
});

test('geaenderte Schreibweise IST ein Befund', () => {
  // Der bestaetigte Titel geht in Ads, Mails und Kalendereinladungen. Eine
  // andere Schreibweise ist dort ein echtes Problem, kein Formatierungsdetail.
  const c = ctx();
  c.sectionData.hero.h1 = 'Der Platz, der wirklich zu Dir gehört';
  assert.ok(ids(V.pruefeAlles(c)).includes('fakt-geaendert'),
    'Umlaute werden bewusst NICHT wegnormalisiert');
});

test('falsche Bullet-Anzahl und umformulierte Bullets werden erkannt', () => {
  const c = ctx(); c.sectionData.hero.bulletpoints.pop();
  assert.ok(ids(V.pruefeAlles(c)).includes('bullet-anzahl'));

  const c2 = ctx();
  c2.sectionData.hero.bulletpoints[0] = { title: 'Voellig neuer Inhalt', text: 'den niemand bestaetigt hat' };
  const f = V.pruefeAlles(c2).find(x => x.id === 'bullet-geaendert');
  assert.ok(f, 'ein umformulierter Bullet ist keine Aufteilung mehr');
});

test('zulaessige Aufteilung eines Bullets ist kein Befund', () => {
  const c = ctx();
  c.sectionData.hero.bulletpoints[0] = {
    title: 'Erkenne', text: 'welche Ordnung hinter Deinen wiederkehrenden Themen wirkt'
  };
  assert.ok(!ids(V.pruefeAlles(c)).includes('bullet-geaendert'),
    'anders aufgeteilt, aber wortgleich - das ist erlaubt');
});

/* ---- Locks ---- */

test('veraendertes gesperrtes Feld wird erkannt', () => {
  const c = ctx({ lockedFields: { social: { 'testimonials.0.name': 'Martina K.' } } });
  c.sectionData.social.testimonials[0].name = 'Jemand anderes';
  const f = V.pruefeAlles(c).find(x => x.id === 'lock-verletzt');
  assert.ok(f); assert.equal(f.autofix, true);
});

test('verschwundener Lock-Pfad wird erkannt statt still verloren zu gehen', () => {
  // Modell liefert 3 statt 5 Items -> checklist.4 existiert nicht mehr
  const c = ctx({ lockedFields: { social: { 'testimonials.4.quote': 'Gesperrtes Zitat' } } });
  assert.ok(ids(V.pruefeAlles(c)).includes('lock-pfad-weg'));
});

test('eingehaltener Lock erzeugt keinen Befund', () => {
  const c = ctx({ lockedFields: { social: { 'testimonials.0.name': 'Martina K.' } } });
  assert.ok(!ids(V.pruefeAlles(c)).includes('lock-verletzt'));
});

/* ---- Preset-Verstoesse ---- */

test('Regelverstoesse werden mit Fundstelle im Regelwerk gemeldet', () => {
  const c = ctx();
  c.sectionData.hero.announcement = 'Das kostenlose Live-Webinar am 20.09.';
  const f = V.pruefeAlles(c).filter(x => x.id === 'preset-verstoss');
  assert.ok(f.length >= 2, 'Webinar UND kostenlos');
  assert.ok(f.every(x => x.quelle), 'ohne Quelle ist ein Befund nicht ueberpruefbar');
  assert.equal(f[0].section, 'hero');
});

test('feldabhaengige Verbote greifen nur im richtigen Feld', () => {
  const c = ctx();
  c.sectionData.hero.h1 = 'Bist Du bereit?';
  c.hf = Object.assign({}, HF, { titel: 'Bist Du bereit?' });   // damit kein fakt-geaendert dazwischenfunkt
  assert.ok(ids(V.pruefeAlles(c)).includes('preset-verstoss-feld'), 'Fragezeichen im Seminartitel verboten');

  const c2 = ctx();
  c2.active = ACTIVE.concat([{ id: 'introtext', name: 'Intro' }]);
  c2.sectionData.introtext = {
    badge: 'Kontext', headline: 'Worum es geht',
    paragraphs: ['Bist Du wirklich da, bei Dir?', 'Zweiter Absatz.', 'Dritter Absatz.'],
    closingLine: 'Im Live-Seminar wird das sichtbar.'
  };
  assert.ok(!ids(V.pruefeAlles(c2)).includes('preset-verstoss-feld'),
    'in der Bodycopy sind Fragen ausdruecklich erwuenscht');
});

/* ---- Redundanz und Export ---- */

test('woertliche Dopplung zwischen Sections wird als Hinweis gemeldet', () => {
  const c = ctx();
  const satz = 'die ordnung hinter deinen wiederkehrenden themen wirkt bis heute nach';
  c.sectionData.hero.announcement = satz;
  c.sectionData.social.headline = satz;
  const f = V.pruefeAlles(c).find(x => x.id === 'redundanz');
  assert.ok(f); assert.equal(f.schwere, 'hinweis', 'Redundanz ist kein Export-Blocker');
});

test('sichtbare Escape-Sequenzen werden gemeldet', () => {
  const c = ctx();
  c.sectionData.social.headline = 'Erste Zeile\\nZweite Zeile';
  assert.ok(ids(V.pruefeAlles(c)).includes('escape-sichtbar'));
});

/* ---- Robustheit ---- */

test('haelt leere und kaputte Eingaben aus', () => {
  assert.doesNotThrow(() => V.pruefeAlles({}));
  assert.doesNotThrow(() => V.pruefeAlles({ active: [null], sectionData: null }));
  assert.doesNotThrow(() => V.pruefeAlles(ctx({ sectionData: { hero: null, social: 'kaputt' } })));
});

test('proSection gruppiert fuer die Anzeige im Review', () => {
  const c = ctx(); c.sectionData.hero.h1 = 'Anders';
  const map = V.proSection(V.pruefeAlles(c));
  assert.ok(map.hero && map.hero.length);
});

/* ---- Schemas ---- */

test('Prompt-Hinweis und Validator stammen aus derselben Quelle', () => {
  assert.match(S.promptHint('problem'), /checklist/);
  assert.equal(S.get('problem').fields.find(f => f.name === 'checklist').min, 5);
  assert.match(S.countRules('problem'), /exakt 5/);
  // Der Hero laesst die deterministisch gesetzten Felder aus
  assert.ok(!S.promptHint('hero').includes('"h1"'));
  assert.ok(!S.promptHint('hero').includes('"bulletpoints"'));
  assert.ok(S.promptHint('hero').includes('"announcement"'));
});

/* ---- Deterministischer Hero-Merge (1.4) ---- */

const VORLAGE = { ctaText: 'Jetzt kostenfrei anmelden' };

test('Hero-Merge setzt bestaetigte Werte, egal was das Modell liefert', () => {
  const m = V.mergeHero({
    h1: 'UMGESCHRIEBEN', h2: 'andere sub', preHeadline: 'anders',
    ctaButton: 'Jetzt kostenlos anmelden',
    announcement: 'Live-Seminar am 20.09.', ctaSubline: 'kostenfrei', videoPlaceholder: '[x]'
  }, HF, VORLAGE);
  assert.equal(m.h1, HF.titel);
  assert.equal(m.h2, HF.sub_headline);
  assert.equal(m.preHeadline, HF.pre_headline);
  assert.equal(m.ctaButton, 'Jetzt kostenfrei anmelden');
});

test('Hero-Merge laesst dem Modell seine Felder', () => {
  const m = V.mergeHero({ announcement: 'Kostenfreies Live-Seminar am 20.09.', ctaSubline: 'X', videoPlaceholder: '[v]' }, HF, VORLAGE);
  assert.equal(m.announcement, 'Kostenfreies Live-Seminar am 20.09.');
  assert.equal(m.ctaSubline, 'X');
  assert.equal(m.videoPlaceholder, '[v]');
});

test('Hero-Merge liefert immer exakt so viele Bullets wie bestaetigt', () => {
  for (const geliefert of [[], [{ title: 'x', text: '' }], Array(9).fill({ title: 'x', text: 'y' })]) {
    const m = V.mergeHero({ bulletpoints: geliefert }, HF, VORLAGE);
    assert.equal(m.bulletpoints.length, HF.bulletpoints.length,
      'die Nutzerauswahl bestimmt die Anzahl, nicht das Modell');
  }
});

test('gueltige Aufteilung wird uebernommen, umformulierte verworfen', () => {
  const m = V.mergeHero({
    bulletpoints: [
      { title: 'Erkenne', text: 'welche Ordnung hinter Deinen wiederkehrenden Themen wirkt' },
      { title: 'Etwas voellig anderes', text: 'das niemand bestaetigt hat' }
    ]
  }, HF, VORLAGE);
  assert.equal(m.bulletpoints[0].title, 'Erkenne', 'wortgleiche Aufteilung bleibt');
  assert.equal(m.bulletpoints[1].title, HF.bulletpoints[1], 'Umformulierung faellt auf das Original zurueck');
  assert.equal(m.bulletpoints[1].text, '');
});

test('Hero-Merge macht die Pruefung zufrieden - beide Seiten derselben Regel', () => {
  const data = sauber();
  data.hero = V.mergeHero({ announcement: 'Live-Seminar am 20.09.', ctaSubline: 'X', videoPlaceholder: '[v]',
    h1: 'kaputt', bulletpoints: [] }, HF, VORLAGE);
  const b = V.pruefeAlles(ctx({ sectionData: data }));
  assert.deepEqual(V.kritische(b).filter(x => x.section === 'hero'), [],
    'was der Merge setzt, darf die Pruefung nicht mehr beanstanden');
});

test('Hero-Merge ohne Briefing-Werte laesst das Modell in Ruhe', () => {
  const m = V.mergeHero({ h1: 'Modelltitel', bulletpoints: [] }, {}, null);
  assert.equal(m.h1, 'Modelltitel', 'ohne bestaetigten Titel gibt es nichts zu erzwingen');
  assert.deepEqual(m.bulletpoints, []);
});

/* ---- Autofix ---- */

test('autofix behebt nur eindeutige Faelle', () => {
  const data = sauber();
  data.hero.h1 = 'Falsch';
  data.social.testimonials[0].name = 'Falscher Name';
  const c = ctx({ sectionData: data, lockedFields: { social: { 'testimonials.0.name': 'Martina K.' } } });
  const befunde = V.pruefeAlles(c);
  const angewandt = V.autofix(data, befunde);

  assert.equal(data.hero.h1, HF.titel, 'bestaetigter Titel wiederhergestellt');
  assert.equal(data.social.testimonials[0].name, 'Martina K.', 'Lock wiederhergestellt');
  assert.ok(angewandt.length >= 2);
  assert.deepEqual(V.kritische(V.pruefeAlles(c)), [], 'danach ist die Seite sauber');
});

test('autofix fasst nichts an, wofuer es keine eindeutige Auflösung gibt', () => {
  const data = sauber();
  data.hero.announcement = 'Das kostenlose Live-Webinar';   // Preset-Verstoss, kein autofix
  const vorher = data.hero.announcement;
  V.autofix(data, V.pruefeAlles(ctx({ sectionData: data })));
  assert.equal(data.hero.announcement, vorher, 'ein Regelverstoss braucht eine menschliche Entscheidung');
});

test('Merge protokolliert, wo das Modell abweichen wollte', () => {
  // Fuer die Qualitaetsbeurteilung und den Benchmark ist das eine messbare
  // Groesse: wie oft weicht das Modell von bestaetigten Werten ab?
  const prot = [];
  V.mergeHero({
    h1: 'Modell wollte etwas anderes',
    bulletpoints: [{ title: 'Voellig neu', text: 'erfunden' }]
  }, HF, VORLAGE, prot);
  assert.ok(prot.some(p => p.feld === 'h1'), 'abweichender Titel wird protokolliert');
  assert.ok(prot.some(p => p.feld.startsWith('bulletpoints')), 'umformulierter Bullet ebenso');
  assert.ok(prot.every(p => p.gewollt && p.gesetzt), 'beide Werte fuer den Vergleich');
});

test('Merge protokolliert NICHTS, wenn das Modell sich an die Vorgabe haelt', () => {
  const prot = [];
  V.mergeHero({
    h1: HF.titel, h2: HF.sub_headline, preHeadline: HF.pre_headline,
    ctaButton: VORLAGE.ctaText,
    bulletpoints: HF.bulletpoints.map(b => ({ title: b, text: '' }))
  }, HF, VORLAGE, prot);
  assert.deepEqual(prot, [], 'sonst waere jeder Lauf voller Rauschen');
});

/* ---- Vertrauensbehauptungen ----
   Gefunden in zwei aufeinanderfolgenden Live-Laeufen, beide Male in der
   Trustbar und jedes Mal anders formuliert. Das Modell fuellt eine leere
   Vorgabe mit dem, was auf Landingpages ueblich ist - und eine erfundene
   Presse-Nennung ist rechtlich angreifbar, kein Stilproblem. */

const vb = (sectionData) => V.pruefeAlles({
  active: Object.keys(sectionData).map(id => ({ id, name: id })),
  sectionData, hf: {}, lockedFields: {}
}).filter(b => b.id === 'vertrauensbehauptung');

test('Die beiden echten Faelle aus den Live-Laeufen werden gefunden', () => {
  const a = vb({ trustbar: { note: 'Bekannt aus etablierten Medien, denen die Arbeit Beachtung wert war' } });
  assert.equal(a.length, 1);
  assert.match(a[0].text, /Medien-Nennung/);
  assert.equal(a[0].feld, 'note');

  const b = vb({ trustbar: { note: 'Die Methode ist international bekannt und wird seit Jahrzehnten oeffentlich referenziert.' } });
  assert.ok(b.length >= 1, 'zweite Formulierung ebenfalls');
});

test('Ein Befund sperrt den Export NICHT', () => {
  /* Das Tool kann nicht wissen, ob die Behauptung belegt ist - die
     Wissensdatenbank liegt als Fliesstext vor, nicht als Faktenbasis. Ein
     kritischer Befund waere hier ein Fehlalarm-Generator, und ein Gate, das
     grundlos sperrt, bringt Nutzer dazu, Befunde generell zu uebergehen. */
  vb({ trustbar: { note: 'Bekannt aus dem Fernsehen' } })
    .forEach(b => assert.equal(b.schwere, 'hinweis'));
});

test('Der Befund sagt, wogegen zu pruefen ist', () => {
  const b = vb({ trustbar: { note: 'Bekannt aus der Presse' } })[0];
  assert.match(b.text, /Wissensdatenbank oder im Briefing belegt/);
  assert.match(b.text, /Ist nichts belegt: streichen/);
});

test('Belegte und harmlose Formulierungen loesen KEINEN Befund aus', () => {
  // Wichtiger als die Treffer: Diese Pruefung darf nicht zum naechsten
  // Fehlalarm-Generator werden.
  [
    { note: 'Seit 1999 · ueber 50.000 begleitete Menschen' },
    { note: 'In Brasilien ist das Familienstellen als alternative Heilmethode anerkannt.' },
    { headline: 'Sophie Hellinger begleitet weltweit Menschen auf ihrem Weg' },
    { text: 'Ein international besetztes Seminar mit Teilnehmenden aus acht Laendern' },
    { text: 'Die Aufzeichnung ist sieben Tage abrufbar.' },
    { text: 'Du erkennst, welche Ordnung im Hintergrund wirkt.' }
  ].forEach((sd) => {
    assert.deepEqual(vb({ x: sd }), [], 'Fehlalarm bei: ' + JSON.stringify(sd));
  });
});

test('Die Pruefung greift in jeder Section, nicht nur in der Trustbar', () => {
  // Im zweiten Lauf stand die Behauptung in der Trustbar; sie kann genauso
  // in der Authority-Bio oder im Intro landen.
  const b = vb({ authority: { bioBlock: 'Sie ist Marktfuehrer im Bereich systemische Arbeit.' } });
  assert.equal(b.length, 1);
  assert.equal(b[0].section, 'authority');
});

test('Mehrere Behauptungen in einem Feld werden einzeln gemeldet', () => {
  const b = vb({ trustbar: { note: 'Bekannt aus den Medien und international anerkannt.' } });
  assert.ok(b.length >= 2, JSON.stringify(b.map(x => x.text.slice(0, 40))));
});

test('Jeder Befund nennt section und feld nach derselben Konvention', () => {
  /* `feld` ist ueberall der Pfad INNERHALB der Section, `section` steht
     daneben. Ein Befund mit "trustbar.note" statt "note" findet in der
     Oberflaeche sein Feld nicht - genau das war die erste Fassung der
     Vertrauensprüfung. */
  const sectionData = {
    trustbar: { note: 'Bekannt aus den Medien' },
    hero: { h1: 'Falscher Titel', h2: '', preHeadline: '', bulletpoints: [], ctaButton: '' },
    social: { headline: 'x', testimonials: [] }
  };
  const befunde = V.pruefeAlles({
    active: Object.keys(sectionData).map(id => ({ id, name: id })),
    sectionData, hf: { titel: 'Richtiger Titel', bulletpoints: ['A'] }, lockedFields: {}
  });
  assert.ok(befunde.length > 3, 'Testannahme: es entstehen mehrere Befunde');
  befunde.filter(b => b.feld && b.section).forEach((b) => {
    assert.ok(!b.feld.startsWith(b.section + '.'),
      b.id + ': feld "' + b.feld + '" wiederholt die Section "' + b.section + '"');
  });
});

/* ---- Verknappung ohne belegtes Kontingent ----
   Das Feld heisst `scarcityCopy` - und ein Pflichtfeld mit diesem Namen
   VERLANGT Verknappung, auch wenn es keine gibt. In zwei aufeinanderfolgenden
   Live-Laeufen erfand das Modell prompt eine. Dasselbe Muster wie beim
   frueheren Feldnamen "webinarRole", der bei Hellinger das verbotene Wort
   "Webinar" primte: Der Feldname ist Teil des Prompts und wird gelesen.

   Die Regelwerke ERLAUBEN Verknappung - aber nur als Information ueber einen
   realen Sachverhalt. Geprueft wird deshalb nicht die Formulierung, sondern
   ihr fehlender Beleg. */

const kn = (txt, hf) => V.pruefeAlles({
  active: [{ id: 'finalcta', name: 'Final CTA' }],
  sectionData: { finalcta: { scarcityCopy: txt } }, hf: hf || {}, lockedFields: {}
}).filter(b => b.id === 'knappheit-ohne-beleg');

test('Die beiden echten Faelle aus den Live-Laeufen werden gefunden', () => {
  assert.equal(kn('Die Plaetze fuer das Live-Seminar am 20.09.2026 sind begrenzt.').length, 1);
  assert.equal(kn('Die Plätze sind begrenzt, damit Raum fuer die Fragerunde bleibt.').length, 1);
});

test('Ein Datum im Satz bricht die Erkennung nicht ab', () => {
  /* "20.09.2026" enthaelt Punkte. Behandelt die Regex die als Satzende,
     faellt genau der Satz durch, wegen dem die Pruefung entstanden ist. */
  assert.equal(kn('Die Plaetze fuer den Termin am 20.09.2026 um 11 Uhr sind begrenzt.').length, 1);
});

test('Mit belegtem Kontingent im Briefing gibt es KEINEN Befund', () => {
  // Die Regelwerke erlauben die Aussage ausdruecklich, wenn sie stimmt.
  [
    { beschreibung: 'Live-Seminar mit maximal 500 Teilnehmern.' },
    { offer: 'Ausbildung, 20 Plaetze pro Jahrgang' },
    { beschreibung: 'Anmeldeschluss ist der 15.09.2026' }
  ].forEach((hf) => {
    assert.deepEqual(kn('Die Plaetze sind begrenzt.', hf), [],
      'Fehlalarm trotz Beleg: ' + JSON.stringify(hf));
  });
});

test('Harmlose Verwendungen loesen keinen Befund aus', () => {
  // "beschraenkt" und "frueh" kommen im Fliesstext staendig vor. Ein Hinweis,
  // der oft danebenliegt, wird uebergangen - und dann auch der, der stimmt.
  [
    'Der Blick ist auf das Wesentliche beschraenkt geblieben.',
    'Je frueher Du Dich anmeldest, desto besser.',
    'Eine begrenzte Sicht auf das eigene Muster.',
    'Die Plaetze sind frei. Der Blick bleibt begrenzt.',
    'Am 20.09.2026 um 11 Uhr. Du bist herzlich eingeladen.'
  ].forEach(t => assert.deepEqual(kn(t), [], 'Fehlalarm bei: ' + t));
});

test('Der Befund sperrt den Export nicht und sagt, was zu tun ist', () => {
  const b = kn('Nur noch wenige Plaetze frei.')[0];
  assert.equal(b.schwere, 'hinweis');
  assert.match(b.text, /nur zulaessig, wenn sie real ist/);
  assert.match(b.text, /ruhige Einladung/);
});

test('Der Prompt erklaert, dass der Feldname keine Verknappung verlangt', () => {
  const usr = PromptBuilder.buildChunkPrompt({
    hf: { titel: 'T' }, chunk: [{ id: 'finalcta', name: 'Final CTA', desc: 'x' }],
    pageMap: '1. Final CTA'
  });
  assert.match(usr, /Der Feldname ist historisch, er verlangt KEINE Verknappung/);
  assert.match(usr, /erfinde keine/);
});

/* ---- Regex-Luecke, die der Reviewer aufgedeckt hat ---- */

test('"kein ... sondern" gilt wie "nicht ... sondern"', () => {
  /* Das HH-Regelwerk nennt "Das ist kein X, sondern Y." ausdruecklich als
     verbotene Form; die Regex deckte nur "nicht" ab. Keine Regelaenderung,
     sondern eine Luecke in der maschinellen Umsetzung - gefunden vom
     Reviewer im dritten Live-Lauf. */
  ['hellinger', 'holistic-house'].forEach((brand) => {
    const cfg = BC.forPreset(fs.readFileSync(path.join(ROOT, 'presets', brand, 'regeln.md'), 'utf8'));
    const ids = (t) => BC.pruefeText(cfg, t).map(b => b.id);
    [
      'Du bekommst keine weitere Theorie, sondern einen Blick auf die Ordnung',
      'Das ist kein Vortrag, sondern eine Begegnung',
      'Es ist nicht Theorie, sondern Erfahrung'
    ].forEach(t => assert.ok(ids(t).includes('nicht-sondern'), brand + ': ' + t));

    // Getrennte Saetze sind keine Konstruktion.
    ['Keine Sorge. Sondern Ruhe kehrt ein.', 'Du brauchst kein Vorwissen fuer dieses Seminar']
      .forEach(t => assert.ok(!ids(t).includes('nicht-sondern'), brand + ' Fehlalarm: ' + t));
  });
});

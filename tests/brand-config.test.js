/* Absicherung von shared/brand-config.js gegen die echten Regelwerke.

   Die Tests hier sind der Regressionsschutz fuer P0-2: hartcodierte
   Prompt-Zeilen, die beide Markenregelwerke woertlich verletzt haben. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const BC = require('../shared/brand-config.js');

const ROOT = path.join(__dirname, '..');
const rules = (brand) => fs.readFileSync(path.join(ROOT, 'presets', brand, 'regeln.md'), 'utf8');
const cfgOf = (brand) => BC.forPreset(rules(brand));

test('beide Regelwerke enthalten einen parsebaren Konfigurationsblock', () => {
  for (const brand of ['hellinger', 'holistic-house']) {
    const cfg = BC.parse(rules(brand));
    assert.ok(cfg, `${brand}: kein brand-config-Block gefunden`);
    assert.ok(cfg.vorlagen && Object.keys(cfg.vorlagen).length, `${brand}: keine Vorlagen`);
    assert.ok(Array.isArray(cfg.verbote) && cfg.verbote.length, `${brand}: keine Verbote`);
  }
});

test('kaputtes JSON scheitert laut statt still generisch zu werden', () => {
  assert.throws(
    () => BC.parse('```json brand-config\n{ kaputt: ]\n```'),
    /kein gueltiges JSON/,
    'ein stiller Fallback wuerde markenfremde CTAs erzeugen, ohne dass es auffaellt'
  );
});

test('ohne Preset gelten neutrale Vorgaben ohne Markenformulierungen', () => {
  const cfg = BC.forPreset('');
  assert.equal(cfg, BC.GENERIC);
  assert.equal(cfg.anrede, null, 'ohne Marke wird keine Anrede vorgegeben');
});

/* ---- Die vier Achsen ---- */

test('Vorlagen tragen alle vier Achsen getrennt', () => {
  for (const brand of ['hellinger', 'holistic-house']) {
    BC.vorlagenListe(cfgOf(brand)).forEach((v) => {
      ['offerType', 'conversionAction', 'priceStatus', 'eventFormat'].forEach((achse) => {
        assert.ok(v[achse], `${brand}/${v.key}: Achse ${achse} fehlt`);
      });
      assert.ok(v.ctaText, `${brand}/${v.key}: kein CTA`);
    });
  }
});

test('HH-Ausbildung zeigt, warum ein einzelner LP-Typ nicht reicht', () => {
  // Das Beratungsgespraech ist kostenlos, das Angebot dahinter nicht.
  const v = BC.vorlage(cfgOf('holistic-house'), 'ausbildung');
  assert.equal(v.priceStatus, 'kostenlos', 'die Conversion-Aktion ist kostenlos');
  assert.equal(v.priceStatusAngebot, 'kostenpflichtig', 'das Angebot dahinter nicht');
  assert.equal(v.conversionAction, 'terminbuchung');
  assert.equal(v.offerType, 'ausbildung');
});

/* ---- P0-2: die hartcodierten Prompt-Werte ---- */

test('Hellinger-CTA sagt kostenfrei, nicht kostenlos', () => {
  const cta = BC.vorlage(cfgOf('hellinger'), 'live_seminar').ctaText;
  assert.match(cta, /kostenfrei/);
  assert.ok(!/kostenlos/.test(cta), 'der Prompt hatte "Jetzt kostenlos anmelden" hartcodiert');
});

test('Hellinger nennt das Event nie Webinar', () => {
  const cfg = cfgOf('hellinger');
  assert.equal(cfg.eventBezeichnung, 'Live-Seminar');
  const alleTexte = BC.vorlagenListe(cfg).map(v => v.ctaText + ' ' + (v.microcopy || '')).join(' ');
  assert.ok(!/Webinar/i.test(alleTexte),
    'der Prompt hatte "LIVE-Webinar am [Termin]" als Beispiel - im Regelwerk verboten');
});

test('HH benutzt seinen eigenen belegten CTA, nicht den generischen', () => {
  assert.equal(BC.vorlage(cfgOf('holistic-house'), 'webinar').ctaText, 'Jetzt Ihren Platz reservieren');
});

test('Hellinger schliesst Frage, Zeitgeschehen und Faktencheck als Angle aus', () => {
  const cfg = cfgOf('hellinger');
  const erlaubt = BC.erlaubteAngles(cfg);
  ['frage', 'zeitgeschehen', 'faktencheck'].forEach((a) => {
    assert.ok(!erlaubt.includes(a), `${a} darf bei Hellinger nicht angefordert werden`);
    assert.ok(BC.verboteneAngles(cfg)[a], `${a} braucht eine Begruendung aus dem Regelwerk`);
  });
  assert.ok(erlaubt.length >= 3, 'genug Alternativen, damit die Titel nicht eintoenig werden');
});

test('HH erlaubt Frage und Zeitgeschehen weiterhin', () => {
  const erlaubt = BC.erlaubteAngles(cfgOf('holistic-house'));
  assert.ok(erlaubt.includes('frage'));
  assert.ok(erlaubt.includes('zeitgeschehen'));
});

/* ---- Verbotspruefung ---- */

test('Hellinger-Verbote greifen an echten Verstoessen', () => {
  const cfg = cfgOf('hellinger');
  const ids = (t) => BC.pruefeText(cfg, t).map(f => f.id);
  assert.ok(ids('Melde Dich jetzt zum kostenfreien Webinar an.').includes('webinar'));
  assert.ok(ids('Jetzt kostenlos anmelden').includes('kostenlos'));
  assert.ok(ids('Du erkennst Deine Muster – und findest zurueck.').includes('gedankenstrich'));
  assert.ok(ids('Es liegt nicht an Deinem Partner, sondern an etwas Aelterem.').includes('nicht-sondern'));
  assert.ok(ids('Die Ausbildung kostet 7.000 €.').includes('preis'));
  assert.ok(ids('Wir zeigen Ihnen Ihren Weg.').includes('sie-anrede'), 'Sie-Anrede ist bei Hellinger falsch');
});

test('regelkonforme Hellinger-Copy erzeugt keinen Fehlalarm', () => {
  const sauber = 'Du bist herzlich eingeladen. Im kostenfreien Live-Seminar wird sichtbar, ' +
    'welche Ordnung hinter wiederkehrenden Themen wirkt. Veraenderung beginnt mit Erkennen.';
  assert.deepEqual(BC.pruefeText(cfgOf('hellinger'), sauber), []);
});

test('HH-Verbote greifen, ohne die Sie-Anrede zu beanstanden', () => {
  const cfg = cfgOf('holistic-house');
  const ids = (t) => BC.pruefeText(cfg, t).map(f => f.id);
  assert.ok(ids('In einer Welt, in der alles schneller wird.').includes('ki-satzanfang'));
  assert.ok(ids('Mehr als nur ein Webinar.').includes('mehr-als-nur'));
  assert.ok(ids('Eine ganzheitliche Betrachtung.').includes('leere-adjektive'));
  assert.ok(ids('Starten Sie JETZT!').includes('versal-cta'));
  assert.ok(ids('Du erkennst Deine Muster.').includes('du-anrede'), 'Du-Anrede ist bei HH falsch');
  assert.deepEqual(ids('Entdecken Sie, wie Ihr Koerper auf Stress reagiert.'), []);
});

test('Fragezeichen nur in den Feldern beanstandet, wo das Regelwerk sie verbietet', () => {
  const cfg = cfgOf('hellinger');
  assert.equal(BC.pruefeFeld(cfg, 'titel.h1', 'Bist Du bereit?').length, 1, 'im Seminartitel verboten');
  assert.equal(BC.pruefeFeld(cfg, 'bullets.0.title', 'Warum wiederholt sich das?').length, 1, 'in Inhalts-Bullets verboten');
  assert.equal(BC.pruefeFeld(cfg, 'introtext.paragraphs', 'Bist Du wirklich da?').length, 0,
    'in der Bodycopy ausdruecklich erwuenscht');
});

test('Konfigurationsblock wird aus dem System-Prompt entfernt', () => {
  for (const brand of ['hellinger', 'holistic-house']) {
    const text = rules(brand);
    const stripped = BC.stripFromPrompt(text);
    assert.ok(!stripped.includes('"angleKatalog"'), `${brand}: JSON-Inhalt noch im Prompt`);
    assert.ok(!stripped.includes('```json brand-config'), `${brand}: Fence noch im Prompt`);
    assert.ok(stripped.length < text.length - 1000, `${brand}: es wurde kaum etwas entfernt`);
    // Die eigentlichen Regeln bleiben unangetastet
    assert.ok(stripped.includes('Sprachliches Ausschlussregelwerk'), `${brand}: Regeln beschaedigt`);
  }
});

test('stripFromPrompt ist deterministisch - der Cache-Prefix darf nicht wandern', () => {
  const t = rules('hellinger');
  assert.equal(BC.stripFromPrompt(t), BC.stripFromPrompt(t));
});

test('Verbote greifen auch bei deutscher Flexion', () => {
  // "ganzheitliche" matcht \bganzheitlich\b nicht - genau so ist die erste
  // Fassung der Regex durchgerutscht und haette still nichts gefunden.
  const hh = cfgOf('holistic-house');
  const he = cfgOf('hellinger');
  const ids = (c, t) => BC.pruefeText(c, t).map(f => f.id);
  assert.ok(ids(hh, 'Eine ganzheitliche Betrachtung.').includes('leere-adjektive'));
  assert.ok(ids(hh, 'Echte Transformationen erleben.').includes('floskeln'));
  assert.ok(ids(hh, 'Zur Vorsorgeuntersuchung.').includes('vorsorge'));
  assert.ok(ids(he, 'Im Webinars-Format.').includes('webinar'));
  assert.ok(ids(he, 'Kostenlose Teilnahme.').includes('kostenlos'));
});

test('jedes Verbot nennt Hinweis und Fundstelle im Regelwerk', () => {
  // Ein Befund ohne Quelle ist im Review nicht ueberpruefbar.
  for (const brand of ['hellinger', 'holistic-house']) {
    (cfgOf(brand).verbote || []).forEach((v) => {
      assert.ok(v.id && v.hinweis && v.quelle, `${brand}: Verbot ${v.id} unvollstaendig`);
      assert.doesNotThrow(() => new RegExp(v.regex, 'gi'), `${brand}: Regex ${v.id} ist ungueltig`);
    });
  }
});

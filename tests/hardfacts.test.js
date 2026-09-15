'use strict';
const test = require('node:test');
const assert = require('node:assert');
const HardfactsIO = require('../shared/hardfacts.js');

/* So sah eine Hardfacts-Datei vor Phase 0 aus. */
const LEGACY = {
  kampagnenname: 'Ayurveda September',
  beschreibung: 'Live-Webinar mit Dr. Bauhofer.',
  live_termin: '20.09.2026, 11 Uhr',
  offer: 'Ayurveda Coach Ausbildung · 7.000 €',
  titel: 'Der Koerper ab 45',
  sub_headline: 'Sub',
  bulletpoints: ['a', 'b'],
  strategie_titel: 'Diese Winkel funktionieren, weil die Zielgruppe Autoritaet sucht.',
  zielgruppe: 'Diese Winkel funktionieren, weil die Zielgruppe Autoritaet sucht.'
};

test('Legacy-Zielgruppe wird erkannt und geleert, Text bleibt erhalten', () => {
  const { hf, migrated } = HardfactsIO.migrate(LEGACY);
  assert.equal(hf.zielgruppe, '', 'die falsch belegte Zielgruppe wird geleert');
  assert.equal(hf.strategie_titel, LEGACY.strategie_titel, 'der Text geht nicht verloren');
  assert.equal(migrated.length, 1, 'die Korrektur wird gemeldet, nicht still vorgenommen');
  assert.equal(HardfactsIO.audience(hf), null);
});

test('echte Zielgruppe bleibt unangetastet', () => {
  const echt = Object.assign({}, LEGACY, { zielgruppe: 'Frauen 45-65, gesundheitsbewusst' });
  const { hf, migrated } = HardfactsIO.migrate(echt);
  assert.equal(hf.zielgruppe, 'Frauen 45-65, gesundheitsbewusst');
  assert.equal(migrated.length, 0);
  assert.equal(HardfactsIO.audience(hf), 'Frauen 45-65, gesundheitsbewusst');
});

test('offer-String wird in Produkt und Preis getrennt', () => {
  const { hf } = HardfactsIO.migrate(LEGACY);
  assert.equal(hf.angebot.produkt, 'Ayurveda Coach Ausbildung');
  assert.equal(hf.angebot.preis, '7.000 €');
});

test('leeres " · " wird zu leer - sonst greift kein Fallback', () => {
  const { hf } = HardfactsIO.migrate(Object.assign({}, LEGACY, { offer: ' · ' }));
  assert.equal(hf.offer, '', '" · " ist truthy und hat jeden Fallback ausgehebelt');
  assert.equal(hf.angebot.produkt, '');
  assert.equal(hf.angebot.preis, '');
});

test('neues Format wird nicht angefasst', () => {
  const neu = {
    kampagnenname: 'X', zielgruppe: 'Frauen 45+',
    strategie_titel: 'Ganz andere Begruendung.',
    angebot: { produkt: 'Kurs', preis: '' },
    offer: 'Kurs', bulletpoints: ['a'],
    versions: { schemaVersion: 2 }
  };
  const { hf, migrated } = HardfactsIO.migrate(neu);
  assert.equal(migrated.length, 0);
  assert.deepEqual(hf.angebot, { produkt: 'Kurs', preis: '' });
  assert.equal(hf.versions.schemaVersion, 2);
});

test('robust gegen unvollstaendige und leere Eingaben', () => {
  for (const input of [null, undefined, {}, { offer: null }]) {
    const { hf } = HardfactsIO.migrate(input);
    assert.ok(Array.isArray(hf.bulletpoints));
    assert.equal(HardfactsIO.audience(hf), null);
  }
});

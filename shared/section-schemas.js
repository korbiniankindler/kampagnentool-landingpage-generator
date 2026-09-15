/* Struktur der Section-Typen als Daten.

   Bis hierher existierte diese Information nur als String-Template in
   `sectionSchemaHint` - gut fuer den Prompt, unbrauchbar fuer eine Pruefung.
   Die Anzahl-Vorgaben ("exakt 5 Eintraege", "genau 3 Testimonials") standen
   ausserdem an einer zweiten Stelle im Prompt und konnten auseinanderlaufen.

   Hier ist beides EINE Quelle: der Prompt-Hinweis wird daraus generiert, und
   die Validatoren pruefen dagegen. */
var SectionSchemas = (function () {
  'use strict';

  /* fields: Reihenfolge und Art der Felder.
       {name, kind: 'text'|'array', of: [...], min, max, optional}
     Die Laengenvorgaben stehen bewusst NICHT hier - sie liegen in
     COPY_LENGTH_RULES, wo sie mit Begruendung und Quelle dokumentiert sind. */
  var SCHEMAS = {
    hero: {
      label: 'Hero',
      /* Diese Felder setzt der Code aus dem bestaetigten Briefing, nicht das
         Modell (siehe mergeHero). Sie stehen deshalb nicht im Antwortschema. */
      deterministisch: ['preHeadline', 'h1', 'h2', 'bulletpoints', 'ctaButton'],
      fields: [
        {name: 'announcement', kind: 'text'},
        {name: 'ctaSubline', kind: 'text'},
        {name: 'videoPlaceholder', kind: 'text'}
      ]
    },
    trustbar: {
      label: 'Trust Bar',
      fields: [{name: 'note', kind: 'text'}]
    },
    introtext: {
      label: 'Intro Text',
      fields: [
        {name: 'badge', kind: 'text'},
        {name: 'headline', kind: 'text'},
        {name: 'paragraphs', kind: 'array', of: null, min: 3, max: 6},
        {name: 'closingLine', kind: 'text'}
      ]
    },
    problem: {
      label: 'Problem / Mirror Effect',
      fields: [
        {name: 'headline', kind: 'text'},
        {name: 'introCopy', kind: 'text'},
        {name: 'checklist', kind: 'array', of: ['title', 'text'], min: 5, max: 5},
        {name: 'transitionCopy', kind: 'text'},
        {name: 'ctaButton', kind: 'text'}
      ]
    },
    framework: {
      label: 'Educational Gap',
      fields: [
        {name: 'headline', kind: 'text'},
        {name: 'bodyCopy', kind: 'text'}
      ]
    },
    social: {
      label: 'Social Proof',
      fields: [
        {name: 'headline', kind: 'text'},
        {name: 'testimonials', kind: 'array', of: ['quote', 'name', 'role'], min: 3, max: 3}
      ]
    },
    authority: {
      label: 'Authority / Speaker',
      fields: [
        {name: 'headline', kind: 'text'},
        {name: 'bioBlock', kind: 'text'},
        {name: 'webinarRole', kind: 'text'},
        {name: 'ctaButton', kind: 'text'}
      ]
    },
    benefits: {
      label: 'Benefit Stack',
      fields: [
        {name: 'headline', kind: 'text'},
        {name: 'items', kind: 'array', of: ['title', 'text'], min: 3, max: 3}
      ]
    },
    finalcta: {
      label: 'Final CTA / Scarcity',
      fields: [
        {name: 'headline', kind: 'text'},
        {name: 'scarcityCopy', kind: 'text'},
        {name: 'ctaButton', kind: 'text'},
        {name: 'ctaSubline', kind: 'text'}
      ]
    },
    faq: {
      label: 'FAQ',
      fields: [
        {name: 'headline', kind: 'text'},
        {name: 'faqs', kind: 'array', of: ['question', 'answer'], min: 5, max: 7},
        {name: 'ctaButton', kind: 'text', optional: true}
      ]
    }
  };

  function get(id) { return SCHEMAS[id] || null; }
  function isKnown(id) { return !!SCHEMAS[id]; }
  function knownIds() { return Object.keys(SCHEMAS); }

  /* Felder, die das Modell liefern soll - ohne die deterministisch gesetzten. */
  function modelFields(id) {
    var sch = SCHEMAS[id];
    if (!sch) return [];
    return sch.fields.filter(function (f) {
      return (sch.deterministisch || []).indexOf(f.name) === -1;
    });
  }

  /* Erzeugt den JSON-Hinweis fuer den Prompt aus dem Schema. Vorher war das
     ein handgepflegter String neben den Anzahl-Vorgaben - zwei Orte, die
     auseinanderlaufen konnten. */
  function promptHint(id) {
    var sch = SCHEMAS[id];
    if (!sch) return null;
    var parts = modelFields(id).map(function (f) {
      if (f.kind === 'text') return '"' + f.name + '":"..."' + (f.optional ? ' (falls passend)' : '');
      if (!f.of) {
        var n = f.min || 3;
        return '"' + f.name + '":[' + new Array(n).fill('"..."').join(', ') + ']';
      }
      var obj = '{' + f.of.map(function (k) { return '"' + k + '":"..."'; }).join(',') + '}';
      var count = f.min === f.max ? f.min : f.min;
      return '"' + f.name + '":[' + new Array(count).fill(obj).join(', ') + ']';
    });
    return '{' + parts.join(', ') + '}';
  }

  /* Anzahl-Vorgaben als Prompt-Zeile, damit sie nicht zweimal gepflegt werden. */
  function countRules(id) {
    var sch = SCHEMAS[id];
    if (!sch) return null;
    var rules = sch.fields.filter(function (f) { return f.kind === 'array' && f.min; }).map(function (f) {
      if (f.min === f.max) return '"' + f.name + '": exakt ' + f.min + ' Eintraege';
      return '"' + f.name + '": ' + f.min + ' bis ' + f.max + ' Eintraege';
    });
    return rules.length ? rules.join(', ') : null;
  }

  return {
    SCHEMAS: SCHEMAS, get: get, isKnown: isKnown, knownIds: knownIds,
    modelFields: modelFields, promptHint: promptHint, countRules: countRules
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SectionSchemas;

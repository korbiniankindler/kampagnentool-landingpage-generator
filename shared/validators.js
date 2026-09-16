/* Deterministische Pruefung der generierten Landingpage.

   Zweck ist nicht in erster Linie Qualitaet, sondern ZEIT: Der Review-Schritt
   zeigt heute 9 Sections mit zusammen 60-100 editierbaren Feldern, ohne jede
   Fuehrung - kein Feld markiert, keine Auffaelligkeit hervorgehoben. Das ist
   der teuerste Posten des gesamten Workflows. Diese Pruefungen machen daraus
   eine Liste konkreter Befunde.

   Alles hier ist deterministisch und ohne Modell pruefbar. Was ein Modell
   beurteilen muesste (Ueberzeugungskraft, Zielgruppenpassung), gehoert NICHT
   hierher.

   Schweregrade:
     kritisch - bestaetigte Fakten verletzt, Struktur unbrauchbar, Regelverstoss.
                Sperrt den Export.
     hinweis  - pruefenswert, aber kein Blocker. */
var Validators = (function () {
  'use strict';

  var HAS_SCHEMAS = typeof SectionSchemas !== 'undefined';
  var HAS_BRAND = typeof BrandConfig !== 'undefined';

  function befund(schwere, id, text, extra) {
    return Object.assign({ schwere: schwere, id: id, text: text }, extra || {});
  }

  /* Vergleich, der Formatierung ignoriert aber Wortlaut nicht. Fuer die
     Pruefung "wurde der bestaetigte Titel wirklich uebernommen". */
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[‘’‚“”„'"`]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  function istLeer(v) {
    if (v == null) return true;
    if (Array.isArray(v)) return v.length === 0;
    var s = String(v).trim();
    /* Platzhalter, die das Modell aus dem Schema uebernommen hat, sind so
       gut wie leer - sie sehen im Editor aber wie Inhalt aus. */
    return s === '' || /^\.{2,}$/.test(s) || s === 'undefined' || s === 'null';
  }

  function getByPath(obj, path) {
    var cur = obj;
    var parts = String(path).split('.');
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      var k = /^\d+$/.test(parts[i]) ? parseInt(parts[i], 10) : parts[i];
      cur = cur[k];
    }
    return cur;
  }

  /* Alle Textwerte einer Section mit ihrem Pfad. */
  function textFelder(data, prefix, out) {
    out = out || [];
    prefix = prefix || '';
    if (data == null) return out;
    if (typeof data === 'string') { out.push({ path: prefix, text: data }); return out; }
    if (Array.isArray(data)) {
      data.forEach(function (v, i) { textFelder(v, prefix ? prefix + '.' + i : String(i), out); });
      return out;
    }
    if (typeof data === 'object') {
      Object.keys(data).forEach(function (k) { textFelder(data[k], prefix ? prefix + '.' + k : k, out); });
    }
    return out;
  }

  /* ---------------- Einzelpruefungen ---------------- */

  function pruefeVollstaendigkeit(ctx) {
    var f = [];
    ctx.active.forEach(function (s) {
      var d = ctx.sectionData[s.id];
      if (!d || typeof d !== 'object' || !Object.keys(d).length) {
        f.push(befund('kritisch', 'section-fehlt',
          'Section "' + s.name + '" wurde nicht generiert.', { section: s.id }));
        return;
      }
      if (!HAS_SCHEMAS || !SectionSchemas.isKnown(s.id)) return;
      SectionSchemas.modelFields(s.id).forEach(function (fld) {
        if (fld.optional) return;
        if (istLeer(d[fld.name])) {
          f.push(befund('kritisch', 'feld-leer',
            'Pflichtfeld "' + fld.name + '" ist leer.', { section: s.id, feld: fld.name }));
        }
      });
    });
    return f;
  }

  function pruefeAnzahlen(ctx) {
    var f = [];
    if (!HAS_SCHEMAS) return f;
    ctx.active.forEach(function (s) {
      var d = ctx.sectionData[s.id];
      var sch = SectionSchemas.get(s.id);
      if (!d || !sch) return;
      sch.fields.forEach(function (fld) {
        if (fld.kind !== 'array' || !fld.min) return;
        if ((sch.deterministisch || []).indexOf(fld.name) !== -1) return;
        var arr = d[fld.name];
        if (!Array.isArray(arr)) return;
        if (arr.length < fld.min || arr.length > fld.max) {
          f.push(befund('kritisch', 'anzahl',
            '"' + fld.name + '" hat ' + arr.length + ' Eintraege, erwartet sind ' +
            (fld.min === fld.max ? fld.min : fld.min + ' bis ' + fld.max) + '.',
            { section: s.id, feld: fld.name }));
        }
      });
    });
    return f;
  }

  /* Der Kern: Wurde uebernommen, was der Mensch bestaetigt hat? */
  function pruefeFaktenerhalt(ctx) {
    var f = [];
    var hero = ctx.sectionData.hero;
    var hf = ctx.hf || {};
    if (!hero) return f;

    [['h1', hf.titel, 'Titel'], ['h2', hf.sub_headline, 'Sub-Headline'], ['preHeadline', hf.pre_headline, 'Pre-Headline']]
      .forEach(function (pair) {
        var feld = pair[0], soll = pair[1], label = pair[2];
        if (!soll) return;
        if (norm(hero[feld]) !== norm(soll)) {
          f.push(befund('kritisch', 'fakt-geaendert',
            'Hero-' + feld + ' weicht vom bestaetigten ' + label + ' ab.',
            { section: 'hero', feld: feld, erwartet: soll, gefunden: hero[feld], autofix: true }));
        }
      });

    var soll = hf.bulletpoints || [];
    var ist = hero.bulletpoints || [];
    if (soll.length && ist.length !== soll.length) {
      f.push(befund('kritisch', 'bullet-anzahl',
        'Hero hat ' + ist.length + ' Bulletpoints, bestaetigt waren ' + soll.length + '.',
        { section: 'hero', feld: 'bulletpoints', autofix: true }));
    }
    soll.forEach(function (orig, i) {
      var b = ist[i];
      if (!b) return;
      var zusammen = norm((b.title || '') + ' ' + (b.text || ''));
      if (zusammen !== norm(orig)) {
        f.push(befund('kritisch', 'bullet-geaendert',
          'Bulletpoint ' + (i + 1) + ' wurde umformuliert statt nur aufgeteilt.',
          { section: 'hero', feld: 'bulletpoints.' + i, erwartet: orig,
            gefunden: (b.title || '') + ' ' + (b.text || ''), autofix: true }));
      }
    });
    return f;
  }

  function pruefeLocks(ctx) {
    var f = [];
    var locks = ctx.lockedFields || {};
    Object.keys(locks).forEach(function (secId) {
      var d = ctx.sectionData[secId];
      Object.keys(locks[secId] || {}).forEach(function (path) {
        var erwartet = locks[secId][path];
        /* Nur pruefbar, wenn der Wert mitgefuehrt wird. Ist der Lock nur als
           `true` gesetzt (alte Struktur), kann hier nichts geprueft werden. */
        if (erwartet === true || erwartet == null) return;
        var ist = getByPath(d, path);
        if (ist === undefined) {
          f.push(befund('kritisch', 'lock-pfad-weg',
            'Gesperrtes Feld "' + path + '" existiert in der neuen Fassung nicht mehr.',
            { section: secId, feld: path }));
        } else if (norm(ist) !== norm(erwartet)) {
          f.push(befund('kritisch', 'lock-verletzt',
            'Gesperrtes Feld "' + path + '" wurde veraendert.',
            { section: secId, feld: path, erwartet: erwartet, gefunden: ist, autofix: true }));
        }
      });
    });
    return f;
  }

  function pruefePreset(ctx) {
    var f = [];
    if (!HAS_BRAND || !ctx.brandCfg) return f;
    ctx.active.forEach(function (s) {
      var d = ctx.sectionData[s.id];
      if (!d) return;
      textFelder(d).forEach(function (feld) {
        var pfad = s.id + '.' + feld.path;
        BrandConfig.pruefeText(ctx.brandCfg, feld.text).forEach(function (v) {
          f.push(befund('kritisch', 'preset-verstoss',
            v.hinweis + ' (gefunden: ' + v.treffer.join(', ') + ')',
            { section: s.id, feld: feld.path, quelle: v.quelle, regel: v.id }));
        });
        BrandConfig.pruefeFeld(ctx.brandCfg, pfad, feld.text).forEach(function (v) {
          f.push(befund('kritisch', 'preset-verstoss-feld', v.hinweis,
            { section: s.id, feld: feld.path, quelle: v.quelle, regel: v.id }));
        });
      });
    });
    return f;
  }

  /* Wortfolgen, die in zwei Sections auftauchen. Faengt das Dopplungsproblem,
     gegen das der Content-Plan antritt - nur eben messbar. */
  function pruefeRedundanz(ctx, minGram) {
    minGram = minGram || 6;
    var f = [];
    var perSection = {};
    ctx.active.forEach(function (s) {
      var d = ctx.sectionData[s.id];
      if (!d) return;
      var words = textFelder(d).map(function (x) { return norm(x.text); }).join(' ').split(/\s+/).filter(Boolean);
      var grams = {};
      for (var i = 0; i + minGram <= words.length; i++) grams[words.slice(i, i + minGram).join(' ')] = true;
      perSection[s.id] = grams;
    });
    var ids = Object.keys(perSection);
    for (var a = 0; a < ids.length; a++) {
      for (var b = a + 1; b < ids.length; b++) {
        var shared = Object.keys(perSection[ids[a]]).filter(function (g) { return perSection[ids[b]][g]; });
        if (shared.length) {
          f.push(befund('hinweis', 'redundanz',
            'Gleiche Wortfolge in "' + ids[a] + '" und "' + ids[b] + '": "' + shared[0] + '"',
            { section: ids[b], andere: ids[a], treffer: shared.length }));
        }
      }
    }
    return f;
  }

  function pruefeExport(ctx) {
    var f = [];
    ctx.active.forEach(function (s) {
      var d = ctx.sectionData[s.id];
      if (!d) return;
      textFelder(d).forEach(function (feld) {
        if (/\\n|\\t/.test(feld.text)) {
          f.push(befund('hinweis', 'escape-sichtbar',
            'Feld enthaelt die Zeichenfolge \\n - sie erscheint woertlich auf der Seite.',
            { section: s.id, feld: feld.path }));
        }
      });
    });
    return f;
  }

  /* ---------------- Gesamtlauf ---------------- */

  /* Vertrauensbehauptungen, die eine Quelle brauchen.

     Gefunden in zwei aufeinanderfolgenden Live-Laeufen, beide Male in der
     Trustbar und jedes Mal anders formuliert: "Bekannt aus etablierten
     Medien", "international bekannt und wird seit Jahrzehnten oeffentlich
     referenziert". Das Modell fuellt eine leere Vorgabe mit dem, was auf
     Landingpages ueblich ist - und eine erfundene Presse-Nennung ist eine
     irrefuehrende geschaeftliche Handlung, kein Stilproblem.

     WAS DIESE PRUEFUNG NICHT KANN: Sie weiss nicht, ob die Behauptung belegt
     ist. Die Wissensdatenbank liegt als Fliesstext vor, nicht als
     Faktenbasis, gegen die sich etwas abgleichen liesse. Deshalb ist der
     Befund ein HINWEIS und keine Sperre - er markiert die Stelle und sagt,
     wogegen zu pruefen ist. Ein kritischer Befund waere hier ein
     Fehlalarm-Generator, und ein Gate, das grundlos sperrt, bringt Nutzer
     dazu, Befunde generell zu uebergehen. */
  var VERTRAUENSBEHAUPTUNGEN = [
    { id: 'bekannt-aus', re: /\bbekannt aus\b/i, was: 'eine Medien-Nennung' },
    { id: 'medien', re: /\b(in den medien|medienberichte|presseberichte|pressestimmen|tv-auftritt)\w*/i, was: 'eine Presse-Nennung' },
    { id: 'international-bekannt', re: /\b(international|weltweit|europaweit)\s+(bekannt|anerkannt|fuehrend|führend)\w*/i, was: 'eine Bekanntheits-Behauptung' },
    { id: 'referenziert', re: /\boeffentlich referenziert|öffentlich referenziert/i, was: 'eine Referenz-Behauptung' },
    { id: 'ausgezeichnet', re: /\b(ausgezeichnet mit|preistraeger|preisträger|zertifiziert durch|akkreditiert)\w*/i, was: 'eine Auszeichnung' },
    { id: 'marktfuehrer', re: /\b(marktfuehrer|marktführer|nummer 1|nr\.? 1|fuehrender anbieter|führender anbieter)\w*/i, was: 'eine Marktstellung' }
  ];

  function pruefeVertrauensbehauptungen(ctx) {
    var f = [];
    /* Pro Section iterieren, nicht ueber die gesamten sectionData: `feld` ist
       ueberall sonst der Pfad INNERHALB der Section, mit der Section separat
       in `section`. Ein Befund mit "trustbar.note" statt "note" findet in der
       Oberflaeche sein Feld nicht. */
    ctx.active.forEach(function (s) {
      var d = ctx.sectionData[s.id];
      if (!d) return;
      textFelder(d).forEach(function (feld) {
        VERTRAUENSBEHAUPTUNGEN.forEach(function (v) {
          var treffer = String(feld.text).match(v.re);
          if (!treffer) return;
          f.push(befund('hinweis', 'vertrauensbehauptung',
            'Die Copy behauptet ' + v.was + ' ("' + treffer[0] + '"). Bitte pruefen, ob das in der ' +
            'Wissensdatenbank oder im Briefing belegt ist - erfundene Bekanntheits- und ' +
            'Medienangaben sind rechtlich angreifbar. Ist nichts belegt: streichen.',
            { section: s.id, feld: feld.path }));
        });
      });
    });
    return f;
  }

  function pruefeAlles(ctx) {
    ctx = ctx || {};
    ctx.sectionData = ctx.sectionData || {};
    ctx.active = (ctx.active || []).filter(Boolean);
    return [].concat(
      pruefeVollstaendigkeit(ctx),
      pruefeAnzahlen(ctx),
      pruefeFaktenerhalt(ctx),
      pruefeLocks(ctx),
      pruefePreset(ctx),
      pruefeRedundanz(ctx),
      pruefeVertrauensbehauptungen(ctx),
      pruefeExport(ctx)
    );
  }

  function kritische(befunde) {
    return befunde.filter(function (b) { return b.schwere === 'kritisch'; });
  }

  function proSection(befunde) {
    var map = {};
    befunde.forEach(function (b) {
      var k = b.section || '_allgemein';
      (map[k] = map[k] || []).push(b);
    });
    return map;
  }

  /* ---------------- Deterministischer Hero-Merge ----------------

     Setzt die vom Menschen bestaetigten Werte im Code, statt sie vom Modell
     zurueckzuerwarten. Der Prompt bittet zwar darum ("exakt aus Titel"), aber
     eine Bitte ist keine Garantie - und bei der Section-Neugenerierung fehlte
     sie frueher ganz, weshalb ein Hero-Regen den bestaetigten Titel neu
     erfunden hat.

     Was das Modell weiterhin schreibt: announcement, ctaSubline,
     videoPlaceholder. Was der Code setzt: preHeadline, h1, h2, bulletpoints,
     ctaButton.

     Die Bullets kommen als Strings aus dem Briefing, der Hero braucht
     {title, text}. Das Modell DARF aufteilen, aber nicht umformulieren:
     ergibt title + text wieder den Originalsatz, wird die Aufteilung
     uebernommen; sonst landet der Originalsatz vollstaendig in `title`.
     Verlustfrei und ohne Sprachverstaendnis im Code. */
  function mergeHero(heroData, hf, lpVorlage, protokoll) {
    var out = Object.assign({}, heroData || {});
    hf = hf || {};
    /* Was der Merge korrigiert, wird protokolliert. Nicht als Fehler - die
       Korrektur ist ja erfolgt - aber als Hinweis: Das Modell wollte vom
       bestaetigten Wert abweichen. Fuer die Qualitaetsbeurteilung und fuer
       den Benchmark ist genau das eine messbare Groesse. */
    function setze(feld, sollWert) {
      if (sollWert == null) return;
      if (out[feld] != null && norm(out[feld]) !== norm(sollWert) && protokoll) {
        protokoll.push({ feld: feld, gewollt: out[feld], gesetzt: sollWert });
      }
      out[feld] = sollWert;
    }

    setze('preHeadline', hf.pre_headline);
    setze('h1', hf.titel);
    setze('h2', hf.sub_headline);
    if (lpVorlage && lpVorlage.ctaText) setze('ctaButton', lpVorlage.ctaText);

    var soll = hf.bulletpoints || [];
    var geliefert = Array.isArray(heroData && heroData.bulletpoints) ? heroData.bulletpoints : [];
    if (soll.length && geliefert.length && geliefert.length !== soll.length && protokoll) {
      protokoll.push({ feld: 'bulletpoints', gewollt: geliefert.length + ' Stueck', gesetzt: soll.length + ' Stueck' });
    }
    out.bulletpoints = soll.map(function (orig, i) {
      var b = geliefert[i];
      if (b && typeof b === 'object') {
        var title = String(b.title || '').trim();
        var text = String(b.text || '').trim();
        if (title && norm(title + ' ' + text) === norm(orig)) {
          return { title: title, text: text };
        }
        if (title && protokoll) {
          protokoll.push({ feld: 'bulletpoints.' + i, gewollt: (title + ' ' + text).trim(), gesetzt: orig });
        }
      }
      /* Aufteilung unbrauchbar oder umformuliert - Originalsatz uebernehmen.
         Ein leeres `text` ist zulaessig und im Editor nachtragbar. */
      return { title: String(orig), text: '' };
    });
    return out;
  }

  /* Wendet die eindeutig behebbaren Befunde an. Nur dort, wo es genau EINE
     richtige Auflösung gibt - alles andere bleibt eine Entscheidung des
     Menschen. */
  function autofix(sectionData, befunde) {
    var angewandt = [];
    befunde.filter(function (b) { return b.autofix && b.erwartet !== undefined; }).forEach(function (b) {
      var d = sectionData[b.section];
      if (!d || !b.feld) return;
      var parts = String(b.feld).split('.');
      var cur = d;
      for (var i = 0; i < parts.length - 1; i++) {
        var k = /^\d+$/.test(parts[i]) ? parseInt(parts[i], 10) : parts[i];
        if (cur[k] == null) return;
        cur = cur[k];
      }
      var last = parts[parts.length - 1];
      cur[/^\d+$/.test(last) ? parseInt(last, 10) : last] = b.erwartet;
      angewandt.push(b);
    });
    return angewandt;
  }

  return {
    mergeHero: mergeHero,
    autofix: autofix,
    pruefeAlles: pruefeAlles,
    kritische: kritische,
    proSection: proSection,
    norm: norm,
    istLeer: istLeer,
    textFelder: textFelder,
    _pruefungen: {
      vollstaendigkeit: pruefeVollstaendigkeit, anzahlen: pruefeAnzahlen,
      faktenerhalt: pruefeFaktenerhalt, locks: pruefeLocks,
      preset: pruefePreset, redundanz: pruefeRedundanz, exportierbar: pruefeExport
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Validators;

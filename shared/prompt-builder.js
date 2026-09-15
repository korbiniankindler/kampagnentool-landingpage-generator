/* Baut die Prompts fuer die Landingpage-Generierung.

   Der Grund fuer diese Datei ist ein konkreter Defekt: Erst- und
   Neugenerierung bauten ihren Prompt getrennt und von Hand. Dem
   Regenerierungs-Prompt fehlten dadurch saemtliche Section-Regeln
   (Hero "exakt aus Titel", Checkliste exakt 5, Testimonials exakt 3,
   FAQ 5-7, Referent nie erfinden), der Seitenaufbau, der Content-Plan,
   Termin, Offer und die Bulletpoints. Wer den Hero regenerierte, bekam
   einen neu erfundenen Titel.

   Solange zwei Prompts von Hand synchron gehalten werden muessen, kehrt
   dieser Defekt wieder. Deshalb eine Quelle fuer beide Modi - und fuer den
   Headless-Runner, der ohne dieselben Prompts nichts Aussagekraeftiges
   messen koennte.

   Im Browser global, in Node ueber module.exports. Braucht SectionSchemas
   und (optional) BrandConfig. */
var PromptBuilder = (function () {
  'use strict';

  var S = (typeof SectionSchemas !== 'undefined') ? SectionSchemas
        : (typeof require !== 'undefined' ? require('./section-schemas.js') : null);

  /* Wortlaengen und Zitat-Regeln fuer alle Textfelder. Gelten in der
     Voll-Generierung UND in jeder Ueberarbeitung - stuenden sie nur im ersten
     Prompt, wuerde jede Neugenerierung die Vorgaben verlieren.
     Zahlen aus echten BrandLift-Landingpages ausgezaehlt (Hellinger-Kongress,
     Hellinger-Webinar, HH-NEM, HH-B2B, HH-Reset). */
  var COPY_LENGTH_RULES = [
  'TEXTLAENGEN (verbindlich): Reine Fliesstext-Bloecke duerfen und sollen ausfuehrlich sein - knappe Stichpunkte wirken auf einer Landingpage duenn und nehmen der Copy die Wirkung. Richtwerte:',
  '- introtext "paragraphs": Das ist der LAENGSTE Textblock der Seite. Vorgegeben ist die Gesamtlaenge von 200-320 Woertern, nicht die Zahl der Absaetze. Unter 200 Woertern ist die Section zu duenn - lieber eine Station der Story mehr erzaehlen als frueh auf die Methode schwenken.',
  '  Der Intro-Text ERZAEHLT, er erklaert nicht. Er fuehrt den Leser durch seine eigene Erfahrung, bevor irgendeine Methode vorkommt: was er schon versucht hat, was sich trotzdem wiederholt, welcher leise Gedanke dabei auftaucht, warum das Thema auf dieser Ebene nicht loesbar war. Nimm Dir dafuer Raum.',
  '  Wie viele Absaetze daraus werden, ergibt sich aus der Story und darf zwischen 3 und 6 liegen - setze einen Umbruch dort, wo der Gedanke wechselt, nicht nach einem festen Raster. Liefere nicht bei jeder Kampagne dieselbe Anzahl. Absatzlaengen deutlich variieren: ein verdichteter Absatz von 20 Woertern neben einem ausfuehrlichen von 80 ist gewollt, gleich lange Bloecke lesen sich monoton.',
  '- framework bodyCopy und jeder andere freie Fliesstext-Block: 90-140 Woerter.',
  '- problem introCopy und transitionCopy: je 30-50 Woerter.',
  '- checklist-, items- und bulletpoints-Eintraege: "title" 2-6 Woerter, "text" 20-35 Woerter.',
  '- authority bioBlock: 60-100 Woerter.',
  '- Eintraege eigener Sections (columns, cards, steps o.ae.): "headline" 3-8 Woerter, "bodyCopy" 50-100 Woerter je Eintrag.',
  '- faq: "question" 5-12 Woerter, "answer" 25-50 Woerter. Die Antwort beantwortet die Frage zuerst konkret und haengt erst danach eine Einordnung an.',
  '- Ausnahmen, die kurz bleiben: closingLine, scarcityCopy, ctaSubline, ctaButton, badge, announcement - je ein Satz oder weniger.',
  '',
  'TESTIMONIALS: Zitat, Name und Berufsrolle werden frei formuliert - als Entwurf, den die Marke spaeter durch echte Stimmen ersetzt oder freigibt. Nicht aus der Wissensdatenbank abschreiben, sondern zur konkreten Kampagne passend neu schreiben.',
  '- Laenge je Zitat 70-110 Woerter, 4-6 Saetze. Das ist bewusst lang: kurze Statements lesen sich wie Werbetexte, ausfuehrliche wie echte Menschen.',
  '- Baue jedes Zitat in drei Schritten: (1) die Ausgangslage mit EINEM konkreten Detail aus dem Alltag - nicht "ich hatte Konflikte", sondern die konkrete Situation, die Person, der wiederkehrende Moment. (2) Ein einzelner Moment aus dem Seminar, der etwas gekippt hat - eine Szene, keine Zusammenfassung. (3) Was sich seitdem im Alltag konkret zeigt, ebenfalls an einem Beispiel statt an einem Ergebnis-Satz.',
  '- Persoenlich heisst konkret: Namen von Angehoerigen ("meine Schwester", "mein aeltester Sohn"), Orte, Situationen (das Telefonat, das Familienessen, die Teambesprechung). Abstrakte Nomen wie Klarheit, Veraenderung, Erkenntnis, Blockade sind Marketing-Vokabular und gehoeren nicht in ein Zitat.',
  '- Sprache wie echte Teilnehmer: Umgangssprache, auch mal ein unrunder oder angefangener Satz, ein Vorbehalt, eine anfaengliche Skepsis, etwas das noch nicht fertig ist ("ich bin noch mittendrin"). Keine Superlative, keine Werbeformulierungen, kein rundes Fazit am Ende.',
  '- "name": Vorname plus abgekuerzter Nachname (z.B. "Martina K."). Drei klar unterscheidbare Personen, nicht dreimal derselbe Typ.',
  '- "role": frei gewaehlt und zur Zielgruppe passend (z.B. "Projektleiterin", "Selbststaendig", "Vater von zwei Kindern"). KEINE geschuetzten Berufsbezeichnungen erfinden - Arzt, Aerztin, Heilpraktiker, Psychotherapeut und vergleichbare Titel nur, wenn die Wissensdatenbank eine solche Person tatsaechlich belegt.',
  '- Alltagsnahe Zeitangaben sind erwuenscht ("seit dem Wochenende", "ein halbes Jahr spaeter") - sie machen das Zitat konkret. Keine erfundenen Messwerte, Diagnosen, Heilungsverlaeufe oder Erfolgszahlen.'  ].join('\n');

  function line(label, value) {
    return value ? label + ': ' + value + '\n' : '';
  }

  /* Kampagnen-Kopf: identisch in Erst- und Neugenerierung. Vorher stand in der
     Neugenerierung nur Titel und Zielgruppe - Termin, Offer, Pre-/Sub-Headline
     und die Bulletpoints fehlten dort komplett. */
  function campaignBlock(o) {
    var hf = o.hf || {};
    var bpList = (hf.bulletpoints || []).map(function (b, i) { return (i + 1) + '. ' + b; }).join('\n');
    return 'Kampagne:\n' +
      line('Titel', hf.titel || hf.kampagnenname) +
      line('Pre-Headline', hf.pre_headline) +
      line('Sub-Headline', hf.sub_headline) +
      line('Termin', hf.live_termin) +
      line('Offer', hf.offer) +
      (hf.beschreibung ? 'Kampagnen-Beschreibung (Thema, Host/Referent, Besonderheiten): ' + hf.beschreibung + '\n' : '') +
      'Inhalts-Bullets (1:1 für Hero verwenden):\n' + (bpList || '(keine Bulletpoints angegeben)') + '\n' +
      'Zielgruppe: ' + (o.zielgruppe || '(keine Angabe)') + '\n' +
      (o.strategie ? 'Strategie / Positionierung: ' + o.strategie + '\n' : '') +
      (o.ctxBlock || '');
  }

  /* Seitenaufbau und Content-Plan. Beides gehoert auch in die Neugenerierung:
     ohne sie verbessert das Modell eine Section lokal und erzeugt dabei neue
     Dopplungen mit ihren Nachbarn. */
  function planBlock(o) {
    var out = '';
    if (o.pageMap) {
      out += 'Aufbau der GESAMTEN Landingpage' +
        (o.mode === 'regen' ? ' (Du ueberarbeitest genau eine davon)' :
          ' (dieser Request generiert nur einen Teil davon, die übrigen Sections werden separat generiert)') +
        ':\n' + o.pageMap + '\n\n';
    }
    if (o.planText) {
      out += 'Content-Plan (verbindliche Kernbotschaft je Section' +
        (o.mode === 'regen' ? '' : ' - auch die separat generierten Sections halten sich daran') + '):\n' +
        o.planText + '\n\n';
    }
    return out;
  }

  function heroVorgabe(o) {
    var anzahl = ((o.hf && o.hf.bulletpoints) || []).length;
    var v = o.lpVorlage;
    var cta = v && v.ctaText ? v.ctaText : 'Jetzt kostenfrei anmelden';
    var micro = v && v.microcopy ? v.microcopy : '100 % kostenfrei · Am [Datum] um [Uhrzeit]';
    var event = (o.brandCfg && o.brandCfg.eventBezeichnung) || 'Live-Webinar';
    return '- Hero: announcement = kurzer Termin-Hinweis fuer die Announcement-Bar ganz oben, basierend auf "Termin". ' +
      'Nenne das Format "' + event + '" - genau so, keine andere Bezeichnung. ' +
      'Verwende die Hardfacts DIREKT und ungekuerzt: preHeadline = exakt aus "Pre-Headline", h1 = exakt aus "Titel", ' +
      'h2 = exakt aus "Sub-Headline". Aendere daran kein Wort.\n' +
      '  Die bulletpoints kommen 1:1 aus "Inhalts-Bullets": ' +
      (anzahl
        ? 'genau ' + anzahl + ' Stueck, in derselben Reihenfolge, im Wortlaut unveraendert. Liefere weder mehr noch weniger.'
        : 'keine angegeben - dann bulletpoints als leeres Array.') +
      ' Zerlege jeden Bullet in {"title","text"}: title ist der tragende Kern (2-6 Woerter), ' +
      'text der Rest des Satzes. Erfinde keinen Inhalt dazu; laesst sich ein Bullet nicht sinnvoll teilen, ' +
      'gehoert der ganze Satz in "title" und "text" bleibt leer.\n' +
      '  ctaButton = "' + cta + '", ctaSubline orientiert sich an: "' + micro + '" (Platzhalter durch die echten Werte ersetzen), ' +
      'videoPlaceholder = "[16:9 Video-Platzhalter: Anmeldeseiten-Video mit Referent]"\n';
  }

  /* Section-Regeln. Fruehe Fassung: nur im Chunk-Prompt. Der wichtigste Teil
     dieser Datei - genau diese Zeilen fehlten der Neugenerierung. */
  function sectionRegeln(o) {
    var v = o.lpVorlage;
    return '- KEINE inhaltlichen Dopplungen zwischen Sections: Jede Section erfüllt exakt ihre Rolle laut Seitenaufbau' +
      (o.planText ? ' und Content-Plan' : '') +
      '. Argumente, Beispiele, Formulierungen und Narrative, die zu einer anderen Section gehören, hier NICHT wiederholen - auch nicht umformuliert. Schreibe jede Section aus ihrem eigenen Blickwinkel.\n' +
      heroVorgabe(o) +
      '- introtext (Intro Text): badge = kurze Pill-Kategorie (max 5 Worte), headline = aufmerksamkeitsstarke H2, paragraphs = Array aus Fließtext-Absätzen, die zusammen eine Kontext-Story aufbauen (Gesamtlänge und Absatzzahl siehe TEXTLAENGEN unten - die Absatzzahl ist bewusst nicht vorgegeben) (gesellschaftlicher Wandel, Warum-jetzt-Narrativ, Marktentwicklung oder ähnliches passend zur Kampagne), closingLine = Brücken-Satz der auf den Referenten und die Veranstaltung leitet. Den Aufhänger der Kontext-Story frisch und spezifisch für DIESE Kampagne wählen: NICHT automatisch das Zeitgeschehen-Ereignis oder den Einstieg der Referenz-Copy übernehmen (z.B. eine bestimmte Reform) - die Referenz zeigt nur, WIE so eine Story erzählt wird, nicht WORÜBER. Belegte Fakten aus der Wissensdatenbank passend zum Kampagnen-Thema auswählen.\n' +
      '- Educational Gap (framework): headline + bodyCopy als erklärenden Fließtext-Block, KEIN Kompass-Prinzip\n' +
      '- Problem-Checklist: ' + S.countRules('problem') + ' als Array mit je "title" und "text"\n' +
      '- Testimonials: ' + S.countRules('social') + ' als Array mit je "quote", "name", "role"\n' +
      '- faq (FAQ): headline + "faqs" als Array, ' + S.countRules('faq') + ', je "question" und "answer". Das ist eine echte Frage-Antwort-Liste, KEIN Fließtext-Block - fasse die Antworten NICHT zu einem Absatz zusammen. Die Fragen sind die, die eine Anmeldung tatsächlich blockieren: Termin und Dauer, Aufzeichnung falls verhindert, technische Voraussetzungen, Vorwissen, Kosten und Verbindlichkeit, für wen es geeignet ist, was danach passiert. Jede Frage in der Sprache des Lesers ("Was, wenn ich am Termin nicht kann?"), nicht in Marketingsprache. Fragezeichen sind hier ausdrücklich richtig, auch wenn das Marken-Preset Fragen an anderer Stelle ausschließt.\n' +
      '- Benefits items: ' + S.countRules('benefits') + ' als Array mit je "title" und "text"\n' +
      '- Eigene Sections (im Schema mit "Eigene Section ... Beschreibung:" kommentiert): Die Beschreibung gibt die STRUKTUR vor, nicht nur den Inhalt. Nennt sie mehrere gleichartige Elemente (z.B. zwei Columns, drei Karten, vier Schritte), dann liefere dafür ein Array aus Objekten - ein Objekt pro Element mit eigenen Feldern, z.B. "columns": [{"headline":"...","bodyCopy":"..."}, {"headline":"...","bodyCopy":"..."}]. Benenne den Array-Key nach dem, was die Beschreibung beschreibt (columns, cards, steps, ...), und liefere exakt so viele Einträge wie dort verlangt - fasse sie NIEMALS zu einem einzigen Fließtext-Block zusammen. Beschreibt die Beschreibung dagegen einen einzelnen Textblock, genügt {"headline":"...", "bodyCopy":"..."}. Erfinde keine Felder, die die Beschreibung nicht hergibt.\n' +
      '- Alle String-Werte EINZEILIG: keine echten Zeilenumbrüche UND keine \\n-Sequenzen im Text (die erscheinen sonst wörtlich auf der Seite). Brauchst Du mehrere Absätze, nutze ein Array aus Strings statt einem String mit Umbrüchen.\n' +
      '- Innerhalb von Textwerten NIEMALS gerade Anführungszeichen ("...") verwenden - sie beenden den String und zerstören das JSON. Zum Zitieren im Fließtext typografische Anführungszeichen nutzen: „...".\n' +
      '- Referent/Host NIEMALS erfinden: Verwende für Authority/Speaker und alle Referenten-Nennungen ausschließlich die Person aus der Kampagnen-Beschreibung bzw. dem Copywriter-Preset (Name, Titel, belegte Fakten). Fehlen Angaben zur Person komplett, schreibe neutral ohne erfundene Namen, Qualifikationen oder Erfahrungsjahre und setze Platzhalter in eckigen Klammern, z.B. [Name Referent].\n' +
      '- Alle CTAs fuehren zu: ' + (v ? v.conversionAction : 'anmeldung') +
        '. Wortlaut des Haupt-CTA: "' + (v ? v.ctaText : 'Jetzt kostenfrei anmelden') + '"\n' +
      '- Sprache: Deutsch\n\n';
  }

  /* Prompt fuer einen Chunk der Erstgenerierung. */
  function buildChunkPrompt(o) {
    o = Object.assign({ mode: 'initial' }, o);
    var schemaLines = (o.chunk || []).map(function (s) {
      return '"' + s.id + '": ' + (S.promptHint(s.id) || '{ ...Felder und Struktur SELBST aus der Beschreibung dieser Section ableiten... }') +
        (s.custom ? '  // Eigene Section "' + s.name + '" - Beschreibung: ' + s.desc : '');
    }).join(',\n  ');

    return campaignBlock(o) + '\n' +
      planBlock(o) +
      'Generiere folgende Sections als JSON-Objekt mit exakt diesen Keys:\n{\n  ' + schemaLines + '\n}\n\n' +
      'Regeln:\n' +
      sectionRegeln(o) +
      COPY_LENGTH_RULES + '\n\n' +
      '- NUR das JSON-Objekt, absolut kein anderer Text';
  }

  /* Prompt fuer die Neugenerierung EINER Section.
     Bekommt jetzt denselben Kampagnen-Kopf, denselben Seitenaufbau, denselben
     Content-Plan und dieselben Section-Regeln wie die Erstgenerierung. */
  function buildRegenPrompt(o) {
    o = Object.assign({ mode: 'regen' }, o);
    var s = o.section;
    var schema = S.promptHint(s.id) || '{ ...Felder und Struktur SELBST aus der Beschreibung dieser Section ableiten... }';

    return campaignBlock(o) + '\n' +
      planBlock(o) +
      (o.nachbarn ? 'Bereits geschriebene Sections (zur Konsistenz, NICHT neu generieren):\n' + o.nachbarn + '\n\n' : '') +
      'Überarbeite NUR die Section "' + s.name + '" (' + s.id + '). Erwartetes Schema:\n' + schema + '\n\n' +
      (s.custom ? 'Beschreibung dieser eigenen Section: ' + s.desc + '\n' +
        'Die Beschreibung gibt die STRUKTUR vor: Nennt sie mehrere gleichartige Elemente (z.B. zwei Columns, drei Karten), liefere ein Array aus Objekten mit einem Objekt pro Element und exakt so vielen Einträgen wie verlangt - niemals zu einem einzigen Fließtext-Block zusammenfassen. Behalte die Feldnamen der bestehenden Section bei, sofern sie zur Beschreibung passen.\n\n' : '') +
      'Feedback: ' + (o.feedback || 'Allgemein verbessern, Konsistenz mit dem Rest der Seite wahren.') + '\n\n' +
      (o.lockedSnap && o.lockedSnap.length
        ? 'GESPERRTE FELDER - diese Werte unverändert und wörtlich in das JSON übernehmen, NICHT umformulieren (der Rest der Section muss inhaltlich dazu passen):\n' +
          o.lockedSnap.map(function (l) { return '- ' + l.path + ': ' + JSON.stringify(l.value); }).join('\n') + '\n\n'
        : '') +
      'Es gelten dieselben Regeln wie bei der Erstgenerierung:\n' +
      sectionRegeln(o) +
      COPY_LENGTH_RULES + '\n\n' +
      'Gib NUR das JSON-Objekt für diese Section zurück - kein Wrapper, kein Markdown, kein Text drumherum.';
  }

  /* Kompakte Uebersicht aller aktiven Sections in Seitenreihenfolge. */
  function buildPageMap(active) {
    return (active || []).map(function (s, i) { return (i + 1) + '. ' + s.name + ' (' + s.id + '): ' + s.desc; }).join('\n');
  }

  return {
    COPY_LENGTH_RULES: COPY_LENGTH_RULES,
    buildChunkPrompt: buildChunkPrompt,
    buildRegenPrompt: buildRegenPrompt,
    buildPageMap: buildPageMap,
    sectionRegeln: sectionRegeln,
    heroVorgabe: heroVorgabe,
    campaignBlock: campaignBlock
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = PromptBuilder;

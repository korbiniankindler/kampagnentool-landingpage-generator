/* Robustes Extrahieren von JSON aus KI-Antworten. Gemeinsam genutzt von
   Modul 1 (Hardfacts) und Modul 2 (Landingpage) - beide bekommen JSON vom
   selben Modell und scheitern an denselben Stellen.

   Zwei Fehlerbilder, die reine JSON.parse nicht ueberlebt:
   1. Nicht escapte Anfuehrungszeichen in Textwerten. Tritt zuverlaessig auf,
      sobald die KI in einem Satz etwas zitiert (z.B. den Kampagnentitel in
      einer Strategie-Begruendung) - dann endet der String zu frueh und der
      Parser meldet "Expected ',' or '}' after property value".
   2. Echte Zeilenumbrueche in Strings.
   Beides wird hier zeichenweise repariert.

   WICHTIG zur Semantik (siehe extractJSONDetailed):
   - Reparatur (Anfuehrungszeichen, Umbrueche, fehlende Kommas) ist unkritisch:
     das JSON war vollstaendig, nur syntaktisch verunglueckt. Das Ergebnis ist
     inhaltlich vollstaendig.
   - SALVAGE ist etwas voellig anderes: die Antwort war ABGESCHNITTEN
     (Token-Limit) und es werden offene Klammern geschlossen. Das Ergebnis ist
     inhaltlich UNVOLLSTAENDIG und darf nie als regulaerer Output gelten.
     Deshalb ist opts.salvage per Default aus, und extractJSONDetailed meldet
     das Flag `salvaged`, damit der Aufrufer solche Ergebnisse in Quarantaene
     stellen kann statt sie still weiterzuverarbeiten. */
/* Die KI schreibt trotz Vorgabe gelegentlich die ZEICHEN \ und n in einen
   Textwert - im JSON steht dann \\n, und nach dem Parsen bleibt die
   Zeichenfolge \n sichtbar mitten im Text stehen ("...zurueck.\n\nUnd dann...").
   Hier werden solche Sequenzen zu echten Umbruechen aufgeloest, damit sie im
   Editor als Absatz und nicht als Zeichenmuell erscheinen. */
function normalizeModelText(value) {
  if (typeof value === 'string') {
    return value.replace(/\\r\\n|\\n|\\r/g, '\n').replace(/\\t/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
  }
  if (Array.isArray(value)) return value.map(normalizeModelText);
  if (value && typeof value === 'object') {
    var out = {};
    Object.keys(value).forEach(function(k) { out[k] = normalizeModelText(value[k]); });
    return out;
  }
  return value;
}

/* Vollstaendige Variante: liefert { data, salvaged, repaired }.
   - salvaged === true  => Antwort war abgeschnitten, Struktur wurde geschlossen.
                           Inhaltlich unvollstaendig, NICHT als Erfolg behandeln.
   - repaired === true  => Syntax wurde repariert, Inhalt ist vollstaendig.
   extractJSON() darunter ist der duenne Wrapper fuer Aufrufer, die nur die
   Daten brauchen. */
function extractJSONDetailed(raw, opts) {
  opts = opts || {};
  var repaired = false;
  var cleaned = String(raw == null ? '' : raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  var start = cleaned.indexOf('{');
  if (start === -1) throw new Error('Kein JSON-Objekt in der Antwort gefunden.');

  // Repariert das JSON zeichenweise: entkommt Zeilenumbrüche innerhalb von
  // Strings und erkennt/entkommt nicht escapte Anführungszeichen innerhalb
  // von Textwerten (z.B. wenn die KI in einem Satz ein Wort in "..." setzt),
  // indem geprüft wird ob nach einem " tatsächlich ein JSON-Trenner folgt.
  var stack = [], inStr = false, escape = false, closed = false;
  var candidate = '';
  for (var i = start; i < cleaned.length; i++) {
    var ch = cleaned[i];
    if (escape) { candidate += ch; escape = false; continue; }
    if (ch === '\\' && inStr) { candidate += ch; escape = true; continue; }
    if (ch === '"') {
      if (inStr) {
        var j = i + 1, sawNewline = false;
        while (j < cleaned.length && /\s/.test(cleaned[j])) { if (cleaned[j] === '\n') sawNewline = true; j++; }
        var next = cleaned[j];
        /* Folgt nach einem Zeilenumbruch direkt ein ", { oder [, dann ist das
           hier das Stringende und lediglich das Trennkomma fehlt (die
           Komma-Reparatur weiter unten ergaenzt es). Ohne diesen Zusatz wuerde
           das Anfuehrungszeichen als inneres Zitat maskiert und der String
           wuerde den Rest der Antwort verschlucken. Ein echtes inneres Zitat
           steht mitten im Satz, also ohne Zeilenumbruch davor. */
        var isTerminator = (next === undefined || next === ',' || next === '}' || next === ']' || next === ':' ||
                            (sawNewline && (next === '"' || next === '{' || next === '[')));
        if (isTerminator) { inStr = false; candidate += ch; }
        else { candidate += '\\"'; repaired = true; }
      } else {
        inStr = true; candidate += ch;
      }
      continue;
    }
    if (inStr) {
      if (ch === '\n') { candidate += '\\n'; repaired = true; continue; }
      if (ch === '\r') { candidate += '\\r'; repaired = true; continue; }
      if (ch === '\t') { candidate += '\\t'; repaired = true; continue; }
      candidate += ch;
      continue;
    }
    candidate += ch;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      stack.pop();
      if (stack.length === 0) { closed = true; break; }
    }
  }

  /* Zweiter Reparaturschritt: fehlende Trennkommas zwischen Properties oder
     Array-Elementen. Passiert bei langen Antworten regelmaessig ("Expected ','
     or '}' after property value" am Anfang der Folgezeile).
     Sicher, weil an dieser Stelle alle Zeilenumbrueche INNERHALB von Strings
     bereits als \n maskiert sind - ein echter Zeilenumbruch im Kandidaten
     liegt also immer ausserhalb eines Strings. Und die Stellen, an denen
     hier ein Komma ergaenzt wird, sind ohne Komma ohnehin ungueltiges JSON.
     Wird nur als Fallback versucht, damit gueltiges JSON unangetastet bleibt. */
  function parseWithCommaRepair(text, onFail) {
    try { return normalizeModelText(JSON.parse(text)); } catch(e) {
      if (e instanceof SyntaxError) {
        var withCommas = text.replace(/(["\}\]\d])(\s*\n\s*)(["\{\[])/g, '$1,$2$3');
        if (withCommas !== text) {
          try {
            var parsed = normalizeModelText(JSON.parse(withCommas));
            repaired = true;
            return parsed;
          } catch(e2) { /* faellt unten durch */ }
        }
      }
      throw onFail(e);
    }
  }

  if (closed) {
    var trimmed = candidate.replace(/,\s*([}\]])/g, '$1');
    if (trimmed !== candidate) repaired = true;
    var data = parseWithCommaRepair(trimmed, function(e) {
      return new Error('JSON-Parse fehlgeschlagen: ' + e.message + '. Bitte erneut versuchen.');
    });
    return { data: data, salvaged: false, repaired: repaired };
  }

  if (!opts.salvage) throw new Error('JSON-Objekt ist unvollständig (Antwort wurde abgeschnitten, evtl. Token-Limit).');

  // Letzter Rettungsversuch: offene Struktur schließen und parsen.
  // Ergebnis ist inhaltlich unvollstaendig -> salvaged: true.
  var salvage = candidate;
  if (inStr) salvage += '"';
  salvage = salvage.replace(/,\s*$/, '');
  /* Haeufigster Abbruchpunkt ueberhaupt: mitten in einem Objekt, direkt nach
     einem Key und seinem Doppelpunkt ("sub":). Dieser Key hat keinen Wert mehr
     und macht das geschlossene Objekt ungueltig - also weg damit. Ohne diesen
     Schritt scheitert Salvage genau dort, wo man es am haeufigsten braucht.
     Die Regex greift nur bei Doppelpunkt am Zeilenende; ein offener String ist
     oben bereits geschlossen worden und endet daher nie auf ":". */
  salvage = salvage.replace(/,?\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, '');
  salvage = salvage.replace(/,\s*$/, '');
  for (var k = stack.length - 1; k >= 0; k--) salvage += (stack[k] === '{' ? '}' : ']');
  salvage = salvage.replace(/,\s*([}\]])/g, '$1');
  var salvagedData = parseWithCommaRepair(salvage, function() {
    return new Error('JSON-Objekt ist unvollständig und konnte nicht gerettet werden (Antwort wurde abgeschnitten).');
  });
  return { data: salvagedData, salvaged: true, repaired: repaired };
}

/* Duenner Wrapper: nur die Daten. Aufrufer, die zwischen sauberem Parse,
   Reparatur und Salvage unterscheiden muessen, nutzen extractJSONDetailed. */
function extractJSON(raw, opts) {
  return extractJSONDetailed(raw, opts).data;
}

/* Node-Export fuer die Tests. Im Browser existiert `module` nicht, dort
   bleiben die Funktionen schlicht global - das Verhalten aendert sich nicht. */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { extractJSON: extractJSON, extractJSONDetailed: extractJSONDetailed, normalizeModelText: normalizeModelText };
}

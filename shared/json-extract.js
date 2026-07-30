/* Robustes Extrahieren von JSON aus KI-Antworten. Gemeinsam genutzt von
   Modul 1 (Hardfacts) und Modul 2 (Landingpage) - beide bekommen JSON vom
   selben Modell und scheitern an denselben Stellen.

   Zwei Fehlerbilder, die reine JSON.parse nicht ueberlebt:
   1. Nicht escapte Anfuehrungszeichen in Textwerten. Tritt zuverlaessig auf,
      sobald die KI in einem Satz etwas zitiert (z.B. den Kampagnentitel in
      einer Strategie-Begruendung) - dann endet der String zu frueh und der
      Parser meldet "Expected ',' or '}' after property value".
   2. Echte Zeilenumbrueche in Strings.
   Beides wird hier zeichenweise repariert. opts.salvage schliesst zusaetzlich
   abgeschnittene Strukturen (Token-Limit) statt hart zu scheitern - per
   Default aus, damit echte Trunkierungen einen Retry ausloesen koennen. */
function extractJSON(raw, opts) {
  opts = opts || {};
  var cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
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
        else { candidate += '\\"'; }
      } else {
        inStr = true; candidate += ch;
      }
      continue;
    }
    if (inStr) {
      if (ch === '\n') { candidate += '\\n'; continue; }
      if (ch === '\r') { candidate += '\\r'; continue; }
      if (ch === '\t') { candidate += '\\t'; continue; }
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
    try { return JSON.parse(text); } catch(e) {
      var repaired = text.replace(/(["\}\]\d])(\s*\n\s*)(["\{\[])/g, '$1,$2$3');
      if (repaired !== text) {
        try { return JSON.parse(repaired); } catch(e2) { /* faellt unten durch */ }
      }
      throw onFail(e);
    }
  }

  if (closed) {
    candidate = candidate.replace(/,\s*([}\]])/g, '$1');
    return parseWithCommaRepair(candidate, function(e) {
      return new Error('JSON-Parse fehlgeschlagen: ' + e.message + '. Bitte erneut versuchen.');
    });
  }

  if (!opts.salvage) throw new Error('JSON-Objekt ist unvollständig (Antwort wurde abgeschnitten, evtl. Token-Limit).');

  // Letzter Rettungsversuch: offene Struktur schließen und parsen
  var salvage = candidate;
  if (inStr) salvage += '"';
  salvage = salvage.replace(/,\s*$/, '');
  for (var k = stack.length - 1; k >= 0; k--) salvage += (stack[k] === '{' ? '}' : ']');
  salvage = salvage.replace(/,\s*([}\]])/g, '$1');
  return parseWithCommaRepair(salvage, function() {
    return new Error('JSON-Objekt ist unvollständig und konnte nicht gerettet werden (Antwort wurde abgeschnitten).');
  });
}

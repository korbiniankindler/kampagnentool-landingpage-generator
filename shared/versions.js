/* Einzige Quelle fuer alles, was einen Lauf reproduzierbar macht.
   Wird von beiden Modulen in den Session-/Hardfacts-Export geschrieben.

   PROMPT_VERSION bei JEDER inhaltlichen Aenderung an einem Prompt hochzaehlen.
   Ohne sie ist keine Aussage aus einem Eval- oder Benchmark-Lauf belastbar:
   man weiss sonst nicht, gegen welche Prompt-Fassung gemessen wurde. */
var ToolVersions = (function () {
  'use strict';

  return {
    /* App-Version (Anzeige im Header der Module) */
    APP_VERSION: '0.9',

    /* Format der Hardfacts-/Session-Daten. 1 = Stand vor Phase 0.
       Ab Phase 0 wird 1 weiterhin GELESEN (siehe migrateHardfacts), aber
       nicht mehr geschrieben. */
    SCHEMA_VERSION: 2,

    /* Hochzaehlen bei jeder inhaltlichen Prompt-Aenderung. */
    PROMPT_VERSION: 2,

    /* Modell fuer alle Calls beider Module. An genau einer Stelle. */
    MODEL: 'claude-sonnet-5',

    /* Stempel fuer Exporte. presetRef wird vom Aufrufer nachgereicht, weil
       nur er weiss, welche Referenz-Copy die Heuristik gewaehlt hat. */
    stamp: function (extra) {
      var out = {
        schemaVersion: this.SCHEMA_VERSION,
        promptVersion: this.PROMPT_VERSION,
        model: this.MODEL,
        appVersion: this.APP_VERSION,
        erzeugtAm: new Date().toISOString()
      };
      if (extra) Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
      return out;
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = ToolVersions;

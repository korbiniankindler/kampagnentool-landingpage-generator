#!/usr/bin/env bash
# Klaert die offenen Proxy-Fragen aus Phase 0.3 (siehe docs/proxy-capabilities.md).
#
# Ausfuehren auf einem Rechner, der claude.korbinian.workers.dev erreicht -
# also lokal, nicht in der Claude-Code-Umgebung (deren Egress-Policy die
# Domain blockiert).
#
#   bash docs/check-proxy.sh            # P1-P4, Kosten praktisch null
#   bash docs/check-proxy.sh --with-p5  # zusaetzlich der lange Request (~0,30 EUR)
#
# Es wird KEIN API-Key gebraucht - der Worker haelt ihn.
# Die Ausgabe ist bewusst kompakt: einmal komplett kopieren und zurueckgeben.

set -uo pipefail
PROXY="${PROXY_URL:-https://claude.korbinian.workers.dev/}"
MODEL="claude-sonnet-5"
WITH_P5=0
[[ "${1:-}" == "--with-p5" ]] && WITH_P5=1

hr() { printf '%*s\n' 72 '' | tr ' ' '-'; }
post() { curl -sS -X POST "$PROXY" -H 'Content-Type: application/json' -d "$1" --max-time "${2:-60}"; }

echo "Proxy-Check gegen $PROXY"
echo "Datum: $(date -u +%FT%TZ)"
hr

# ---------------------------------------------------------------- P1 + P2
# Wird output_config im Body durchgereicht? Wenn der Worker unbekannte Felder
# filtert oder die API sie ablehnt, sind Structured Outputs und effort nicht
# machbar.
echo "P1/P2: output_config (Structured Outputs + effort)"
for VARIANT in \
  '"output_config":{"effort":"low"}' \
  '"output_config":{"format":{"type":"json_schema","schema":{"type":"object","properties":{"ok":{"type":"boolean"}},"required":["ok"],"additionalProperties":false}}}'
do
  RESP=$(post "{\"model\":\"$MODEL\",\"max_tokens\":64,$VARIANT,\"messages\":[{\"role\":\"user\",\"content\":\"Antworte minimal.\"}]}" 40)
  echo "  Variante: ${VARIANT:0:40}..."
  echo "  Antwort : $(echo "$RESP" | head -c 300 | tr '\n' ' ')"
  echo
done
hr

# ---------------------------------------------------------------- P3 + P4
# Absichtlich ungueltiger Request: erzeugt keine Output-Tokens, zeigt aber
# Fehlerformat (JSON oder HTML?) und die durchgereichten Header.
echo "P3/P4: Fehlerformat und Header (ungueltiger Request, kostet nichts)"
curl -sS -D /tmp/_pxhdr.txt -o /tmp/_pxbody.txt -X POST "$PROXY" \
  -H 'Content-Type: application/json' \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":99999999,\"messages\":[{\"role\":\"user\",\"content\":\"x\"}]}" \
  --max-time 30 -w '  HTTP %{http_code}\n' 2>&1 | tail -2
echo "  --- relevante Header ---"
grep -iE '^(HTTP/|retry-after|request-id|x-request-id|anthropic-|content-type|cf-)' /tmp/_pxhdr.txt 2>/dev/null | sed 's/^/  /' || echo "  (keine)"
echo "  --- Body, erste 300 Zeichen ---"
head -c 300 /tmp/_pxbody.txt 2>/dev/null | sed 's/^/  /'
echo; echo
echo "  Ist der Body JSON?"
if head -c 1 /tmp/_pxbody.txt 2>/dev/null | grep -q '{'; then echo "  ja"; else echo "  NEIN - vermutlich HTML/Klartext"; fi
hr

# ---------------------------------------------------------------- P5
# Traegt der Worker einen langen ungestreamten Request? Entscheidet, ob eine
# Landingpage in EINEM Call generiert werden kann.
if [[ $WITH_P5 -eq 1 ]]; then
  echo "P5: langer ungestreamter Request (max_tokens 30000, ~0,30 EUR)"
  curl -sS -X POST "$PROXY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL\",\"max_tokens\":30000,\"messages\":[{\"role\":\"user\",\"content\":\"Schreibe einen zusammenhaengenden deutschen Fachtext von etwa 12000 Woertern ueber Ablauf- und Kapazitaetsplanung in Agenturen. Keine Listen, durchgehender Fliesstext.\"}]}" \
    -o /tmp/_pxlong.json --max-time 600 \
    -w '  HTTP %{http_code} | %{size_download} Bytes | %{time_total}s\n' 2>&1 | tail -2
  echo "  stop_reason: $(grep -o '"stop_reason":"[^"]*"' /tmp/_pxlong.json 2>/dev/null | head -1)"
  echo "  usage      : $(grep -o '"usage":{[^}]*}' /tmp/_pxlong.json 2>/dev/null | head -c 200)"
else
  echo "P5: uebersprungen (mit --with-p5 aktivieren)"
fi
hr
echo "Fertig. Bitte die komplette Ausgabe zurueckgeben."

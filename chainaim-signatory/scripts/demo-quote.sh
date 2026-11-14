#!/usr/bin/env bash
# Quote flow (S-3) judge wrapper: checks node and OutcomeAI, then runs every RFQ (or the flags you pass).
#   QUOTE_TOKEN_JUPITER=<tenant token> bash scripts/demo-quote.sh                 # T01–T08, officer+CEO approve
#   bash scripts/demo-quote.sh --inquiry T07 --approve ask --pace-ms 600         # one RFQ, live prompts
# Every flag is passed to scripts/demo-quote.mjs (see --help). Run from anywhere.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
URL="http://127.0.0.1:8785"
prev=""
for a in "$@"; do
  case "$a" in --outcome-url=*) URL="${a#*=}" ;; esac
  [ "$prev" = "--outcome-url" ] && URL="$a"
  prev="$a"
done
command -v node >/dev/null || { echo "node 22+ is required" >&2; exit 2; }
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)' || { echo "node 22+ is required (found $(node -v))" >&2; exit 2; }
if ! node -e "fetch('$URL/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
  echo "OutcomeAI is not answering at $URL/healthz — start its quote-agents service first (or pass --outcome-url)." >&2
  exit 2
fi
[ -n "${QUOTE_TOKEN_JUPITER:-}" ] || echo "note: QUOTE_TOKEN_JUPITER is not set (unless you pass --token-env, the run will stop)." >&2
cd "$ROOT"
exec node scripts/demo-quote.mjs "$@"

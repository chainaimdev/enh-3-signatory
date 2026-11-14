#!/usr/bin/env bash
# Quote test rig wrapper (Linux/macOS/Git Bash): checks node and OutcomeAI, then runs the 10 rig scenarios (S01-S10).
#   export QUOTE_TOKEN_JUPITER=...   (never paste it into a chat or a log)
#   ./scripts/quote-rig.sh                       ./scripts/quote-rig.sh --scenario S06 --bodies
# Every argument is passed to scripts/quote-rig.mjs (see --help).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
url="http://127.0.0.1:8785"
args=("$@")
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[$i]}" in
    --outcome-url) url="${args[$((i + 1))]:-$url}" ;;
    --outcome-url=*) url="${args[$i]#--outcome-url=}" ;;
  esac
done
command -v node >/dev/null || { echo "node 22+ is required" >&2; exit 2; }
major="$(node -v | sed 's/^v//; s/\..*//')"
[ "$major" -ge 22 ] || { echo "node 22+ is required (found $(node -v))" >&2; exit 2; }
curl -fsS -m 5 "$url/healthz" >/dev/null || { echo "OutcomeAI is not answering at $url/healthz - start its quote-agents service first (or pass --outcome-url)." >&2; exit 2; }
[ -n "${QUOTE_TOKEN_JUPITER:-}" ] || echo "warning: QUOTE_TOKEN_JUPITER is not set (unless you pass --token-env, the run will stop)." >&2
cd "$root" && exec node scripts/quote-rig.mjs "$@"

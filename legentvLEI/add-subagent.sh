#!/usr/bin/env bash
# add-subagent.sh — add ONE new sub-agent to the existing 4D org on this PC.
# No 4D re-run, no fresh stack: every existing identity, BRAN and credential stays untouched.  (2026-11-14, change #14)
#
#   ./add-subagent.sh <SUB_ALIAS> <PARENT_AGENT> [--config ./appconfig/generated/config-4d.json] [--dry-run]
#   e.g. ./add-subagent.sh JupiterLogisticsAgent jupiterSellerAgent
#
# Runs exactly the per-sub-agent steps of run-all-buyerseller-4D-with-subdelegation.sh (Phase 3) for one alias:
#   1 checks: the config lists SUB under PARENT's subAgents and in PARENT's may_act; tsx_shell is running;
#     the parent's info + BRAN files exist; SUB does not exist yet (task-data/<SUB>-info.json absent)
#   2 BRAN: task-data/<SUB>-bran.txt is created only if missing (openssl, 256-bit, mode 600, never printed).
#     Unlike generate-subagent-brans.sh it never rewrites the other sub-agents' BRANs.
#   3 task-scripts/subagent/subagent-delegate-with-unique-bran.sh SUB PARENT (delegated inception + parent KEL seal)
#   4 OOBI resolves (QVI, LE, verifier)   5 Sally verification (non-fatal, as in 4D)
# Afterwards: re-export the evidence (strict) so the UI / runner see the new agent (printed at the end).
set -u
cd "$(dirname "$0")"
export MSYS_NO_PATHCONV=1
export PATH="$HOME/bin:$PATH"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
SUB="${1:-}"; PARENT="${2:-}"; shift 2 2>/dev/null || true
CONFIG="./appconfig/generated/config-4d.json"; DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --config) shift; CONFIG="${1:-}" ;;
    --dry-run) DRY=1 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 64 ;;
  esac
  shift
done
[ -n "$SUB" ] && [ -n "$PARENT" ] || { sed -n '2,16p' "$0"; exit 64; }
die() { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }
ok() { echo -e "${GREEN}✓ $*${NC}"; }
run() { if [ "$DRY" = 1 ]; then echo "  (dry-run) $*"; else "$@"; fi; }

echo -e "${CYAN}══ add-subagent: $SUB under $PARENT ══${NC}"
for t in jq openssl docker; do command -v "$t" >/dev/null || die "$t not on PATH"; done
[ -f "$CONFIG" ] || die "config not found: $CONFIG"

# 1. checks
LOC=$(jq -c --arg p "$PARENT" --arg s "$SUB" '
  [ .organizations | to_entries[] | .key as $o | .value as $org | $org.persons[]?.agents[]?
    | select(.alias == $p)
    | { org: $org.alias, listed: ([.subAgents[]?.alias] | index($s) != null), mayAct: ((.may_act // null) | if . == null then true else index($s) != null end) } ] | first // empty' "$CONFIG")
[ -n "$LOC" ] || die "$PARENT is not an agent in $CONFIG"
[ "$(echo "$LOC" | jq -r .listed)" = "true" ] || die "$SUB is not in $PARENT.subAgents of $CONFIG (edit appconfig/org/companies/*.json and run build-org-config.js)"
[ "$(echo "$LOC" | jq -r .mayAct)" = "true" ] || die "$SUB is not in $PARENT.may_act of $CONFIG"
LE_ALIAS=$(echo "$LOC" | jq -r .org)
ok "config: $SUB is a sub-agent of $PARENT ($LE_ALIAS)"
[ -f "./task-data/${PARENT}-info.json" ] || die "parent $PARENT not created on this PC (task-data/${PARENT}-info.json missing) — run 4D first"
[ -f "./task-data/${PARENT}-bran.txt" ] || die "parent BRAN file missing: task-data/${PARENT}-bran.txt"
if [ -f "./task-data/${SUB}-info.json" ]; then die "$SUB already exists (task-data/${SUB}-info.json) — nothing to do"; fi
docker ps --format '{{.Names}}' | grep -qx tsx_shell || die "tsx_shell is not running — start the vLEI stack first (signatory.sh start --vlei, or ./start-vlei.sh)"
ok "parent exists, $SUB is new, tsx_shell running"

# 2. BRAN (only this sub-agent; only if missing)
BRAN_FILE="./task-data/${SUB}-bran.txt"
if [ -f "$BRAN_FILE" ]; then ok "BRAN file already present (kept)"
elif [ "$DRY" = 1 ]; then echo "  (dry-run) create $BRAN_FILE (256-bit, mode 600)"
else (umask 077; openssl rand -base64 32 | tr -d '\r\n' > "$BRAN_FILE"; echo >> "$BRAN_FILE"); ok "BRAN created: $BRAN_FILE (hidden)"; fi

# 3. delegation (same script as 4D)
chmod +x ./task-scripts/subagent/*.sh 2>/dev/null || true
run ./task-scripts/subagent/subagent-delegate-with-unique-bran.sh "$SUB" "$PARENT" || die "sub-agent delegation failed"
[ "$DRY" = 1 ] || { [ -f "./task-data/${SUB}-info.json" ] && ok "$SUB AID $(jq -r .aid "./task-data/${SUB}-info.json")" || die "delegation ran but task-data/${SUB}-info.json is missing"; }

# 4. OOBIs
run ./task-scripts/subagent/subagent-oobi-resolve-qvi.sh "$SUB" || echo -e "${YELLOW}⚠ OOBI resolve (QVI) returned an error (4D treats it as non-fatal too)${NC}"
run ./task-scripts/subagent/subagent-oobi-resolve-le.sh "$SUB" "$LE_ALIAS" || echo -e "${YELLOW}⚠ OOBI resolve (LE) returned an error (4D treats it as non-fatal too)${NC}"
run ./task-scripts/subagent/subagent-oobi-resolve-verifier.sh "$SUB" || echo -e "${YELLOW}⚠ OOBI resolve (verifier) returned an error (4D treats it as non-fatal too)${NC}"
ok "OOBI resolve steps done"

# 5. Sally (non-fatal, same as 4D)
if run ./task-scripts/subagent/subagent-verify-delegation.sh "$SUB" "$PARENT"; then ok "sub-delegation verified by Sally"
else echo -e "${YELLOW}⚠ Sally could not confirm the sub-delegation (non-fatal, as in 4D); the strict export re-checks the KEL${NC}"; fi

echo
ok "$SUB added. Next: re-export the evidence so the UI and runner see it:"
echo "   \"/mnt/c/Program Files/nodejs/node.exe\" export-signatory-evidence.js --strict --out ../UI/data/signatory-evidence.json"
echo "   tree check:  node ./print-org-trust-tree.js --config $CONFIG --task-data ./task-data --strict"

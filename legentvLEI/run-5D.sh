#!/usr/bin/env bash
# run-5D.sh — ONE command for the full Signatory vLEI org on a FRESH stack.  (2026-11-14)
#   4 OOR officers · 4 agents · 4 sub-agents (JupiterTreasury, JupiterInventory, JupiterLogistics, TommyTreasury)
#
#   ./run-5D.sh [--yes] [--dry-run] [--export-node <node>] [--seller jupiter] [--buyer tommy]
#
# "5D" = the 4D script (4C base + sub-delegation) driven by the org built from the company files. Steps:
#   1 build-org-config.js : appconfig/org/companies/*.json → appconfig/generated/config-4c.json + config-4d.json (validated)
#   2 FRESH stack         : stop.sh --fresh · setup.sh · deploy.sh --fresh · saidify-and-restart.sh
#   3 4D                  : --config-4c/--config-4d (generated) --force-base --invoice-config invoiceConfig-near.json
#   4 invoice issuance proof (jupiterSellerAgent)
#   5 strict evidence export → ../UI/data/signatory-evidence.json
#   6 trust-tree check (strict): every person/agent in the config exists in task-data
# DESTRUCTIVE: deletes the vLEI identities, credentials and passcodes on THIS PC (asks you to type FRESH unless --yes).
# Takes about 25 min. To add ONE agent to an existing org instead, use ./add-subagent.sh.
set -u
cd "$(dirname "$0")"
DIR="$(pwd -P)"
export MSYS_NO_PATHCONV=1
export PATH="$HOME/bin:$PATH"
RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
YES=0; DRY=0; SELLER="jupiter"; BUYER="tommy"; EXPORT_NODE="/mnt/c/Program Files/nodejs/node.exe"
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) YES=1 ;;
    --dry-run) DRY=1 ;;
    --export-node) shift; EXPORT_NODE="${1:-}" ;;
    --seller) shift; SELLER="${1:-}" ;;
    --buyer) shift; BUYER="${1:-}" ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 64 ;;
  esac
  shift
done
hdr() { echo -e "\n${CYAN}== $*${NC}"; }
die() { echo -e "${RED}✗ $*${NC}" >&2; exit 1; }
ok() { echo -e "${GREEN}✓ $*${NC}"; }
run() { if [ "$DRY" = 1 ]; then echo "  (dry-run) $*"; else "$@"; fi; }
again() { cd / && cd "$DIR" || die "cannot re-enter $DIR"; }   # Docker/WSL restarts can leave a stale cwd

for t in node jq openssl docker; do [ "$DRY" = 1 ] && [ "$t" = docker ] && continue; command -v "$t" >/dev/null || die "$t not on PATH"; done
[ "$DRY" = 1 ] || docker ps >/dev/null 2>&1 || die "docker not reachable — start Docker Desktop (WSL integration on)"

hdr "1/6 org config from the company files ($SELLER, $BUYER)"
run node build-org-config.js --org-dir ./appconfig/org --seller "$SELLER" --buyer "$BUYER" --out-dir ./appconfig/generated || die "org config invalid — fix appconfig/org/companies/*.json"

if [ "$YES" != 1 ] && [ "$DRY" != 1 ]; then
  echo "  This deletes the vLEI identities, credentials and passcodes on THIS PC and creates new ones (≈ 25 min)."
  read -r -p "  Type FRESH to continue: " ans
  [ "$ans" = "FRESH" ] || { echo "  cancelled"; exit 1; }
fi
if [ ! -f ./.env ]; then
  run sh -c "printf 'UID=%s\nGID=%s\n' \"\$(id -u)\" \"\$(id -g)\" > ./.env" && ok "created .env (UID/GID only)"
fi

hdr "2/6 fresh vLEI stack"
run ./stop.sh --fresh && again && run ./setup.sh && run ./deploy.sh --fresh && again && run ./saidify-and-restart.sh || die "stack setup failed"
again

hdr "3/6 4D: officers, agents, sub-agents, NEAR invoice"
run ./run-all-buyerseller-4D-with-subdelegation.sh --config-4c ./appconfig/generated/config-4c.json \
  --config-4d ./appconfig/generated/config-4d.json --force-base --invoice-config ./appconfig/invoiceConfig-near.json || die "4D failed"
again

hdr "4/6 invoice issuance proof"
run ./task-scripts/invoice/invoice-export-issuance.sh jupiterSellerAgent || die "issuance proof failed"
again

hdr "5/6 strict evidence export → ../UI/data/signatory-evidence.json"
exnode="node"; [ -x "$EXPORT_NODE" ] && exnode="$EXPORT_NODE"
run "$exnode" export-signatory-evidence.js --strict --out ../UI/data/signatory-evidence.json || die "export failed (strict checks)"

hdr "6/6 trust tree (strict)"
run node ./print-org-trust-tree.js --config ./appconfig/generated/config-4d.json --task-data ./task-data --strict || die "trust tree check failed"

echo; ok "5D complete: the full org is on this PC. Next: bash ../chainaim-signatory/scripts/signatory.sh start"

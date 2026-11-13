#!/usr/bin/env bash
# S-3 set-mandates — MANUAL run by the owner in WSL Ubuntu, after deploy.
#   bash scripts/set-mandates.sh [--dry-run] [--only <alias>]
# For each mandate in config/accounts.json: set_mandate (signed by the owner via the near CLI legacy
# keychain), then verify with get_mandate. Finally copies config/accounts.json to the UI
# (../UI/data/accounts.json; it holds no keys). set_mandate replaces a mandate and clears `revoked`
# (S-2a #5), so this script is also the demo reset for mandates.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

DRY=0; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --only) ONLY="${2:?--only needs an alias}"; shift ;;
    *) echo "unknown flag $1" >&2; exit 64 ;;
  esac
  shift
done

plan() { node "$ROOT/scripts/lib/plan.mjs" "$@"; }
CONTRACT="$(plan get contractId)"
NETWORK="$(plan get network)"
OWNER="$(plan get owner)"
CRED="$HOME/.near-credentials/$NETWORK/$OWNER.json"

STATE="$(plan contract-state)"
if [ "$STATE" != initialized ]; then echo "FAIL: contract $CONTRACT is '$STATE' — run scripts/deploy.sh first" >&2; exit 1; fi
if [ "$DRY" = 0 ] && [ ! -f "$CRED" ]; then
  echo "FAIL: no legacy-keychain key file for owner $OWNER under ~/.near-credentials/$NETWORK/" >&2; exit 1
fi
command -v near >/dev/null || { echo "FAIL: near CLI not on PATH" >&2; exit 1; }

FAILED=0
while IFS=$'\t' read -r ALIAS ACCOUNT ARGS; do
  [ -n "$ONLY" ] && [ "$ALIAS" != "$ONLY" ] && continue
  echo "== $ALIAS → $ACCOUNT"
  CMD=(near contract call-function as-transaction "$CONTRACT" set_mandate json-args "$ARGS"
       prepaid-gas '30.0 Tgas' attached-deposit '0 NEAR'
       sign-as "$OWNER" network-config "$NETWORK" sign-with-legacy-keychain send)
  printf ' %q' "${CMD[@]}"; echo
  if [ "$DRY" = 1 ]; then echo "(dry-run) nothing sent"; continue; fi
  "${CMD[@]}"
  GOT="$(plan view get_mandate "{\"account\":\"$ACCOUNT\"}")"
  if node -e '
    const got = JSON.parse(process.argv[1]); const want = JSON.parse(process.argv[2]);
    const ok = got && got.company === want.company && got.role === want.role &&
      got.limit_units === want.limit_units && got.approver === want.approver && got.revoked === false;
    console.log((ok ? "PASS " : "FAIL ") + JSON.stringify(got)); process.exit(ok ? 0 : 1);
  ' "$GOT" "$ARGS"; then :; else FAILED=1; fi
done < <(plan mandates)

if [ "$DRY" = 0 ]; then
  UI_ACCOUNTS="$(plan get uiAccounts)"
  cp "$(plan get accounts)" "$UI_ACCOUNTS"
  echo "copied accounts.json → $UI_ACCOUNTS"
fi
[ "$FAILED" = 0 ] || { echo "FAIL: at least one mandate does not match accounts.json" >&2; exit 1; }
echo "next: node scripts/health.mjs"

#!/usr/bin/env bash
# S-3 deploy — MANUAL run by the owner in WSL Ubuntu (keys stay in ~/.near-credentials).
#   bash scripts/deploy.sh [--dry-run] [--skip-build] [--redeploy]
# Steps: build wasm → check the contract account → deploy + new(owner, registrar, token) → verify get_config.
#   --dry-run    print what would run, send nothing
#   --skip-build use the existing wasm
#   --redeploy   contract already initialized: deploy new code WITHOUT calling new (state kept)
# The script never reads or prints a key: it only checks that the legacy-keychain file exists.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"

DRY=0; BUILD=1; REDEPLOY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --skip-build) BUILD=0 ;;
    --redeploy) REDEPLOY=1 ;;
    *) echo "unknown flag $a" >&2; exit 64 ;;
  esac
done

plan() { node "$ROOT/scripts/lib/plan.mjs" "$@"; }
CONTRACT="$(plan get contractId)"
NETWORK="$(plan get network)"
WASM="$(plan get wasm)"
INIT_ARGS="$(plan init-args)"
CRED="$HOME/.near-credentials/$NETWORK/$CONTRACT.json"

echo "contract : $CONTRACT ($NETWORK)"
echo "init args: $INIT_ARGS"

for tool in node near cargo; do
  command -v "$tool" >/dev/null || { echo "FAIL: $tool not on PATH (run inside WSL Ubuntu)" >&2; exit 1; }
done

# 1. build
if [ "$BUILD" = 1 ]; then
  echo "== build: cargo near build non-reproducible-wasm"
  if [ "$DRY" = 1 ]; then echo "(dry-run) skip build"; else
    (cd contract && cargo near build non-reproducible-wasm)
  fi
fi
if [ "$DRY" = 0 ] && [ ! -f "$WASM" ]; then echo "FAIL: wasm not found at $WASM" >&2; exit 1; fi
[ -f "$WASM" ] && echo "wasm     : $WASM ($(stat -c %s "$WASM") bytes, sha256 $(sha256sum "$WASM" | cut -d' ' -f1))"

# 2. account + state
STATE="$(plan contract-state)"
echo "state    : $STATE"
case "$STATE" in
  none) echo "FAIL: $CONTRACT does not exist on $NETWORK — create it first (S-1)" >&2; exit 1 ;;
  initialized)
    if [ "$REDEPLOY" = 0 ]; then
      echo "FAIL: contract already initialized. Use --redeploy to update code without new()." >&2
      echo "      (state layout changes need a new account; see doc S-2b)" >&2
      exit 1
    fi ;;
  no-code|uninitialized)
    if [ "$REDEPLOY" = 1 ]; then echo "FAIL: --redeploy given but contract is $STATE" >&2; exit 1; fi ;;
esac
if [ ! -f "$CRED" ]; then
  echo "FAIL: no legacy-keychain key file for $CONTRACT under ~/.near-credentials/$NETWORK/ (S-1)" >&2
  exit 1
fi

# 3. deploy
if [ "$REDEPLOY" = 1 ]; then
  CMD=(near contract deploy "$CONTRACT" use-file "$WASM" without-init-call
       network-config "$NETWORK" sign-with-legacy-keychain send)
else
  CMD=(near contract deploy "$CONTRACT" use-file "$WASM" with-init-call new json-args "$INIT_ARGS"
       prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR'
       network-config "$NETWORK" sign-with-legacy-keychain send)
fi
echo "== deploy:"; printf ' %q' "${CMD[@]}"; echo
if [ "$DRY" = 1 ]; then echo "(dry-run) nothing sent"; exit 0; fi
"${CMD[@]}"

# 4. verify
echo "== verify get_config"
CFG="$(plan view get_config)"
echo "$CFG"
node -e '
const c = JSON.parse(process.argv[1]); const want = JSON.parse(process.argv[2]);
const bad = ["owner","registrar","token"].filter(k => c[k] !== want[k]);
if (bad.length) { console.error("FAIL: get_config differs from config in " + bad.join(", ")); process.exit(1); }
console.log("PASS: contract initialized with the configured owner, registrar and token");
' "$CFG" "$INIT_ARGS"
echo "next: bash scripts/set-mandates.sh"

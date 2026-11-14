#!/usr/bin/env bash
# signatory.sh — one command for Signatory: first-time setup, daily start, stop.  (2026-11-14)
#
#   bash scripts/signatory.sh setup [--fresh-vlei [--yes]] [--skip-npm] [--export-node <path>] [--dry-run]
#   bash scripts/signatory.sh start [--ap2 on|off] [--vlei] [--no-ui] [--background] [--dry-run]
#                                   (default: runs in THIS terminal — Ctrl+C or closing the window stops all services;
#                                    --background = old behaviour, services keep running until `stop`)
#                                   [--pace-ms 1500 (pause per negotiation move; 0 = instant)]
#                                   [--vlei-verifier required|off (live check via vlei_verification :9724; default required)]
#                                   [--sally required|off (officer presents its OOR to Sally; signed result must be "iss")]
#                                   [--negotiator rules|llm --llm-url <url> [--llm-model <name>]]   (change #4;
#                                   [--quote-inquiries data/quote/rig-scenarios.json] [--outcome-url http://127.0.0.1:8785]
#                                   [--quote-buyer rules|outcome]  (outcome: Tommy answers via his OutcomeAI tenant; export
#                                    QUOTE_TOKEN_TOMMY too)
#                                   (quote mode: which RFQs the console lists, and OutcomeAI quote-agents; export
#                                    QUOTE_TOKEN_JUPITER in this shell first — never on the command line)
#                                   llm reads the key from env SIGNATORY_LLM_API_KEY — never put the key on the command line)
#   bash scripts/signatory.sh stop  [--vlei] [--dry-run]
#
# Runs from any folder (it finds its own). Run it in WSL Ubuntu: the signer and bridge read NEAR keys from
# ~/.near-credentials there. It never reads, prints or copies a key or a passcode: it only checks that files exist.
#
# setup  (first time on a PC)
#   1. tools: node >= 22, npm, jq, curl (+ docker with --fresh-vlei)
#   2. --fresh-vlei: DESTRUCTIVE fresh vLEI stack + full org (≈ 25 min) via legentvLEI/run-5D.sh: build-org-config.js, stop.sh --fresh, setup.sh,
#      deploy.sh --fresh, saidify-and-restart.sh, run-all-buyerseller-4D-with-subdelegation.sh with the full Signatory
#      org (appconfig/generated/config-4c.json + config-4d.json, --force-base), the invoice issuance proof
#      (task-scripts/invoice/invoice-export-issuance.sh), then the strict evidence export. It wipes the identities on THIS PC, so it asks you to type FRESH (or pass --yes).
#      Without --fresh-vlei the vLEI stack is left as it is.
#   3. npm install in services/ (skip with --skip-npm)
#   4. checks, read-only: NEAR key files present (names only), AP2 key files present, evidence file present,
#      `node scripts/health.mjs --stage contract` (accounts, storage, contract, mandates). Prints a numbered
#      list of what is still missing — creating accounts, the faucet and key hand-over are done by a person.
# start  (every day)
#   stops old copies → [--vlei: legentvLEI/start-vlei.sh, same identities, no 4D] → signer, bridge, runner in the
#   background (with --ap2 on by default) → waits for each /health → `health.mjs --stage all --write-ui-config`
#   (points the UI at the configured contract) → UI server → prints the link, a summary and the log paths.
# stop
#   stops the UI and the three services (pid files, then by command line). --vlei also runs legentvLEI/stop.sh
#   (preserve mode: identities kept).
#
# Logs and pid files: chainaim-signatory/private/run/ (git-ignored).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # chainaim-signatory/
REPO="$(cd "$ROOT/.." && pwd)"                             # enh-3-signatory/
SERVICES="$ROOT/services"
VLEI="$REPO/legentvLEI"
UI_DIR="$REPO/UI"
RUN_DIR="$ROOT/private/run"
CONFIG="$ROOT/config/signatory.json"

MODE="${1:-}"; shift || true
DRY=0; AP2="on"; WITH_VLEI=0; NO_UI=0; FRESH_VLEI=0; YES=0; SKIP_NPM=0
NEGOTIATOR="rules"; LLM_URL=""; LLM_MODEL=""; QUOTE_INQUIRIES=""; OUTCOME_URL=""; QUOTE_BUYER=""; BACKGROUND=0; PACE_MS=1500; VLEI_VERIFIER="required"; SALLY="required"
EXPORT_NODE="/mnt/c/Program Files/nodejs/node.exe"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --ap2) shift; AP2="${1:-}" ;;
    --vlei) WITH_VLEI=1 ;;
    --no-ui) NO_UI=1 ;;
    --fresh-vlei) FRESH_VLEI=1 ;;
    --yes) YES=1 ;;
    --skip-npm) SKIP_NPM=1 ;;
    --export-node) shift; EXPORT_NODE="${1:-}" ;;
    --negotiator) shift; NEGOTIATOR="${1:-}" ;;
    --background) BACKGROUND=1 ;;
    --pace-ms) shift; PACE_MS="${1:-}" ;;
    --vlei-verifier) shift; VLEI_VERIFIER="${1:-}" ;;
    --sally) shift; SALLY="${1:-}" ;;
    --llm-url) shift; LLM_URL="${1:-}" ;;
    --llm-model) shift; LLM_MODEL="${1:-}" ;;
    --quote-inquiries) shift; QUOTE_INQUIRIES="${1:-}" ;;
    --outcome-url) shift; OUTCOME_URL="${1:-}" ;;
    --quote-buyer) shift; QUOTE_BUYER="${1:-}" ;;
    -h|--help) sed -n '2,35p' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (see --help)" >&2; exit 64 ;;
  esac
  shift
done
case "$AP2" in on|off) ;; *) echo "--ap2 must be on or off" >&2; exit 64 ;; esac
case "$NEGOTIATOR" in rules|llm) ;; *) echo "--negotiator must be rules or llm" >&2; exit 64 ;; esac
case "$PACE_MS" in ""|*[!0-9]*) echo "--pace-ms must be a whole number of milliseconds" >&2; exit 64 ;; esac
case "$VLEI_VERIFIER" in required|off) ;; *) echo "--vlei-verifier must be required or off" >&2; exit 64 ;; esac
case "$SALLY" in required|off) ;; *) echo "--sally must be required or off" >&2; exit 64 ;; esac
RUNNER_EXTRA=(--negotiator "$NEGOTIATOR" --pace-ms "$PACE_MS" --vlei-verifier "$VLEI_VERIFIER" --sally "$SALLY")
[ -n "$LLM_URL" ] && RUNNER_EXTRA+=(--llm-url "$LLM_URL")
[ -n "$LLM_MODEL" ] && RUNNER_EXTRA+=(--llm-model "$LLM_MODEL")
# quote mode: a relative --quote-inquiries is taken from chainaim-signatory/ (the runner itself starts in services/)
if [ -n "$QUOTE_INQUIRIES" ]; then
  case "$QUOTE_INQUIRIES" in /*) ;; *) QUOTE_INQUIRIES="$ROOT/$QUOTE_INQUIRIES" ;; esac
  [ -f "$QUOTE_INQUIRIES" ] || { echo "--quote-inquiries: no file $QUOTE_INQUIRIES" >&2; exit 64; }
  RUNNER_EXTRA+=(--quote-inquiries "$QUOTE_INQUIRIES")
fi
[ -n "$OUTCOME_URL" ] && RUNNER_EXTRA+=(--outcome-url "$OUTCOME_URL")
case "$QUOTE_BUYER" in ""|rules|outcome) ;; *) echo "--quote-buyer must be rules or outcome" >&2; exit 64 ;; esac
[ -n "$QUOTE_BUYER" ] && RUNNER_EXTRA+=(--quote-buyer "$QUOTE_BUYER")

ok()   { printf '  \033[32mPASS\033[0m %s\n' "$*"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$*"; }
hdr()  { printf '\n== %s\n' "$*"; }
run()  { if [ "$DRY" = 1 ]; then echo "  (dry-run) $*"; else "$@"; fi; }

in_wsl() { grep -qi microsoft /proc/version 2>/dev/null; }
require_linux_shell() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*) echo "Run this in WSL Ubuntu (wsl -d Ubuntu), not Git Bash: the signer and bridge need ~/.near-credentials in WSL." >&2; exit 1 ;;
  esac
  in_wsl || warn "not WSL (fine on Linux; on Windows use WSL Ubuntu)"
}
cfg_get() { node -e 'const c=require(process.argv[1]); const v=process.argv[2].split(".").reduce((o,k)=>o==null?o:o[k],c); process.stdout.write(v==null?"":String(v))' "$CONFIG" "$1"; }
port_of() { local p; p="$(cfg_get "ports.$1")"; echo "${p:-$2}"; }

SIGNER_PORT="$(port_of signer 8771)"; BRIDGE_PORT="$(port_of bridge 8772)"; RUNNER_PORT="$(port_of runner 8774)"; UI_PORT=8765

wait_http() { # url seconds
  local url="$1" secs="$2" i=0
  [ "$DRY" = 1 ] && { echo "  (dry-run) wait for $url"; return 0; }
  while [ $i -lt "$secs" ]; do
    curl -s -o /dev/null --max-time 2 "$url" && return 0
    sleep 1; i=$((i + 1))
  done
  return 1
}

start_bg() { # name dir logfile cmd...
  local name="$1" dir="$2" log="$3"; shift 3
  if [ "$DRY" = 1 ]; then echo "  (dry-run) cd $dir && $* > $log 2>&1 &"; return 0; fi
  if [ "$BACKGROUND" = 1 ]; then
    ( cd "$dir" && nohup "$@" >"$log" 2>&1 & echo $! >"$RUN_DIR/$name.pid" )
  else   # foreground (default): no nohup — the services end with this terminal
    ( cd "$dir" && exec "$@" >"$log" 2>&1 ) & echo $! >"$RUN_DIR/$name.pid"
  fi
}

# Foreground mode: stay in this terminal; Ctrl+C / closing the window / a crashed service → stop everything.
hold_foreground() {
  [ "$DRY" = 1 ] && { echo "  (dry-run) would stay in the foreground until Ctrl+C"; return 0; }
  trap 'echo; stop_all; exit 0' INT TERM HUP
  echo
  echo "  Running in this terminal. Press Ctrl+C (or close this window) to stop all services."
  local names=(signer bridge runner); [ "$NO_UI" = 1 ] || names+=(ui)
  while sleep 2; do
    for n in "${names[@]}"; do
      local pid; pid="$(cat "$RUN_DIR/$n.pid" 2>/dev/null || true)"
      if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
        bad "$n stopped unexpectedly — last log lines:"; tail -n 15 "$RUN_DIR/$n.log" 2>/dev/null
        trap - INT TERM HUP; stop_all; exit 1
      fi
    done
  done
}

stop_all() {
  hdr "stop: UI and services"
  mkdir -p "$RUN_DIR"
  for name in ui runner bridge signer; do
    local pf="$RUN_DIR/$name.pid"
    if [ -f "$pf" ]; then
      local pid; pid="$(cat "$pf")"
      if kill -0 "$pid" 2>/dev/null; then run kill "$pid" && ok "stopped $name (pid $pid)"; fi
      run rm -f "$pf"
    fi
  done
  # copies started by hand in other windows
  for pat in "node signer/index.mjs" "node bridge/index.mjs" "node runner/index.mjs" "node serve.mjs"; do
    if pgrep -f "$pat" >/dev/null 2>&1; then run pkill -f "$pat" && ok "stopped: $pat"; fi
  done
  [ "$DRY" = 1 ] || sleep 1
}

summary() {
  hdr "summary"
  if [ "$DRY" = 1 ]; then echo "  (dry-run) nothing was started; no live checks"; return 0; fi
  for s in "signer $SIGNER_PORT" "bridge $BRIDGE_PORT" "runner $RUNNER_PORT"; do
    set -- $s
    local j; j="$(curl -s --max-time 3 "http://127.0.0.1:$2/health" || true)"
    if [ -n "$j" ]; then
      echo "  $1 :$2  $(echo "$j" | jq -c '{contractId, keysLoaded, ap2: (.ap2 // null)}' 2>/dev/null || echo up)"
    else
      bad "$1 :$2 not answering (log: $RUN_DIR/$1.log)"
    fi
  done
  [ "$NO_UI" = 1 ] || echo "  UI     :$UI_PORT  http://127.0.0.1:$UI_PORT/Agent%20Escalation%20Console.html"
  echo "  logs: $RUN_DIR/{signer,bridge,runner,ui}.log   stop: bash $ROOT/scripts/signatory.sh stop"
}

# ------------------------------------------------------------------ start
do_start() {
  require_linux_shell
  mkdir -p "$RUN_DIR"
  [ -d "$SERVICES/node_modules" ] || { bad "services/node_modules missing — run: bash $ROOT/scripts/signatory.sh setup"; exit 1; }
  stop_all
  if [ "$WITH_VLEI" = 1 ]; then
    hdr "vLEI stack (same identities, no 4D): legentvLEI/start-vlei.sh"
    ( cd "$VLEI" && run ./start-vlei.sh ) || { bad "start-vlei.sh failed — see its output above"; exit 1; }
  fi
  hdr "services (ap2 $AP2, negotiator $NEGOTIATOR, pace ${PACE_MS} ms, vLEI verifier $VLEI_VERIFIER, Sally $SALLY)"
  start_bg signer "$SERVICES" "$RUN_DIR/signer.log" node signer/index.mjs --ap2 "$AP2"
  start_bg bridge "$SERVICES" "$RUN_DIR/bridge.log" node bridge/index.mjs --ap2 "$AP2"
  for s in "signer $SIGNER_PORT" "bridge $BRIDGE_PORT"; do
    set -- $s
    if wait_http "http://127.0.0.1:$2/health" 60; then ok "$1 up on :$2"; else bad "$1 did not start — last log lines:"; tail -n 15 "$RUN_DIR/$1.log"; exit 1; fi
  done
  start_bg runner "$SERVICES" "$RUN_DIR/runner.log" node runner/index.mjs --ap2 "$AP2" "${RUNNER_EXTRA[@]}"
  if wait_http "http://127.0.0.1:$RUNNER_PORT/health" 90; then ok "runner up on :$RUNNER_PORT"; else bad "runner did not start — last log lines:"; tail -n 15 "$RUN_DIR/runner.log"; exit 1; fi

  hdr "UI config → configured contract and service URLs (health --stage all --write-ui-config)"
  ( cd "$ROOT" && run node scripts/health.mjs --stage all --write-ui-config ) | tail -n 6

  if [ "$NO_UI" = 0 ]; then
    hdr "UI"
    start_bg ui "$UI_DIR" "$RUN_DIR/ui.log" node serve.mjs --port "$UI_PORT"
    if wait_http "http://127.0.0.1:$UI_PORT/" 20; then ok "UI up on :$UI_PORT"; else bad "UI did not start"; tail -n 10 "$RUN_DIR/ui.log"; exit 1; fi
  fi
  summary
  [ "$BACKGROUND" = 1 ] || hold_foreground
}

# ------------------------------------------------------------------ setup
do_setup() {
  local missing=()
  hdr "tools"
  for t in node npm jq curl; do command -v "$t" >/dev/null && ok "$t" || { bad "$t not on PATH"; missing+=("install $t"); }; done
  if command -v node >/dev/null; then
    local major; major="$(node -p 'process.versions.node.split(".")[0]')"
    [ "$major" -ge 22 ] && ok "node $(node -v)" || { bad "node $(node -v) < 22"; missing+=("install Node.js 22 or newer"); }
  fi

  if [ "$FRESH_VLEI" = 1 ]; then
    command -v docker >/dev/null && docker ps >/dev/null 2>&1 && ok "docker reachable" || { bad "docker not reachable"; echo "  fix: start Docker Desktop (WSL integration on); permission denied → sudo usermod -aG docker \$USER"; exit 1; }
    hdr "vLEI: FRESH stack + full org via run-5D.sh (destructive on this PC)"
    if [ "$YES" != 1 ] && [ "$DRY" != 1 ]; then
      echo "  This deletes the vLEI identities, credentials and passcodes on THIS PC and creates new ones (≈ 25 min)."
      read -r -p "  Type FRESH to continue: " ans
      [ "$ans" = "FRESH" ] || { echo "  cancelled"; exit 1; }
    fi
    # one command for the whole org (4 officers, 4 agents, 4 sub-agents): legentvLEI/run-5D.sh
    # (company files → config, fresh stack, 4D, issuance proof, strict export, strict trust tree)
    ( cd "$VLEI" && run ./run-5D.sh --yes --export-node "$EXPORT_NODE" ) \
      && ok "vLEI org built and evidence exported (run-5D.sh)" \
      || { bad "run-5D.sh failed — see its output above (if WSL cannot run it, run legentvLEI/run-5D.sh in Git Bash)"; exit 1; }
  else
    hdr "vLEI"
    warn "skipped (no --fresh-vlei): the existing stack and identities are kept. Daily: signatory.sh start --vlei"
  fi

  if [ "$SKIP_NPM" = 0 ]; then
    hdr "npm install (services)"
    ( cd "$SERVICES" && run npm install --no-audit --no-fund ) && ok "services dependencies" || missing+=("npm install in chainaim-signatory/services")
  fi

  hdr "key files (presence only — never opened)"
  local creds="$HOME/.near-credentials/testnet"
  local accts
  accts="$(node -e '
    const a=require(process.argv[1]); const by=r=>Object.values(a.aliases).filter(e=>e.role===r).map(e=>e.account);
    console.log([["buyer agent (signer pays)",by("buyer_agent")[0]],["CPO (signer approves/revokes)",by("cpo")[0]],["registrar (bridge registers)",a.registrar],["owner (set-mandates only)",a.owner]].map(x=>x.join("|")).join("\n"))' "$ROOT/config/accounts.json")"
  while IFS='|' read -r what acct; do
    [ -z "$acct" ] && continue
    if [ -f "$creds/$acct.json" ]; then ok "$what: $acct"; else bad "$what: $creds/$acct.json missing"; missing+=("NEAR key file for $acct → $creds/ (copy from the account owner in person/encrypted, or create your own account and put it in config/accounts.json)"); fi
  done <<< "$accts"
  for p in ap2.merchantKeyPath ap2.buyerKeyPath; do
    local rel; rel="$(cfg_get "$p")"
    if [ -f "$ROOT/$rel" ]; then ok "AP2 key: $rel"; else bad "AP2 key missing: $rel"; missing+=("AP2 key $rel → same pair as config/ap2-keys/*.public.jwk.json (copy in person/encrypted), or create new ones: node scripts/ap2-keys.mjs --party merchant|buyer (then commit the new public JWKs)"); fi
  done
  local ev; ev="$(cfg_get evidencePath)"
  [ -f "$ROOT/$ev" ] && ok "evidence: $ev" || { bad "evidence missing: $ev"; missing+=("vLEI evidence: run setup --fresh-vlei (first time) or the export"); }

  hdr "NEAR (read-only): health --stage contract"
  if [ "$DRY" = 1 ]; then echo "  (dry-run) node scripts/health.mjs --stage contract"
  elif ( cd "$ROOT" && node scripts/health.mjs --stage contract ) | tail -n 12; [ "${PIPESTATUS[0]}" = 0 ]; then ok "NEAR checks passed"
  else missing+=("fix the FAIL lines of: node scripts/health.mjs --stage contract (accounts, storage_deposit, faucet USDC, contract, mandates)"); fi

  hdr "result"
  if [ ${#missing[@]} -eq 0 ]; then
    ok "setup complete — next: bash $ROOT/scripts/signatory.sh start"
  else
    echo "  still to do (manual, in order):"
    local i=1; for m in "${missing[@]}"; do echo "   $i. $m"; i=$((i + 1)); done
    exit 1
  fi
}

case "$MODE" in
  setup) do_setup ;;
  start) do_start ;;
  stop)  require_linux_shell; stop_all; if [ "$WITH_VLEI" = 1 ]; then hdr "vLEI stack (preserve: identities kept)"; ( cd "$VLEI" && run ./stop.sh --preserve ); fi; ok "stopped" ;;
  *) echo "usage: bash scripts/signatory.sh setup|start|stop [flags]   (--help)" >&2; exit 64 ;;
esac

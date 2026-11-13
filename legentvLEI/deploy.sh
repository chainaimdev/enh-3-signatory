#!/bin/bash
################################################################################
# deploy.sh - vLEI Workshop Infrastructure Deployment
#
# PURPOSE: Start all vLEI services and verify they are healthy
#
# SERVICES STARTED:
#   • Schema server (vLEI schemas)     - Port 7723
#   • Witnesses (6x)                   - Ports 5642-5647
#   • KERIA (agent server)             - Ports 3901-3903
#   • Verifier (Sally)                 - Port 9723
#   • Webhook                          - Port 9923
#   • tsx-shell (TypeScript runner)    - No port (utility)
#   • vlei-verification                - Port 9724
#
# USAGE:
#   ./deploy.sh [--preserve | --fresh] [--skip-clean] [--dry-run]
#
# FLAGS:
#   --preserve   (DEFAULT) `docker compose down --remove-orphans` before
#                starting. Named volumes - crucially keria-vol - are KEPT, so
#                existing AIDs, habitats and credentials survive the restart.
#   --fresh      `docker compose down --remove-orphans --volumes`. DESTROYS
#                keria-vol, witness-vol, verifier-vol, shell-vol, resolver-vol.
#                Every AID and credential is gone. Use only when you intend to
#                re-run the full 4D workflow from scratch.
#                NOTE: the task-data volume (vlei_task_data) is declared
#                `external: true`, and docker compose NEVER deletes external
#                volumes. BRANs and AID info files therefore SURVIVE --fresh.
#                To destroy those too you must do it explicitly:
#                  docker volume rm vlei_task_data
#   --skip-clean Do not run `docker compose down` at all; just `up --wait`.
#   --dry-run    Print every docker command that would run; execute none.
#   -h|--help    Show this help.
#
# WHY THIS EXISTS (Phase 0 fix D0-4):
#   deploy.sh used to run `docker compose down --remove-orphans --volumes`
#   unconditionally on every single invocation. That wiped keria-vol every
#   time anyone deployed, so all AIDs vanished and the whole trust chain had
#   to be rebuilt - silently, with no prompt and no flag to opt out.
#
# PREREQUISITES:
#   Run ./setup.sh first to:
#   - Fix line endings
#   - Build Docker images
#   - Verify schema configuration
#
# DATE: November 30, 2025
# VERSION: 2.0 - Added tsx-shell verification
################################################################################

set -e

# Color codes
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

################################################################################
# FLAGS (Phase 0 fix D0-4)
################################################################################
CLEAN_MODE="preserve"   # preserve | fresh | skip
DRY_RUN=0

# Header block grew when the task-data volume note was added - keep this range
# in sync with the comment block at the top of the file.
usage() {
    sed -n '2,50p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --preserve)   CLEAN_MODE="preserve"; shift ;;
        --fresh)      CLEAN_MODE="fresh";    shift ;;
        --skip-clean) CLEAN_MODE="skip";     shift ;;
        --dry-run)    DRY_RUN=1;             shift ;;
        -h|--help)    usage ;;
        *)
            echo -e "${RED}ERROR: unknown argument: $1${NC}" >&2
            echo "Run '$0 --help' for usage." >&2
            exit 1
            ;;
    esac
done

# run <cmd...> - execute, or just print under --dry-run.
run() {
    if [ "$DRY_RUN" -eq 1 ]; then
        echo -e "${YELLOW}  [dry-run] $*${NC}"
    else
        "$@"
    fi
}

echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║         vLEI Workshop Infrastructure Deployment              ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

################################################################################
# PRE-FLIGHT CHECKS
################################################################################
echo -e "${YELLOW}[0/5] Pre-flight checks...${NC}"

################################################################################
# Phase 0 fix D0-5: the Docker pre-flight check was cosmetic.
#
# It used to be:
#     command -v docker            &> /dev/null
#     command -v docker compose    &> /dev/null
#
# Two problems:
#   1. `command -v docker` only proves a BINARY exists on PATH. Docker Desktop
#      installs a shim into every WSL distro, including ones where WSL
#      integration is DISABLED. The shim resolves fine, then every actual call
#      fails with "The command 'docker' could not be found in this WSL 2
#      distro." The script printed a green tick and marched on.
#   2. `command -v docker compose` looks for a command literally named
#      "docker compose" (with a space). It never tested the compose plugin at
#      all.
#
# Now we test that the CLI runs AND the daemon answers.
################################################################################
if ! command -v docker > /dev/null 2>&1; then
    echo -e "${RED}  ✗ docker binary not found on PATH.${NC}"
    exit 1
fi

if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}  ✗ docker CLI found, but the Docker daemon is not reachable.${NC}"
    echo -e "${YELLOW}    Most common cause on Windows: Docker Desktop is running, but WSL${NC}"
    echo -e "${YELLOW}    integration is OFF for this distro.${NC}"
    echo -e "${YELLOW}    Fix: Docker Desktop > Settings > Resources > WSL Integration${NC}"
    echo -e "${YELLOW}         > enable this distro > Apply & Restart.${NC}"
    echo ""
    echo -e "${YELLOW}    Raw error from docker:${NC}"
    docker info 2>&1 | head -5 | sed 's/^/      /'
    exit 1
fi
echo -e "${GREEN}  ✓ Docker daemon reachable${NC}"

if ! docker compose version > /dev/null 2>&1; then
    echo -e "${RED}  ✗ 'docker compose' plugin not available.${NC}"
    echo -e "${YELLOW}    Install the Compose V2 plugin, or use Docker Desktop.${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ docker compose available ($(docker compose version --short 2>/dev/null))${NC}"

# Check if tsx-shell image exists (should be built by setup.sh).
# Use --format: bare `docker images` prints a human-readability warning on
# Docker 29+, and its column layout is not a stable contract to grep against.
if ! docker images --format '{{.Repository}}' | grep -q "gleif/wkshp-tsx-shell"; then
    echo -e "${YELLOW}  ⚠ tsx-shell image not found - building now...${NC}"
    run docker compose build tsx-shell
fi
echo -e "${GREEN}  ✓ tsx-shell image ready${NC}"

echo ""

################################################################################
# STEP 1: Create Docker Network + shared task-data volume
################################################################################
echo -e "${YELLOW}[1/5] Creating Docker network and shared volume...${NC}"

TASK_DATA_VOLUME="${VLEI_TASK_DATA_VOLUME:-vlei_task_data}"

if [ "$DRY_RUN" -eq 1 ]; then
    echo -e "${YELLOW}  [dry-run] docker network create vlei_workshop --driver bridge${NC}"
    echo -e "${YELLOW}  [dry-run] docker volume create ${TASK_DATA_VOLUME}${NC}"
else
    docker network create vlei_workshop --driver bridge 2>/dev/null && \
        echo -e "${GREEN}  ✓ Network vlei_workshop created${NC}" || \
        echo -e "${YELLOW}  - Network vlei_workshop already exists${NC}"

    ############################################################################
    # Hosting-readiness: task-data is now an EXTERNAL Docker volume shared by
    # this compose project and the DD agents' compose project. Both declare it
    # `external: true`, which means compose will NOT create it - it must exist
    # before `docker compose up`, or the stack fails with
    # "external volume not found". Creating it here keeps deploy.sh the single
    # entry point, exactly as it already is for the vlei_workshop network.
    ############################################################################
    docker volume create "$TASK_DATA_VOLUME" > /dev/null 2>&1 && \
        echo -e "${GREEN}  ✓ Volume ${TASK_DATA_VOLUME} created${NC}" || \
        echo -e "${YELLOW}  - Volume ${TASK_DATA_VOLUME} already exists${NC}"

    # An EMPTY task-data volume is almost always a mistake: it means the
    # migration from the old host bind mount was never run, and the stack will
    # come up with no BRANs - every agent identity unresolvable, while the AIDs
    # themselves still sit in keria-vol. Warn loudly rather than let the user
    # discover it three steps later in a failed negotiation.
    TD_COUNT="$(docker run --rm -v "$TASK_DATA_VOLUME":/v alpine:3.20 \
                  sh -c 'ls -A /v 2>/dev/null | wc -l' 2>/dev/null | tr -d '[:space:]')"
    if [ "${TD_COUNT:-0}" -eq 0 ]; then
        echo -e "${RED}  ⚠ Volume ${TASK_DATA_VOLUME} is EMPTY.${NC}"
        if [ -d "./task-data" ] && [ -n "$(ls -A ./task-data 2>/dev/null)" ]; then
            echo -e "${YELLOW}    A populated ./task-data directory still exists on the host.${NC}"
            echo -e "${YELLOW}    You have not run the migration yet. Run:${NC}"
            echo -e "${CYAN}      ./migrate-taskdata-to-volume.sh            # dry run${NC}"
            echo -e "${CYAN}      ./migrate-taskdata-to-volume.sh --apply    # do it${NC}"
        else
            echo -e "${YELLOW}    No host ./task-data to migrate either. If this is a fresh${NC}"
            echo -e "${YELLOW}    environment, run the 4D workflow to generate identities.${NC}"
        fi
        echo ""
    else
        echo -e "${GREEN}  ✓ Volume ${TASK_DATA_VOLUME} populated (${TD_COUNT} entries)${NC}"
    fi
fi
echo ""

################################################################################
# STEP 2: Clean Up Existing Containers
################################################################################
echo -e "${YELLOW}[2/5] Cleaning up existing containers (mode: ${CLEAN_MODE})...${NC}"

case "$CLEAN_MODE" in
    fresh)
        echo -e "${RED}  ⚠ --fresh: named volumes WILL be destroyed (keria-vol, witness-vol,${NC}"
        echo -e "${RED}    verifier-vol, shell-vol, resolver-vol). All AIDs and credentials${NC}"
        echo -e "${RED}    will be lost and must be regenerated by the 4D workflow.${NC}"
        run docker compose down --remove-orphans --volumes
        echo -e "${GREEN}  ✓ Containers and volumes removed${NC}"
        ;;
    preserve)
        run docker compose down --remove-orphans
        echo -e "${GREEN}  ✓ Containers removed, named volumes PRESERVED (keria-vol intact)${NC}"
        ;;
    skip)
        echo -e "${YELLOW}  - --skip-clean: leaving existing containers in place${NC}"
        ;;
esac
echo ""

################################################################################
# STEP 3: Start Services
################################################################################
echo -e "${YELLOW}[3/5] Starting services...${NC}"

run docker compose up --wait -d

if [ "$DRY_RUN" -eq 1 ]; then
    echo -e "${YELLOW}  [dry-run] skipping health checks - nothing was started.${NC}"
    echo ""
    exit 0
fi

echo -e "${GREEN}  ✓ All services started${NC}"
echo ""

################################################################################
# STEP 4: Health Checks
################################################################################
echo -e "${YELLOW}[4/5] Running health checks...${NC}"
echo ""

# Check schema server
echo -e "${BLUE}  Schema Server:${NC}"
if curl -sf http://127.0.0.1:7723/oobi/EBfdlu8R27Fbx-ehrqwImnK-8Cm79sqbAQ4MmvEAYqao > /dev/null 2>&1; then
    echo -e "${GREEN}    ✓ Schema server healthy${NC}"
else
    echo -e "${RED}    ✗ Schema server not responding${NC}"
fi

# Check invoice schema
if [ -f "./appconfig/schemaSaids.json" ]; then
    INVOICE_SCHEMA_SAID=$(grep -o '"said": *"[^"]*"' ./appconfig/schemaSaids.json | head -1 | sed 's/.*"\([^"]*\)"/\1/')
    if curl -sf "http://127.0.0.1:7723/oobi/${INVOICE_SCHEMA_SAID}" > /dev/null 2>&1; then
        echo -e "${GREEN}    ✓ Invoice schema accessible (${INVOICE_SCHEMA_SAID})${NC}"
    else
        echo -e "${YELLOW}    ⚠ Invoice schema may need loading${NC}"
    fi
fi

# Check witnesses
echo -e "${BLUE}  Witnesses:${NC}"
WITNESS_PORTS=(5642 5643 5644 5645 5646 5647)
WITNESS_NAMES=(wan wil wes wit wub wyz)
for i in ${!WITNESS_PORTS[@]}; do
    if curl -sf "http://127.0.0.1:${WITNESS_PORTS[$i]}/oobi" > /dev/null 2>&1; then
        echo -e "${GREEN}    ✓ Witness ${WITNESS_NAMES[$i]} (port ${WITNESS_PORTS[$i]})${NC}"
    else
        echo -e "${RED}    ✗ Witness ${WITNESS_NAMES[$i]} not responding${NC}"
    fi
done

# Check KERIA
echo -e "${BLUE}  KERIA:${NC}"
if curl -sf http://127.0.0.1:3902/spec.yaml > /dev/null 2>&1; then
    echo -e "${GREEN}    ✓ KERIA healthy${NC}"
else
    echo -e "${RED}    ✗ KERIA not responding${NC}"
fi

# Check verifier
echo -e "${BLUE}  Verifier (Sally):${NC}"
if curl -sf http://127.0.0.1:9723/health > /dev/null 2>&1; then
    echo -e "${GREEN}    ✓ Verifier healthy${NC}"
else
    echo -e "${RED}    ✗ Verifier not responding${NC}"
fi

# Check webhook
echo -e "${BLUE}  Webhook:${NC}"
if curl -sf http://127.0.0.1:9923/health > /dev/null 2>&1; then
    echo -e "${GREEN}    ✓ Webhook healthy${NC}"
else
    echo -e "${RED}    ✗ Webhook not responding${NC}"
fi

# Check tsx-shell
echo -e "${BLUE}  tsx-shell:${NC}"
# Ask the container directly rather than grepping `docker compose ps` output -
# that table's wording changes between compose versions (you are on v5).
# tsx-shell has container_name: tsx_shell, so inspect is exact and stable.
if [ "$(docker inspect -f '{{.State.Running}}' tsx_shell 2>/dev/null)" == "true" ]; then
    echo -e "${GREEN}    ✓ tsx-shell running${NC}"
    
    # Verify TypeScript files are mounted
    if docker exec -i tsx_shell ls /vlei/sig-wallet/src/tasks/invoice/invoice-acdc-issue-self-attested-only.ts > /dev/null 2>&1; then
        echo -e "${GREEN}    ✓ TypeScript files mounted correctly${NC}"
    else
        echo -e "${RED}    ✗ TypeScript files not mounted - check docker-compose.yml${NC}"
    fi
else
    echo -e "${RED}    ✗ tsx-shell not running${NC}"
fi

echo ""

################################################################################
# STEP 5: Summary
################################################################################
echo -e "${YELLOW}[5/5] Deployment summary...${NC}"
echo ""

echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║              ✓ DEPLOYMENT COMPLETE                           ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

echo -e "${YELLOW}Service URLs:${NC}"
echo "  Schema server:    http://127.0.0.1:7723"
echo "  Witnesses:        http://127.0.0.1:5642 - 5647"
echo "  KERIA Admin:      http://127.0.0.1:3901"
echo "  KERIA HTTP:       http://127.0.0.1:3902"
echo "  KERIA Boot:       http://127.0.0.1:3903"
echo "  Verifier:         http://127.0.0.1:9723"
echo "  Webhook:          http://127.0.0.1:9923"
echo ""

echo -e "${YELLOW}Invoice Schema:${NC}"
if [ -n "$INVOICE_SCHEMA_SAID" ]; then
    echo "  SAID: $INVOICE_SCHEMA_SAID"
    echo "  OOBI: http://127.0.0.1:7723/oobi/$INVOICE_SCHEMA_SAID"
fi
echo ""

echo -e "${YELLOW}Next steps:${NC}"
echo "  Run the vLEI workflow:"
echo "    ./run-all-buyerseller-4C-with-agents.sh"
echo ""
echo "  Or run individual test:"
echo "    ./test-agent-verification.sh"
echo ""

echo -e "${YELLOW}To stop:${NC}"
echo "    ./stop.sh"
echo ""

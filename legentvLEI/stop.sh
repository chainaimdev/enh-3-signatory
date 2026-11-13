#!/bin/bash
################################################################################
# stop.sh - vLEI Workshop Environment Teardown
#
# PURPOSE: Completely stop and clean up the vLEI environment
#
# USAGE:
#   ./stop.sh [--preserve | --fresh] [--dry-run]
#
# FLAGS:
#   --preserve   (DEFAULT) Stop and remove containers only.
#                KEEPS: named volumes (keria-vol and friends), ./task-data,
#                       the vlei_workshop network.
#                Your AIDs, credentials and BRANs survive. `./deploy.sh` will
#                bring the same identities back up.
#   --fresh      Full destructive teardown - the old unconditional behaviour:
#                  * rm ./task-data/*.json and *.txt (BRANs, AIDs, info files)
#                  * docker compose down --remove-orphans --volumes
#                  * docker network rm vlei_workshop
#                Everything is gone. Re-run the full 4D workflow afterwards.
#   --dry-run    Print every destructive command; execute none.
#   -h|--help    Show this help.
#
# WHY THIS EXISTS (Phase 0 fix D0-4):
#   stop.sh used to do the --fresh path unconditionally, with no flag and no
#   confirmation. Every ordinary "stop the stack for the night" destroyed
#   keria-vol and the task-data BRANs, so the entire trust chain
#   (geda/qvi/le/oor/person + agents) had to be rebuilt on the next start.
#
# DATE: November 30, 2025
# VERSION: 2.0
################################################################################

set -e

# Color codes
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

################################################################################
# FLAGS (Phase 0 fix D0-4)
################################################################################
MODE="preserve"   # preserve | fresh
DRY_RUN=0

usage() {
    sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
}

while [ $# -gt 0 ]; do
    case "$1" in
        --preserve) MODE="preserve"; shift ;;
        --fresh)    MODE="fresh";    shift ;;
        --dry-run)  DRY_RUN=1;       shift ;;
        -h|--help)  usage ;;
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

echo -e "${YELLOW}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${YELLOW}║         Stopping vLEI Workshop Environment                   ║${NC}"
echo -e "${YELLOW}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

################################################################################
# STEP 1: Clean Task Data
################################################################################
echo -e "${BLUE}[1/4] Task data (mode: ${MODE})...${NC}"

if [ "$MODE" != "fresh" ]; then
    echo -e "${GREEN}  ✓ PRESERVED - ./task-data left untouched (BRANs, AIDs, info files)${NC}"
    echo -e "${YELLOW}    Pass --fresh to wipe it.${NC}"
elif [ -d "./task-data" ]; then
    echo -e "${RED}  ⚠ --fresh: deleting ./task-data/*.json and *.txt${NC}"
    if [ "$DRY_RUN" -eq 1 ]; then
        echo -e "${YELLOW}  [dry-run] rm -f task-data/*.json task-data/*.txt${NC}"
    else
        rm -fv task-data/*.json 2>/dev/null || true
        rm -fv task-data/*.txt 2>/dev/null || true
        echo -e "${GREEN}  ✓ Task data cleaned${NC}"
    fi
else
    echo -e "${YELLOW}  - No task-data directory found${NC}"
fi
echo ""

################################################################################
# STEP 2: Check Docker Availability
################################################################################
echo -e "${BLUE}[2/4] Checking Docker...${NC}"

# Phase 0 fix D0-5: see deploy.sh for the full explanation. `command -v docker
# compose` searched for a command literally named "docker compose" and never
# tested anything. Test the daemon and the plugin for real.
if ! command -v docker > /dev/null 2>&1; then
    echo -e "${RED}  ✗ docker binary not found on PATH.${NC}"
    exit 1
fi

if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}  ✗ docker CLI found, but the Docker daemon is not reachable.${NC}"
    echo -e "${YELLOW}    On Windows this usually means Docker Desktop WSL integration${NC}"
    echo -e "${YELLOW}    is OFF for this distro. Settings > Resources > WSL Integration.${NC}"
    exit 1
fi

if ! docker compose version > /dev/null 2>&1; then
    echo -e "${RED}  ✗ 'docker compose' plugin not available.${NC}"
    exit 1
fi
echo -e "${GREEN}  ✓ Docker daemon reachable, compose plugin available${NC}"
echo ""

################################################################################
# STEP 3: Stop and Remove Containers
################################################################################
echo -e "${BLUE}[3/4] Stopping and removing containers (mode: ${MODE})...${NC}"

if [ "$MODE" == "fresh" ]; then
    echo -e "${RED}  ⚠ --fresh: named volumes WILL be destroyed (keria-vol, witness-vol,${NC}"
    echo -e "${RED}    verifier-vol, shell-vol, resolver-vol). All AIDs are lost.${NC}"
    run docker compose down --remove-orphans --volumes
    echo -e "${GREEN}  ✓ Containers stopped and removed${NC}"
    echo -e "${GREEN}  ✓ Volumes removed (including KERIA cache)${NC}"
else
    run docker compose down --remove-orphans
    echo -e "${GREEN}  ✓ Containers stopped and removed${NC}"
    echo -e "${GREEN}  ✓ Named volumes PRESERVED - keria-vol intact, AIDs survive${NC}"
fi
echo ""

################################################################################
# STEP 4: Remove Docker Network
################################################################################
echo -e "${BLUE}[4/4] Docker network (mode: ${MODE})...${NC}"

if [ "$MODE" == "fresh" ]; then
    if [ "$DRY_RUN" -eq 1 ]; then
        echo -e "${YELLOW}  [dry-run] docker network rm vlei_workshop${NC}"
    else
        docker network rm vlei_workshop 2>/dev/null && \
            echo -e "${GREEN}  ✓ Network vlei_workshop removed${NC}" || \
            echo -e "${YELLOW}  - Network already removed or doesn't exist${NC}"
    fi
else
    echo -e "${GREEN}  ✓ Network vlei_workshop PRESERVED${NC}"
fi
echo ""

################################################################################
# COMPLETION
################################################################################
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║              ✓ ENVIRONMENT STOPPED                           ║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""
if [ "$MODE" == "fresh" ]; then
    echo -e "${YELLOW}What was cleaned (--fresh):${NC}"
    echo "  • All Docker containers"
    echo "  • All Docker volumes (KERIA cache cleared - AIDs gone)"
    echo "  • Docker network (vlei_workshop)"
    echo "  • Task data files (*.json, *.txt)"
    echo ""
    echo -e "${YELLOW}To start fresh:${NC}"
    echo "  1. ./setup.sh                 # Prepare environment & build images"
    echo "  2. ./deploy.sh --fresh        # Start all services from empty volumes"
    echo "  3. ./run-all-buyerseller-4D-with-subdelegation.sh   # Rebuild trust chain"
else
    echo -e "${YELLOW}What was stopped (--preserve, default):${NC}"
    echo "  • All Docker containers"
    echo ""
    echo -e "${YELLOW}What was KEPT:${NC}"
    echo "  • Named volumes incl. keria-vol - all AIDs and credentials intact"
    echo "  • ./task-data (BRANs, *-info.json)"
    echo "  • Docker network (vlei_workshop)"
    echo ""
    echo -e "${YELLOW}To bring the same environment back up:${NC}"
    echo "  ./deploy.sh                   # identities resume where they left off"
    echo ""
    echo -e "${YELLOW}To wipe everything instead:${NC}"
    echo "  ./stop.sh --fresh"
fi
echo ""

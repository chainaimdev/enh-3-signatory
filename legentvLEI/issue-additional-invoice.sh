#!/bin/bash
################################################################################
# issue-additional-invoice.sh  (G-32, 2026-11-13)
#
# Issues ONE more self-attested invoice with the identities of the current run
# (no 4C/4D re-run), using the existing task scripts unchanged:
#   1. invoice-acdc-issue-self-attested.sh  (same registry, new credential)
#   2. invoice-ipex-grant.sh                (seller -> buyer)
#   3. invoice-ipex-admit.sh                (buyer admits)
#   4. invoice-export-issuance.sh           (read-only TEL/KEL issuance proof)
#
# Steps 1-3 always (over)write these task-data files:
#   <seller>-self-invoice-credential-info.json
#   <seller>-ipex-grant-info.json
#   <buyer>-ipex-admit-info.json
# so this script first keeps a copy of the CURRENT invoice's files as
#   <file base>.<credentialSAID>.json
# and does the same for the new invoice at the end.
# export-signatory-evidence.js reads all copies and lists every invoice.
#
# Refuses before any KERIA call when: the config has a number with
# 0 < |x| < 0.0001, its invoiceNumber was already issued, or the current
# run's identity/registry files are missing.
#
# Usage:
#   ./issue-additional-invoice.sh --invoice-config ./appconfig/invoiceConfig-near-2.json \
#       [--seller-agent jupiterSellerAgent] [--buyer-agent tommyBuyerAgent]
################################################################################

set -e
# MSYS_NO_PATHCONV=1 is set only on the task-script calls below (Git Bash: keeps
# /task-data a container path; a global export would break Windows jq on /c/... paths).

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'

INVOICE_CONFIG_FILE=""
SELLER_AGENT="jupiterSellerAgent"
BUYER_AGENT="tommyBuyerAgent"
while [ $# -gt 0 ]; do
    case "$1" in
        --invoice-config|--seller-agent|--buyer-agent)
            if [ -z "$2" ]; then echo -e "${RED}ERROR: $1 requires a value${NC}" >&2; exit 1; fi
            case "$1" in
                --invoice-config) INVOICE_CONFIG_FILE="$2" ;;
                --seller-agent)   SELLER_AGENT="$2" ;;
                --buyer-agent)    BUYER_AGENT="$2" ;;
            esac
            shift 2 ;;
        -h|--help) sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo -e "${RED}ERROR: unknown argument: $1${NC}" >&2; exit 1 ;;
    esac
done

TD=./task-data
CRED_BASE="$TD/${SELLER_AGENT}-self-invoice-credential-info"
GRANT_BASE="$TD/${SELLER_AGENT}-ipex-grant-info"
ADMIT_BASE="$TD/${BUYER_AGENT}-ipex-admit-info"

# ── Pre-checks (no KERIA call) ───────────────────────────────────────────────
[ -n "$INVOICE_CONFIG_FILE" ] || { echo -e "${RED}ERROR: --invoice-config <file> is required${NC}" >&2; exit 1; }
[ -f "$INVOICE_CONFIG_FILE" ] || { echo -e "${RED}ERROR: invoice config not found: $INVOICE_CONFIG_FILE${NC}" >&2; exit 1; }
jq empty "$INVOICE_CONFIG_FILE" 2>/dev/null || { echo -e "${RED}ERROR: invalid JSON: $INVOICE_CONFIG_FILE${NC}" >&2; exit 1; }

SMALL_NUMBERS=$(jq -r '.invoice.sampleInvoice | paths(numbers) as $p | getpath($p) as $v
    | select($v != 0 and ($v | fabs) < 0.0001) | "\($p | map(tostring) | join(".")) = \($v)"' "$INVOICE_CONFIG_FILE")
if [ -n "$SMALL_NUMBERS" ]; then
    echo -e "${RED}ERROR: invoice config has numbers with 0 < |x| < 0.0001 (KERIA 'Invalid sad'):${NC}" >&2
    echo "$SMALL_NUMBERS" | sed 's/^/    sampleInvoice./' >&2
    exit 1
fi

for f in "$TD/${SELLER_AGENT}-info.json" "$TD/${BUYER_AGENT}-info.json" \
         "$TD/${SELLER_AGENT}-invoice-registry-info.json" \
         "$CRED_BASE.json" "$GRANT_BASE.json" "$ADMIT_BASE.json"; do
    [ -f "$f" ] || { echo -e "${RED}ERROR: missing $f (run 4D first; this script adds to an existing run)${NC}" >&2; exit 1; }
done

NEW_NUMBER=$(jq -r '.invoice.sampleInvoice.invoiceNumber' "$INVOICE_CONFIG_FILE")
for f in "$CRED_BASE".json "$CRED_BASE".*.json; do
    [ -f "$f" ] || continue
    if [ "$(jq -r '.invoiceNumber // empty' "$f")" = "$NEW_NUMBER" ]; then
        echo -e "${RED}ERROR: invoice $NEW_NUMBER was already issued ($(jq -r .said "$f"), in $f)${NC}" >&2
        exit 1
    fi
done

# Keep a copy of one invoice's three files under its credential SAID.
# Only files that belong to that SAID are copied; existing copies are kept.
archive_current() {
    local said; said=$(jq -r '.said' "$CRED_BASE.json")
    [ -n "$said" ] && [ "$said" != "null" ] || { echo -e "${RED}ERROR: no SAID in $CRED_BASE.json${NC}" >&2; exit 1; }
    [ -f "$CRED_BASE.$said.json" ] || cp "$CRED_BASE.json" "$CRED_BASE.$said.json"
    if [ "$(jq -r '.credentialSAID' "$GRANT_BASE.json")" = "$said" ] && [ ! -f "$GRANT_BASE.$said.json" ]; then
        cp "$GRANT_BASE.json" "$GRANT_BASE.$said.json"
    fi
    if [ "$(jq -r '.credentialSAID' "$ADMIT_BASE.json")" = "$said" ] && [ ! -f "$ADMIT_BASE.$said.json" ]; then
        cp "$ADMIT_BASE.json" "$ADMIT_BASE.$said.json"
    fi
    echo "$said"
}

echo -e "${BLUE}→ Keeping a copy of the current invoice's files...${NC}"
OLD_SAID=$(archive_current)
echo "  current invoice: $OLD_SAID"
if [ ! -f "$TD/${SELLER_AGENT}-invoice-issuance-${OLD_SAID}.json" ]; then
    echo -e "${BLUE}→ Exporting issuance proof of the current invoice (read-only)...${NC}"
    MSYS_NO_PATHCONV=1 ./task-scripts/invoice/invoice-export-issuance.sh "$SELLER_AGENT" "$OLD_SAID"
fi

# ── KERIA steps (existing task scripts) ──────────────────────────────────────
echo -e "${BLUE}→ [1/4] Issuing $NEW_NUMBER from $INVOICE_CONFIG_FILE...${NC}"
MSYS_NO_PATHCONV=1 ./task-scripts/invoice/invoice-acdc-issue-self-attested.sh "$SELLER_AGENT" "$INVOICE_CONFIG_FILE"
NEW_SAID=$(jq -r '.said' "$CRED_BASE.json")
if [ -z "$NEW_SAID" ] || [ "$NEW_SAID" = "null" ] || [ "$NEW_SAID" = "$OLD_SAID" ]; then
    echo -e "${RED}ERROR: issue step did not write a new credential SAID${NC}" >&2; exit 1
fi
echo "  new invoice: $NEW_SAID"

echo -e "${BLUE}→ [2/4] IPEX grant $SELLER_AGENT → $BUYER_AGENT...${NC}"
MSYS_NO_PATHCONV=1 ./task-scripts/invoice/invoice-ipex-grant.sh "$SELLER_AGENT" "$BUYER_AGENT"

echo -e "${BLUE}→ [3/4] IPEX admit by $BUYER_AGENT...${NC}"
MSYS_NO_PATHCONV=1 ./task-scripts/invoice/invoice-ipex-admit.sh "$BUYER_AGENT" "$SELLER_AGENT"

echo -e "${BLUE}→ [4/4] Issuance proof (read-only)...${NC}"
MSYS_NO_PATHCONV=1 ./task-scripts/invoice/invoice-export-issuance.sh "$SELLER_AGENT" "$NEW_SAID"

archive_current >/dev/null

# The admit wrapper exits 0 even when the admit did not happen; check the file.
ADMIT_OK=$(jq -r --arg s "$NEW_SAID" 'select(.credentialSAID == $s) | "\(.admitSuccess) \(.credentialHeld)"' "$ADMIT_BASE.json")
if [ "$ADMIT_OK" != "true true" ]; then
    echo -e "${RED}✗ $NEW_NUMBER issued and granted, but admit/hold is not confirmed (admitSuccess credentialHeld = '${ADMIT_OK:-no admit info for $NEW_SAID}')${NC}" >&2
    echo "  Diagnose: ./task-scripts/invoice/invoice-ipex-diagnose.sh $BUYER_AGENT $SELLER_AGENT" >&2
    exit 1
fi

echo -e "${GREEN}✓ $NEW_NUMBER ($NEW_SAID) issued, granted, admitted and held by $BUYER_AGENT${NC}"
echo "  Next: node export-signatory-evidence.js --strict --out ../UI/data/signatory-evidence.json"

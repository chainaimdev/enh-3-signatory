#!/bin/bash
################################################################################
# run-all-buyerseller-4D-with-subdelegation.sh
#
# Purpose: Extended vLEI workflow with sub-agent delegation support
#          jupiterSellerAgent → JupiterTreasuryAgent
#
# New Features:
#   - Sub-agent BRAN generation
#   - Agent-to-agent delegation
#   - Extended trust chain verification
#
# Version: 4D - With Sub-Delegation
################################################################################

set -e

# Color codes
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
WHITE='\033[1;37m'
NC='\033[0m'

################################################################################
# FLAGS
#   --dd-root <path>   Root of the DynDiscounting A2A/js tree - the directory
#                      that contains src/agents and demo-agent-cards, e.g.
#                        /mnt/c/SATHYA/CHAINAIM3003/mcp-servers/FINAGENTS/\
#                          FINAGENTS1/DynDiscProject5/A2A/js
#                      Cards minted by this run are written to
#                        <dd-root>/live-agent-cards/<alias>-card.json
#                      which is the FIRST path resolveCardPath() in the DD
#                      agents looks at. Without it this run mints new AIDs
#                      that no DD agent will ever see - the stale-card bug.
#                      Also settable via the DD_ROOT environment variable.
#   --skip-cards       Do not regenerate agent cards at all.
#   --config-4c <file> Config passed to 4C (--config). Seller/buyer invoice
#                      agents are taken from its role "seller"/"buyer".
#                      default: 4C's own default config.
#   --config-4d <file> Config used by the sub-agent loop,
#                      generate-subagent-brans.sh and generate-agent-cards.js
#                      (which then also gets --per-officer-oor).
#                      default: ./appconfig/configBuyerSellerAIAgent1-with-subdelegation.json
#   --force-base       Always run 4C, even if the Phase 1 skip files exist.
#   --invoice-config <file>
#                      Invoice data passed to 4C (--invoice-config), e.g.
#                      ./appconfig/invoiceConfig-near.json. Only used when 4C
#                      runs, so combine it with --force-base.
#                      default: 4C's own default (./appconfig/invoiceConfig.json)
#   -h | --help        Show this flag list.
#
# NOTE: --dd-root here has the SAME meaning as --dd-root in
#       generate-unique-agent-brans.sh and generate-agent-cards.js: it points
#       at the A2A/js directory itself, NOT at the project root.
################################################################################

DD_ROOT="${DD_ROOT:-}"
SKIP_CARDS=0
CONFIG_4C=""
CONFIG_4D=""
FORCE_BASE=0
INVOICE_CONFIG_ARG=""

while [ $# -gt 0 ]; do
    case "$1" in
        --dd-root)
            if [ -z "$2" ]; then
                echo -e "${RED}ERROR: --dd-root requires a value${NC}" >&2
                exit 1
            fi
            DD_ROOT="$2"; shift 2 ;;
        --skip-cards)  SKIP_CARDS=1; shift ;;
        --config-4c|--config-4d)
            if [ -z "$2" ]; then
                echo -e "${RED}ERROR: $1 requires a value${NC}" >&2
                exit 1
            fi
            if [ ! -f "$2" ]; then
                echo -e "${RED}ERROR: $1 file not found: $2${NC}" >&2
                exit 1
            fi
            if [ "$1" = "--config-4c" ]; then CONFIG_4C="$2"; else CONFIG_4D="$2"; fi
            shift 2 ;;
        --force-base)  FORCE_BASE=1; shift ;;
        --invoice-config)
            if [ -z "$2" ]; then
                echo -e "${RED}ERROR: --invoice-config requires a value${NC}" >&2
                exit 1
            fi
            if [ ! -f "$2" ]; then
                echo -e "${RED}ERROR: --invoice-config file not found: $2${NC}" >&2
                exit 1
            fi
            INVOICE_CONFIG_ARG="$2"; shift 2 ;;
        -h|--help)
            sed -n '/^# FLAGS/,/^#####/p' "$0" | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *)
            echo -e "${RED}ERROR: unknown argument: $1${NC}" >&2
            echo "Run '$0 --help' for usage." >&2
            exit 1 ;;
    esac
done

# Configuration
CONFIG_FILE="./appconfig/configBuyerSellerAIAgent1-with-subdelegation.json"
if [ -n "$CONFIG_4D" ]; then
    CONFIG_FILE="$CONFIG_4D"
fi

# Arguments for the 4C call (empty = 4C runs exactly as before)
BASE_ARGS=()
if [ -n "$CONFIG_4C" ]; then
    BASE_ARGS+=(--config "$CONFIG_4C")
    SELLER_FROM_CFG=$(jq -r '[.organizations[].persons[].agents[] | select(.role == "seller") | .alias] | if length == 1 then .[0] else empty end' "$CONFIG_4C")
    BUYER_FROM_CFG=$(jq -r '[.organizations[].persons[].agents[] | select(.role == "buyer") | .alias] | if length == 1 then .[0] else empty end' "$CONFIG_4C")
    if [ -z "$SELLER_FROM_CFG" ] || [ -z "$BUYER_FROM_CFG" ]; then
        echo -e "${RED}ERROR: $CONFIG_4C must contain exactly one agent with role \"seller\" and one with role \"buyer\"${NC}" >&2
        exit 1
    fi
    BASE_ARGS+=(--seller-agent "$SELLER_FROM_CFG" --buyer-agent "$BUYER_FROM_CFG")
fi
INVOICE_CONFIG_FILE="./appconfig/invoiceConfig.json"
if [ -n "$INVOICE_CONFIG_ARG" ]; then
    BASE_ARGS+=(--invoice-config "$INVOICE_CONFIG_ARG")
    INVOICE_CONFIG_FILE="$INVOICE_CONFIG_ARG"
fi
INVOICE_SCHEMA_FILE="./schemas/self-attested-invoice.json"

# Load schema SAID
if [ -f "./appconfig/schemaSaids.json" ]; then
    INVOICE_SCHEMA_SAID=$(jq -r '.invoiceSchema.said' "./appconfig/schemaSaids.json")
elif [ -f "./task-data/invoice-schema-said.txt" ]; then
    INVOICE_SCHEMA_SAID=$(cat ./task-data/invoice-schema-said.txt)
else
    INVOICE_SCHEMA_SAID=$(jq -r '."$id"' "$INVOICE_SCHEMA_FILE" 2>/dev/null || echo "")
fi

if [ -z "$INVOICE_SCHEMA_SAID" ] || [ "$INVOICE_SCHEMA_SAID" = "null" ]; then
    echo -e "${RED}ERROR: Invoice schema SAID is empty!${NC}"
    exit 1
fi

echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}  vLEI System v4D - With Sub-Delegation${NC}"
echo -e "${CYAN}  jupiterSellerAgent → JupiterTreasuryAgent${NC}"
echo -e "${CYAN}════════════════════════════════════════════════════════════${NC}"
echo ""

################################################################################
# Run existing 4C workflow first
################################################################################

echo -e "${YELLOW}[Phase 1] Running base vLEI workflow (4C)...${NC}"
echo ""

# Check if 4C already completed by looking for key output files
if [ "$FORCE_BASE" -eq 0 ] && \
   [ -f "./task-data/jupiterSellerAgent-info.json" ] && \
   [ -f "./task-data/tommyBuyerAgent-info.json" ] && \
   [ -f "./task-data/jupiterSellerAgent-ipex-grant-info.json" ]; then
    echo -e "${GREEN}✓ Phase 1 SKIPPED: 4C workflow already completed (task-data files present)${NC}"
    echo "  Found: jupiterSellerAgent-info.json, tommyBuyerAgent-info.json, ipex-grant-info.json"
    if [ -n "$INVOICE_CONFIG_ARG" ]; then
        echo -e "${YELLOW}  ⚠ --invoice-config $INVOICE_CONFIG_ARG was NOT used: 4C did not run.${NC}"
        echo -e "${YELLOW}    The invoice in task-data is still the previous one. Add --force-base.${NC}"
    fi
    echo ""
elif [ -f "./run-all-buyerseller-4C-with-agents.sh" ]; then
    ./run-all-buyerseller-4C-with-agents.sh "${BASE_ARGS[@]}"

    if [ $? -ne 0 ]; then
        echo -e "${RED}✗ Base workflow (4C) failed${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✓ Base workflow (4C) completed${NC}"
    echo ""
else
    echo -e "${RED}ERROR: Base workflow script not found${NC}"
    exit 1
fi

################################################################################
# Phase 2: Sub-Agent BRAN Generation
################################################################################

echo -e "${MAGENTA}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${MAGENTA}║  PHASE 2: SUB-AGENT BRAN GENERATION                      ║${NC}"
echo -e "${MAGENTA}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

echo -e "${YELLOW}[2.1/5] Generating unique BRANs for sub-agents...${NC}"
echo ""

if [ -f "./generate-subagent-brans.sh" ]; then
    chmod +x ./generate-subagent-brans.sh
    ./generate-subagent-brans.sh --config "$CONFIG_FILE"

    if [ $? -ne 0 ]; then
        echo -e "${RED}✗ Sub-agent BRAN generation failed${NC}"
        exit 1
    fi
    
    echo -e "${GREEN}✓ Sub-agent BRANs generated${NC}"
    echo ""
else
    echo -e "${RED}ERROR: generate-subagent-brans.sh not found${NC}"
    exit 1
fi

################################################################################
# Phase 3: Sub-Agent Delegation
################################################################################

echo -e "${MAGENTA}╔═══════════════════════════════════════════════════════════╗${NC}"
echo -e "${MAGENTA}║  PHASE 3: SUB-AGENT DELEGATION                           ║${NC}"
echo -e "${MAGENTA}║  jupiterSellerAgent → JupiterTreasuryAgent               ║${NC}"
echo -e "${MAGENTA}╚═══════════════════════════════════════════════════════════╝${NC}"
echo ""

# Find sub-agents in configuration
ORG_COUNT=$(jq -r '.organizations | length' "$CONFIG_FILE")

for ((org_idx=0; org_idx<$ORG_COUNT; org_idx++)); do
    ORG_NAME=$(jq -r ".organizations[$org_idx].name" "$CONFIG_FILE")
    PERSON_COUNT=$(jq -r ".organizations[$org_idx].persons | length" "$CONFIG_FILE")
    
    for ((person_idx=0; person_idx<$PERSON_COUNT; person_idx++)); do
        AGENT_COUNT=$(jq -r ".organizations[$org_idx].persons[$person_idx].agents | length" "$CONFIG_FILE")
        
        for ((agent_idx=0; agent_idx<$AGENT_COUNT; agent_idx++)); do
            PARENT_AGENT=$(jq -r ".organizations[$org_idx].persons[$person_idx].agents[$agent_idx].alias" "$CONFIG_FILE")
            
            # Check if this agent has sub-agents
            SUB_AGENT_LIST=$(jq -r ".organizations[$org_idx].persons[$person_idx].agents[$agent_idx].subAgents // []" "$CONFIG_FILE")
            
            if [ "$SUB_AGENT_LIST" != "[]" ]; then
                SUB_COUNT=$(echo "$SUB_AGENT_LIST" | jq 'length')
                
                echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
                echo -e "${BLUE}║  Parent Agent: $PARENT_AGENT${NC}"
                echo -e "${BLUE}║  Sub-Agents: $SUB_COUNT${NC}"
                echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
                echo ""
                
                for ((sub_idx=0; sub_idx<$SUB_COUNT; sub_idx++)); do
                    SUB_ALIAS=$(echo "$SUB_AGENT_LIST" | jq -r ".[$sub_idx].alias")
                    SUB_TYPE=$(echo "$SUB_AGENT_LIST" | jq -r ".[$sub_idx].agentType")
                    SUB_SCOPE=$(echo "$SUB_AGENT_LIST" | jq -r ".[$sub_idx].permissions.scope")

                    # If the parent declares may_act, delegate only sub-agents listed in it.
                    # Configs without may_act (today's) delegate every sub-agent, as before.
                    if [ "$(jq -r ".organizations[$org_idx].persons[$person_idx].agents[$agent_idx] | has(\"may_act\")" "$CONFIG_FILE")" = "true" ]; then
                        if [ "$(jq -r --arg s "$SUB_ALIAS" ".organizations[$org_idx].persons[$person_idx].agents[$agent_idx].may_act | index(\$s) != null" "$CONFIG_FILE")" != "true" ]; then
                            echo -e "${YELLOW}  ⚠ SKIPPED: $SUB_ALIAS is not in $PARENT_AGENT's may_act${NC}"
                            echo ""
                            continue
                        fi
                    fi

                    echo -e "${CYAN}  ┌─────────────────────────────────────────────────┐${NC}"
                    echo -e "${CYAN}  │  Sub-Agent: $SUB_ALIAS${NC}"
                    echo -e "${CYAN}  │  Type: $SUB_TYPE${NC}"
                    echo -e "${CYAN}  │  Scope: $SUB_SCOPE${NC}"
                    echo -e "${CYAN}  │  Parent: $PARENT_AGENT${NC}"
                    echo -e "${CYAN}  └─────────────────────────────────────────────────┘${NC}"
                    echo ""
                    
                    # Verify BRAN was generated
                    BRAN_FILE="./task-data/${SUB_ALIAS}-bran.txt"
                    if [ ! -f "$BRAN_FILE" ]; then
                        echo -e "${RED}    ✗ ERROR: BRAN not found for ${SUB_ALIAS}${NC}"
                        exit 1
                    fi
                    
                    SUB_BRAN=$(cat "$BRAN_FILE")
                    echo -e "${GREEN}    ✓ Using pre-generated unique BRAN${NC}"
                    echo -e "${GREEN}      BRAN: (hidden) (256-bit)${NC}"
                    echo ""
                    
                    # Create sub-agent delegation script wrapper
                    if [ ! -f "./task-scripts/subagent/subagent-delegate-with-unique-bran.sh" ]; then
                        echo -e "${RED}    ✗ ERROR: subagent-delegate-with-unique-bran.sh not found${NC}"
                        exit 1
                    fi
                    
                    echo -e "${BLUE}    → Creating sub-agent and delegating from parent...${NC}"
                    
                    chmod +x ./task-scripts/subagent/subagent-delegate-with-unique-bran.sh
                    ./task-scripts/subagent/subagent-delegate-with-unique-bran.sh "$SUB_ALIAS" "$PARENT_AGENT"
                    
                    if [ $? -ne 0 ]; then
                        echo -e "${RED}    ✗ Sub-agent delegation failed${NC}"
                        exit 1
                    fi
                    
                    echo -e "${GREEN}    ✓ Sub-agent $SUB_ALIAS delegation complete${NC}"
                    
                    # Display sub-agent info
                    if [ -f "./task-data/${SUB_ALIAS}-info.json" ]; then
                        SUB_AID=$(cat "./task-data/${SUB_ALIAS}-info.json" | jq -r .aid)
                        echo -e "${GREEN}      Sub-Agent AID: $SUB_AID${NC}"
                        echo -e "${GREEN}      Trust Chain: OOR → $PARENT_AGENT → $SUB_ALIAS${NC}"
                    fi
                    echo ""
                    
                    # Resolve OOBIs for sub-agent
                    echo -e "${BLUE}    → Resolving OOBIs for sub-agent...${NC}"
                    
                    # Resolve QVI OOBI
                    if [ -f "./task-scripts/subagent/subagent-oobi-resolve-qvi.sh" ]; then
                        chmod +x ./task-scripts/subagent/subagent-oobi-resolve-qvi.sh
                        ./task-scripts/subagent/subagent-oobi-resolve-qvi.sh "$SUB_ALIAS"
                    fi
                    
                    # Resolve LE OOBI
                    if [ -f "./task-scripts/subagent/subagent-oobi-resolve-le.sh" ]; then
                        LE_ALIAS=$(jq -r ".organizations[$org_idx].alias" "$CONFIG_FILE")
                        chmod +x ./task-scripts/subagent/subagent-oobi-resolve-le.sh
                        ./task-scripts/subagent/subagent-oobi-resolve-le.sh "$SUB_ALIAS" "$LE_ALIAS"
                    fi
                    
                    # Resolve verifier OOBI
                    if [ -f "./task-scripts/subagent/subagent-oobi-resolve-verifier.sh" ]; then
                        chmod +x ./task-scripts/subagent/subagent-oobi-resolve-verifier.sh
                        ./task-scripts/subagent/subagent-oobi-resolve-verifier.sh "$SUB_ALIAS"
                    fi
                    
                    echo -e "${GREEN}    ✓ OOBIs resolved for sub-agent${NC}"
                    echo ""
                    
                    # Verify sub-delegation via Sally
                    echo -e "${BLUE}    → Verifying sub-delegation via Sally...${NC}"
                    
                    # The success line MUST live inside the success branch.
                    # It used to sit after the whole if-block and printed
                    # unconditionally - a green tick that could never be red,
                    # even when the verify script was missing entirely.
                    if [ -f "./task-scripts/subagent/subagent-verify-delegation.sh" ]; then
                        chmod +x ./task-scripts/subagent/subagent-verify-delegation.sh
                        if ./task-scripts/subagent/subagent-verify-delegation.sh "$SUB_ALIAS" "$PARENT_AGENT"; then
                            echo -e "${GREEN}    ✓ Sub-delegation verified by Sally${NC}"
                        else
                            echo -e "${YELLOW}    ⚠ Sub-delegation NOT verified by Sally (non-fatal)${NC}"
                            echo -e "${YELLOW}      The delegation itself succeeded; Sally could not confirm it.${NC}"
                        fi
                    else
                        echo -e "${YELLOW}    ⚠ Sub-delegation NOT verified: verify script missing${NC}"
                        echo -e "${YELLOW}      ./task-scripts/subagent/subagent-verify-delegation.sh${NC}"
                    fi
                    echo ""
                    
                done
            fi
        done
    done
done

################################################################################
# Phase 4: Trust Tree Visualization
################################################################################

echo -e "${YELLOW}[4/5] Generating extended trust tree visualization...${NC}"
echo ""

TRUST_TREE_FILE="./task-data/trust-tree-buyerseller-4D-with-subdelegation.txt"

cat > "$TRUST_TREE_FILE" << 'EOF'
╔══════════════════════════════════════════════════════════════════════════════╗
║     vLEI Trust Chain - With SUB-DELEGATION (v4D)                            ║
║     Configuration-Driven System with Agent → Sub-Agent Delegation           ║
╚══════════════════════════════════════════════════════════════════════════════╝

ROOT (GLEIF External AID)
│
├─ QVI (Qualified vLEI Issuer)
│   │
│   ├─ QVI Credential (issued by GLEIF ROOT)
│   │   └─ Presented to Sally Verifier ✓
│   │
│   ├─── JUPITER KNITTING COMPANY (Seller)
│   │     LEI: 3358004DXAMRWRUIYJ05
│   │     │
│   │     ├─ LE Credential (issued by QVI)
│   │     │   └─ Presented to Sally Verifier ✓
│   │     │
│   │     └─ Chief Sales Officer
│   │         │
│   │         ├─ OOR_AUTH Credential (issued by LE to QVI)
│   │         │   └─ Admitted by QVI ✓
│   │         │
│   │         ├─ OOR Credential (issued by QVI to Person)
│   │         │   ├─ Chained to: LE Credential
│   │         │   └─ Presented to Sally Verifier ✓
│   │         │
│   │         └─ ✨ Delegated Agent: jupiterSellerAgent (AI Agent)
│   │             ├─ ✨ Unique BRAN (256-bit cryptographic seed)
│   │             ├─ ✨ Unique AID (derived from agent's BRAN)
│   │             ├─ Agent AID Delegated from OOR Holder
│   │             ├─ KEL Seal (Anchored in OOR Holder's KEL)
│   │             ├─ OOBI Resolved (QVI, LE, Sally)
│   │             ├─ ✓ Verified by Sally Verifier
│   │             │
│   │             ├─ 📄 INVOICE CREDENTIAL REGISTRY
│   │             │   └─ jupiterSellerAgent_INVOICE_REGISTRY
│   │             │
│   │             ├─ 📝 SELF-ATTESTED INVOICE CREDENTIAL
│   │             │   ├─ Issuer: jupiterSellerAgent (self)
│   │             │   ├─ Issuee: jupiterSellerAgent (same as issuer)
│   │             │   ├─ Type: Self-Attested (no OOR chain edge)
│   │             │   └─ 📤 IPEX GRANT → tommyBuyerAgent
│   │             │
│   │             └─ 🔗 SUB-DELEGATED AGENT: JupiterTreasuryAgent (v4D NEW)
│   │                 ├─ ✨ Unique BRAN (256-bit cryptographic seed)
│   │                 ├─ ✨ Unique AID (derived from sub-agent's BRAN)
│   │                 ├─ Sub-Agent AID Delegated from jupiterSellerAgent
│   │                 ├─ KEL Seal (Anchored in jupiterSellerAgent's KEL)
│   │                 ├─ OOBI Resolved (QVI, LE, Sally)
│   │                 ├─ ✓ Verified by Sally Verifier
│   │                 ├─ Scope: treasury_operations
│   │                 ├─ Can Delegate: false
│   │                 │
│   │                 └─ Trust Chain:
│   │                     OOR Holder → jupiterSellerAgent → JupiterTreasuryAgent
│   │
│   └─── TOMMY HILFIGER EUROPE B.V. (Buyer)
│         LEI: 54930012QJWZMYHNJW95
│         │
│         ├─ LE Credential (issued by QVI)
│         │   └─ Presented to Sally Verifier ✓
│         │
│         └─ Chief Procurement Officer
│             │
│             ├─ OOR_AUTH Credential (issued by LE to QVI)
│             │   └─ Admitted by QVI ✓
│             │
│             ├─ OOR Credential (issued by QVI to Person)
│             │   ├─ Chained to: LE Credential
│             │   └─ Presented to Sally Verifier ✓
│             │
│             └─ ✨ Delegated Agent: tommyBuyerAgent (AI Agent)
│                 ├─ ✨ Unique BRAN (256-bit cryptographic seed)
│                 ├─ ✨ Unique AID (derived from agent's BRAN)
│                 ├─ Agent AID Delegated from OOR Holder
│                 ├─ KEL Seal (Anchored in OOR Holder's KEL)
│                 ├─ OOBI Resolved (QVI, LE, Sally)
│                 ├─ ✓ Verified by Sally Verifier
│                 │
│                 └─ 📥 IPEX ADMIT
│                     └─ Admitted invoice credential from jupiterSellerAgent

╔══════════════════════════════════════════════════════════════════════════════╗
║                        Sub-Delegation Flow (v4D NEW)                         ║
╚══════════════════════════════════════════════════════════════════════════════╝

9. ✨ NEW: Agent-to-Agent Sub-Delegation
   ├─ jupiterSellerAgent creates sub-agent AID for JupiterTreasuryAgent
   │   ├─ Uses unique BRAN for JupiterTreasuryAgent
   │   ├─ Requests delegation from jupiterSellerAgent (parent)
   │   └─ Parent agent must have canDelegate: true permission
   │
   ├─ jupiterSellerAgent approves sub-delegation
   │   ├─ Creates delegation seal in jupiterSellerAgent's KEL
   │   ├─ Seal contains: {i: sub_aid, s: '0', d: sub_aid}
   │   └─ Anchors sub-agent's inception event
   │
   ├─ JupiterTreasuryAgent completes delegation
   │   ├─ Resolves parent agent's OOBI
   │   ├─ Queries parent key state to find anchor
   │   └─ Gets endpoint role and OOBI
   │
   └─ Trust Chain Verified
       ├─ OOR Holder (Jupiter_Chief_Sales_Officer)
       │   ↓ delegates to
       ├─ Parent Agent (jupiterSellerAgent)
       │   ↓ sub-delegates to
       └─ Sub-Agent (JupiterTreasuryAgent)

╔══════════════════════════════════════════════════════════════════════════════╗
║                              Key Concepts                                    ║
╚══════════════════════════════════════════════════════════════════════════════╝

Primary Delegation vs Sub-Delegation:
  ✓ Primary: OOR Holder → Agent (Person delegates to agent)
  ✓ Sub: Agent → Sub-Agent (Agent delegates to another agent)
  ✓ Sub-delegation requires canDelegate: true in parent agent config
  ✓ Sub-agent scope must be narrower than or equal to parent scope

Trust Chain Verification:
  1. Verify sub-agent's delegation field (di) points to parent agent
  2. Find delegation seal in parent agent's KEL
  3. Verify seal digest matches sub-agent's inception SAID
  4. Trace back through parent agent to OOR holder to root

Permission Scoping:
  ✓ Parent: scope="sales_operations", canDelegate=true
  ✓ Sub: scope="treasury_operations", canDelegate=false
  ✓ Sub-agent cannot further delegate (canDelegate=false)

EOF

echo -e "${GREEN}✓ Trust tree visualization created: $TRUST_TREE_FILE${NC}"
echo ""

################################################################################
# Phase 4.5: Regenerate agent cards from the AIDs this run just minted
#
# WHY THIS EXISTS:
#   Every 4D run re-mints agent AIDs. Nothing used to regenerate the agent
#   cards, so the DD seller agent kept serving
#     <dd-root>/demo-agent-cards/jupiterSellerAgent-card.json
#   with a superseded delegateeAID. The header of generate-agent-cards.js
#   claimed it was "called automatically at the end of
#   run-all-buyerseller-4D-with-subdelegation.sh" - it was not. This is that
#   call.
################################################################################

echo -e "${YELLOW}[4.5/5] Regenerating agent cards from this run's AIDs...${NC}"
echo ""

if [ "$SKIP_CARDS" -eq 1 ]; then
    echo -e "${YELLOW}⚠ SKIPPED: --skip-cards was passed.${NC}"
    echo -e "${YELLOW}  Every agent card still holds the PREVIOUS run's AIDs.${NC}"
    echo ""
elif [ ! -f "./generate-agent-cards.js" ]; then
    echo -e "${RED}✗ ERROR: ./generate-agent-cards.js not found${NC}"
    exit 1
elif ! command -v node >/dev/null 2>&1; then
    echo -e "${RED}✗ ERROR: node is not on PATH - cannot regenerate agent cards.${NC}"
    echo -e "${RED}  The AIDs minted by this run would not reach any agent card.${NC}"
    exit 1
else
    CARD_ARGS=()
    if [ -n "$CONFIG_4D" ]; then
        CARD_ARGS+=(--config "$CONFIG_4D" --per-officer-oor)
        echo -e "${BLUE}  config: $CONFIG_4D (per-officer OOR SAIDs)${NC}"
    fi
    if [ -n "$DD_ROOT" ]; then
        CARD_ARGS+=(--dd-root "$DD_ROOT")
        echo -e "${BLUE}  dd-root: $DD_ROOT${NC}"
    else
        echo -e "${YELLOW}  ⚠ No --dd-root given and DD_ROOT is unset.${NC}"
        echo -e "${YELLOW}    Cards will be written inside vLEIEnh1 only. NO DynDiscounting${NC}"
        echo -e "${YELLOW}    agent will see the AIDs this run just minted.${NC}"
        echo -e "${YELLOW}    Re-run with: $0 --dd-root <path-to-DynDisc .../A2A/js>${NC}"
    fi
    echo ""

    # set -e is active: a non-zero exit here aborts the script, so the ✓ below
    # is only ever reached on real success.
    # Re-enter the working dir by path first: a stale cwd reference makes Node
    # die at startup with "ENOENT ... uv_cwd" even though the folder exists.
    cd "$PWD"
    node ./generate-agent-cards.js "${CARD_ARGS[@]}"

    echo ""
    echo -e "${GREEN}✓ Agent cards regenerated${NC}"
    echo ""
fi

################################################################################
# Phase 5: Summary
################################################################################

echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║                    Execution Complete                        ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

echo -e "${GREEN}✅ vLEI System v4D Complete!${NC}"
echo ""

if [ -n "$CONFIG_4D" ]; then
    # --config-4d run: print the tree this run actually produced, built from
    # the config + task-data (every officer, agent and sub-agent), instead of
    # the fixed Jupiter-only text below.
    ORG_TREE_FILE="./task-data/trust-tree-org-4d.txt"
    node ./print-org-trust-tree.js --config "$CONFIG_4D" --task-data ./task-data --out "$ORG_TREE_FILE" \
        || echo -e "${YELLOW}⚠ print-org-trust-tree.js reported missing identities (see above)${NC}"
    echo ""
    echo -e "${BLUE}📄 Documentation:${NC}"
    echo "  • Configuration: $CONFIG_FILE"
    echo "  • Trust Tree:    $ORG_TREE_FILE"
    echo "  • Sub-Agent BRANs: task-data/subagent-brans.json"
    echo ""
    echo -e "${GREEN}✨ vLEI system 4D with sub-delegation completed successfully!${NC}"
    echo ""
    exit 0
fi

echo -e "${WHITE}✨ Sub-Delegation Summary:${NC}"
echo "  ✓ jupiterSellerAgent (parent agent) created"
echo "  ✓ JupiterTreasuryAgent (sub-agent) delegated from jupiterSellerAgent"
echo "  ✓ Trust chain verified: OOR → jupiterSellerAgent → JupiterTreasuryAgent"
echo ""

echo -e "${BLUE}📊 Delegation Hierarchy:${NC}"
if [ -f "./task-data/jupiterSellerAgent-info.json" ] && [ -f "./task-data/JupiterTreasuryAgent-info.json" ]; then
    PARENT_AID=$(jq -r '.aid' "./task-data/jupiterSellerAgent-info.json")
    SUB_AID=$(jq -r '.aid' "./task-data/JupiterTreasuryAgent-info.json")
    
    echo "  Jupiter_Chief_Sales_Officer (OOR Holder)"
    echo "    ↓ delegates to"
    echo "  jupiterSellerAgent (Parent Agent)"
    echo "    AID: $PARENT_AID"
    echo "    Scope: sales_operations"
    echo "    Can Delegate: true"
    echo "    ↓ sub-delegates to"
    echo "  JupiterTreasuryAgent (Sub-Agent)"
    echo "    AID: $SUB_AID"
    echo "    Scope: treasury_operations"
    echo "    Can Delegate: false"
fi
echo ""

echo -e "${BLUE}📋 Next Steps:${NC}"
echo "  1. Verify sub-delegation: ./DEEP-EXT-subagent.sh JupiterTreasuryAgent jupiterSellerAgent"
echo "  2. Test sub-agent operations (treasury management)"
echo "  3. Implement sub-agent-specific credentials"
echo ""

echo -e "${BLUE}📄 Documentation:${NC}"
echo "  • Configuration: $CONFIG_FILE"
echo "  • Trust Tree: $TRUST_TREE_FILE"
echo "  • Sub-Agent BRANs: task-data/subagent-brans.json"
echo ""

# Display trust tree
cat "$TRUST_TREE_FILE"
echo ""

echo -e "${GREEN}✨ vLEI system 4D with sub-delegation completed successfully!${NC}"
echo ""

exit 0
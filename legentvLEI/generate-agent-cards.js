#!/usr/bin/env node

/**
 * Agent Card Generator
 * 
 * Generates complete agent cards from vLEI workflow output data.
 * This script reads the generated JSON files from task-data/
 * to produce agent cards with real AIDs from the 4D workflow.
 * 
 * Key fields for DEEP-EXT verification:
 *   - vLEImetadata.agentName: Used as parameter for DEEP-EXT.sh
 *   - vLEImetadata.oorHolderName: Used as parameter for DEEP-EXT.sh
 * 
 * Outputs to up to THREE directories:
 *   1. <--legent-out>  — generated from scratch
 *                        default: ../Legent/A2A/agent-cards
 *   2. <--a2a-out>     — updates existing cards in-place (preserves format)
 *                        default: ../A2A/js/agent-cards
 *   3. <--dd-root>/<--cards-subdir>
 *                      — DISABLED unless --dd-root is passed. This is the only
 *                        output that a running DynDiscounting agent actually
 *                        reads. Both defaults above live inside vLEIEnh1 and
 *                        have never reached the DynDisc tree.
 *
 * Handles sub-agents (e.g., JupiterTreasuryAgent) from the subdelegation config.
 *
 * FLAGS (all optional; with no flags the behaviour is identical to the
 *        pre-flag version of this script):
 *   --config <path>        Agent config JSON.
 *                          default: <script-dir>/appconfig/
 *                                   configBuyerSellerAIAgent1-with-subdelegation.json
 *   --task-data <path>     Where *-info.json are read from.
 *                          default: <script-dir>/task-data
 *   --legent-out <path>    From-scratch card output dir.
 *                          default: <script-dir>/../Legent/A2A/agent-cards
 *   --a2a-out <path>       In-place update dir.
 *                          default: <script-dir>/../A2A/js/agent-cards
 *   --dd-root <path>       Root of the DynDiscounting A2A/js tree, e.g.
 *                          C:/SATHYA/CHAINAIM3003/mcp-servers/FINAGENTS/
 *                            FINAGENTS1/DynDiscProject5/A2A/js
 *                          SAME MEANING as --dd-root in
 *                          generate-unique-agent-brans.sh: it points at the
 *                          A2A/js directory itself, NOT at the project root.
 *                          default: unset -> no DD card is written at all.
 *   --cards-subdir <rel>   Live card dir relative to --dd-root.
 *                          default: live-agent-cards
 *   --seed-from <rel>      Dir (relative to --dd-root) to seed a brand-new live
 *                          card from, so a first run inherits the real service
 *                          url/provider/skills instead of the marketing
 *                          placeholders in the from-scratch template.
 *                          default: demo-agent-cards
 *   --no-seed              Disable seeding. A missing live card is then written
 *                          from the from-scratch template, with a loud warning
 *                          that its "url" is a placeholder.
 *   --skip-dd-root-check   Do not assert that <dd-root>/src/agents exists.
 *   --per-officer-oor      Read delegatorSAID from
 *                          <task-data>/<personAlias>-oor-credential-info.json
 *                          (written by 4C per officer) instead of the shared
 *                          oor-credential-info.json, which holds only the last
 *                          officer's credential.
 *                          default: off -> shared file, as before.
 *   Optional "card" block on an agent / sub-agent in the config
 *   ({ name, description, url, skills }): each key present replaces the
 *   template text in the from-scratch card. Without it: template, as before.
 *   "url": null means the agent has no service yet (no placeholder URL).
 *   On a sub-agent, "officialRole" / "engagementRole" replace the
 *   gleifIdentity template values (default: ChiefFinancialOfficer /
 *   Treasury Agent).
 *   --dry-run              Print everything, write nothing.
 *   -h | --help            Show this help.
 *
 * WHY live-agent-cards AND NOT demo-agent-cards:
 *   The DD agents resolve their own card in this order (see resolveCardPath()
 *   in <dd-root>/src/agents/<role>-agent/index.ts):
 *       <dd-root>/live-agent-cards/<alias>-card.json   <- first
 *       <dd-root>/demo-agent-cards/<alias>-card.json   <- fallback
 *       <dd-root>/agent-cards/<alias>-card.json        <- legacy
 *   live- wins the lookup and the code calls it "customer onboarded", so the
 *   freshly-minted AIDs belong there. demo-agent-cards/ is source-controlled
 *   and is deliberately left untouched as the fallback.
 *
 * Usage:
 *   node generate-agent-cards.js
 *   node generate-agent-cards.js --dd-root /path/to/DynDiscProject5/A2A/js
 *   node generate-agent-cards.js --dd-root ... --dry-run
 */

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;

// ═══════════════════════════════════════════════════════════════
// CLI argument parsing
//
// Defaults are built from SCRIPT_DIR (absolute) so that running the script
// from any cwd reproduces the previous hardcoded behaviour exactly.
// User-supplied relative paths resolve against process.cwd(), which is the
// conventional expectation for a CLI flag.
// ═══════════════════════════════════════════════════════════════

function usage() {
  const src = fs.readFileSync(__filename, 'utf8').split(/\r?\n/);
  const end = src.findIndex((l) => l.trim() === '*/');
  console.log(src.slice(0, end + 1).join('\n'));
  process.exit(0);
}

function fail(msg) {
  console.error(`✗ ERROR: ${msg}`);
  process.exit(1);
}

const argv = process.argv.slice(2);
const opts = {
  config:      null,
  taskData:    null,
  legentOut:   null,
  a2aOut:      null,
  ddRoot:      null,
  cardsSubdir: 'live-agent-cards',
  seedFrom:    'demo-agent-cards',
  seed:        true,
  ddRootCheck: true,
  dryRun:      false,
  perOfficerOor: false,
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const needsValue = () => {
    if (i + 1 >= argv.length) fail(`${a} requires a value`);
    return argv[++i];
  };
  switch (a) {
    case '--config':             opts.config      = needsValue(); break;
    case '--task-data':          opts.taskData    = needsValue(); break;
    case '--legent-out':         opts.legentOut   = needsValue(); break;
    case '--a2a-out':            opts.a2aOut      = needsValue(); break;
    case '--dd-root':            opts.ddRoot      = needsValue(); break;
    case '--cards-subdir':       opts.cardsSubdir = needsValue(); break;
    case '--seed-from':          opts.seedFrom    = needsValue(); break;
    case '--no-seed':            opts.seed        = false; break;
    case '--skip-dd-root-check': opts.ddRootCheck = false; break;
    case '--dry-run':            opts.dryRun      = true;  break;
    case '--per-officer-oor':    opts.perOfficerOor = true; break;
    case '-h':
    case '--help':               usage(); break;
    default:
      fail(`unknown argument: ${a}\n  Run 'node ${path.basename(__filename)} --help' for usage.`);
  }
}

const resolveArg = (v, dflt) => (v ? path.resolve(process.cwd(), v) : dflt);

const CONFIG_FILE = resolveArg(
  opts.config,
  path.join(SCRIPT_DIR, 'appconfig', 'configBuyerSellerAIAgent1-with-subdelegation.json')
);
const TASK_DATA_DIR = resolveArg(opts.taskData, path.join(SCRIPT_DIR, 'task-data'));

// Output directory 1: Legent/A2A/agent-cards (generated from scratch)
const OUTPUT_DIR = resolveArg(opts.legentOut, path.join(SCRIPT_DIR, '..', 'Legent', 'A2A', 'agent-cards'));

// Output directory 2: A2A/js/agent-cards (update existing cards in-place)
const OUTPUT_DIR_A2A = resolveArg(opts.a2aOut, path.join(SCRIPT_DIR, '..', 'A2A', 'js', 'agent-cards'));

// Output directory 3: the DynDiscounting live cards. Opt-in via --dd-root.
const DD_ROOT = opts.ddRoot ? path.resolve(process.cwd(), opts.ddRoot) : null;
const DD_CARDS_DIR = DD_ROOT ? path.resolve(DD_ROOT, opts.cardsSubdir) : null;
const DD_SEED_DIR = DD_ROOT && opts.seed ? path.resolve(DD_ROOT, opts.seedFrom) : null;
const DRY_RUN = opts.dryRun;

// No silent skip: if --dd-root was supplied it has to be real.
if (DD_ROOT) {
  if (!fs.existsSync(DD_ROOT)) {
    fail(`--dd-root does not exist: ${DD_ROOT}`);
  }
  if (opts.ddRootCheck && !fs.existsSync(path.join(DD_ROOT, 'src', 'agents'))) {
    const nested = path.join(DD_ROOT, 'A2A', 'js');
    let hint = '';
    if (fs.existsSync(path.join(nested, 'src', 'agents'))) {
      hint = `\n  Did you mean --dd-root ${nested} ?` +
             `\n  --dd-root points at the A2A/js tree itself, not at the project root.`;
    }
    fail(
      `--dd-root does not look like a DynDiscounting A2A/js tree.\n` +
      `  Missing: ${path.join(DD_ROOT, 'src', 'agents')}${hint}\n` +
      `  Pass --skip-dd-root-check to bypass this assertion.`
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// Write helpers — every card write goes through these so --dry-run
// is honoured in one place instead of at each call site.
// ═══════════════════════════════════════════════════════════════

function writeJson(filePath, obj) {
  if (DRY_RUN) {
    console.log(`  [dry-run] would write: ${filePath}`);
    return true;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
  return true;
}

// ═══════════════════════════════════════════════════════════════
// DynDiscounting live-card sync.
//
// A brand-new live card is SEEDED from the demo card rather than generated
// from the from-scratch template, because that template carries public
// marketing URLs (https://jupiter-agent.com/) while the DD runtime needs the
// real service URL (http://localhost:8080/). Seeding preserves url, provider,
// skills and every other non-identity field; the identity blocks are then
// overwritten in place with the live values from task-data.
//
// updateFn(livePath) -> boolean, supplied by the caller so that agents and
// sub-agents reuse the existing updateA2ACard / updateA2ASubAgentCard logic.
// ═══════════════════════════════════════════════════════════════

function syncDdCard(alias, updateFn, fallbackCard) {
  if (!DD_CARDS_DIR) return 0;

  const livePath = path.join(DD_CARDS_DIR, `${alias}-card.json`);

  if (!fs.existsSync(livePath)) {
    let seeded = false;

    if (DD_SEED_DIR) {
      const seedPath = path.join(DD_SEED_DIR, `${alias}-card.json`);
      if (fs.existsSync(seedPath)) {
        if (DRY_RUN) {
          console.log(`  [dry-run] would seed DD live card from: ${seedPath}`);
        } else {
          fs.mkdirSync(DD_CARDS_DIR, { recursive: true });
          fs.copyFileSync(seedPath, livePath);
          console.log(`  ✓ Seeded DD live card from: ${seedPath}`);
        }
        seeded = true;
      } else {
        console.warn(`  ⚠ No seed card found at: ${seedPath}`);
      }
    }

    if (!seeded) {
      if (!fallbackCard) {
        console.error(`  ✗ Cannot create DD live card for ${alias}: no seed card and no generated card.`);
        return 0;
      }
      console.warn(`  ⚠ Writing DD live card for ${alias} from the from-scratch template.`);
      console.warn(`    Its "url" is a public placeholder, NOT the DD service URL.`);
      console.warn(`    Set "url" in ${livePath} before the agent serves it.`);
      writeJson(livePath, fallbackCard);
      return 1;
    }
  }

  if (DRY_RUN) {
    console.log(`  [dry-run] would update DD live card: ${livePath}`);
    return 1;
  }

  return updateFn(livePath) ? 1 : 0;
}

// ═══════════════════════════════════════════════════════════════
// Read helpers — all read from task-data/
// ═══════════════════════════════════════════════════════════════

function readConfig() {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    console.log('✓ Configuration loaded');
    return config;
  } catch (error) {
    console.error('✗ Failed to read configuration:', error.message);
    process.exit(1);
  }
}

function readAgentInfo(agentAlias) {
  const filePath = path.join(TASK_DATA_DIR, `${agentAlias}-info.json`);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`✓ Agent info loaded: ${agentAlias}`);
    return data;
  } catch (error) {
    console.error(`✗ Failed to read agent info (${agentAlias}):`, error.message);
    return null;
  }
}

function readPersonInfo(personAlias) {
  const filePath = path.join(TASK_DATA_DIR, `${personAlias}-info.json`);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`✓ Person info loaded: ${personAlias}`);
    return data;
  } catch (error) {
    console.error(`✗ Failed to read person info (${personAlias}):`, error.message);
    return null;
  }
}

function readLEInfo(leAlias) {
  const filePath = path.join(TASK_DATA_DIR, `${leAlias}-info.json`);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`✓ LE info loaded: ${leAlias}`);
    return data;
  } catch (error) {
    console.error(`✗ Failed to read LE info (${leAlias}):`, error.message);
    return null;
  }
}

function readOORCredentialInfo() {
  const filePath = path.join(TASK_DATA_DIR, 'oor-credential-info.json');
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log('✓ OOR credential info loaded');
    return data;
  } catch (error) {
    console.error('✗ Failed to read OOR credential info:', error.message);
    return null;
  }
}

// --per-officer-oor: the OOR credential of THIS agent's officer.
// Without the flag: the shared file (previous behaviour).
function readOORCredentialInfoFor(personAlias, sharedOorCredInfo) {
  if (!opts.perOfficerOor) return sharedOorCredInfo;
  const filePath = path.join(TASK_DATA_DIR, `${personAlias}-oor-credential-info.json`);
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log(`✓ OOR credential info loaded: ${personAlias}`);
    return data;
  } catch (error) {
    console.error(`✗ Failed to read per-officer OOR credential info (${personAlias}):`, error.message);
    return null;
  }
}

// Optional config "card" block: each key present replaces the template value.
function applyCardOverrides(card, override, alias) {
  if (!override) return card;
  for (const key of ['name', 'description', 'url', 'skills']) {
    if (override[key] !== undefined) card[key] = override[key];
  }
  if (override.url === undefined) {
    console.warn(`  ⚠ ${alias}: config card has no "url"; the card keeps the template URL (${card.url}), which is a placeholder for this agent.`);
  }
  return card;
}

function readQVIInfo() {
  const filePath = path.join(TASK_DATA_DIR, 'qvi-info.json');
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    console.log('✓ QVI info loaded');
    return data;
  } catch (error) {
    console.error('✗ Failed to read QVI info:', error.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// Generate agent card from scratch (for Legent/A2A/agent-cards)
// ═══════════════════════════════════════════════════════════════

function generateAgentCard(config, org, person, agent) {
  console.log(`\n→ Generating agent card for: ${agent.alias}`);
  
  const agentInfo = readAgentInfo(agent.alias);
  const personInfo = readPersonInfo(person.alias);
  const leInfo = readLEInfo(org.alias);
  const oorCredInfo = opts.perOfficerOor
    ? readOORCredentialInfoFor(person.alias, null)
    : readOORCredentialInfo();
  const qviInfo = readQVIInfo();
  
  if (!agentInfo || !personInfo || !leInfo) {
    console.error(`✗ Missing required data for ${agent.alias}`);
    return null;
  }
  
  const isJupiter = org.id === 'jupiter';
  
  const agentCard = {
    name: isJupiter ? "Jupiter Seller Agent" : "Tommy Buyer Agent",
    description: isJupiter 
      ? "Autonomous AI agent responsible for initiating, negotiating, and managing sales orders for JUPITER KNITTING COMPANY."
      : "AI agent responsible for submitting, negotiating, and tracking purchase orders for TOMMY HILFIGER EUROPE B.V.",
    url: isJupiter ? "https://jupiter-agent.com/" : "https://tommy-agent.com/",
    provider: {
      organization: org.name,
      url: isJupiter ? "https://jupiterknitting.com" : "https://tommyhilfiger.com"
    },
    version: "1.0.0",
    capabilities: {
      streaming: true,
      stateTransitionHistory: true
    },
    skills: isJupiter ? [
      {
        id: "procurement_management",
        name: "Procurement Management",
        description: "Collaborates with verified buyer agents to review incoming trade requirements, evaluate purchase requests, and align production capacity with order feasibility. Ensures all interactions occur within verified GLEIF trust boundaries.",
        tags: ["seller", "procurement", "verification", "gleif", "trade", "compliance"]
      },
      {
        id: "purchase_order_management",
        name: "Purchase Order Management",
        description: "Receives and processes purchase orders from verified buyer agents. Confirms order terms, delivery schedules, and initiates production after GLEIF credential validation.",
        tags: ["seller", "sales", "purchase-order", "gleif", "automation", "order-processing"]
      },
      {
        id: "invoice_approval",
        name: "Invoice Approval & Dispatch",
        description: "Generates and approves digital invoices for completed or approved purchase orders. Ensures all invoices include embedded vLEI credentials and adhere to traceability standards.",
        tags: ["seller", "finance", "invoice", "verification", "traceability", "gleif"]
      },
      {
        id: "payment_authorization",
        name: "Payment Authorization & Reconciliation",
        description: "Validates incoming payment confirmations from buyer agents, authenticates transaction credentials, and updates order fulfillment status in coordination with verified payment channels.",
        tags: ["seller", "payment", "authentication", "finance", "gleif", "compliance"]
      }
    ] : [
      {
        id: "procurement_management",
        name: "Procurement Management",
        description: "Oversees the complete procurement lifecycle — from identifying verified seller agents and evaluating proposals to finalizing trade agreements. Ensures that all counterparties are GLEIF-verified and contract terms align with buyer requirements.",
        tags: ["buyer", "procurement", "trade", "negotiation", "gleif", "compliance"]
      },
      {
        id: "purchase_order",
        name: "Purchase Order Management",
        description: "Manages procurement negotiations, evaluates offers, and finalizes trade requirements.",
        tags: ["buyer", "procurement", "trade"]
      },
      {
        id: "Invoice_Approval",
        name: "Invoice Approval",
        description: "Manages procurement negotiations, evaluates offers, and finalizes trade requirements.",
        tags: ["buyer", "procurement", "trade"]
      },
      {
        id: "Payment_Authentication",
        name: "Payment Authentication",
        description: "Manages procurement negotiations, evaluates offers, and finalizes trade requirements.",
        tags: ["buyer", "procurement", "trade"]
      }
    ],
    extensions: {
      gleifIdentity: {
        lei: org.lei,
        legalEntityName: org.name,
        registryName: org.registryName,
        qvi: qviInfo ? qviInfo.aid : "QVI_AID_PLACEHOLDER"
      },
      vLEImetadata: {
        agentName: agent.alias,
        oorHolderName: person.alias,
        delegatorAID: personInfo.aid,
        delegateeAID: agentInfo.aid,
        delegatorSAID: oorCredInfo ? oorCredInfo.said : "CREDENTIAL_SAID_PLACEHOLDER",
        delegateeSAID: agentInfo.aid,
        delegatorOOBI: personInfo.oobi,
        delegateeOOBI: agentInfo.oobi,
        leAID: leInfo.aid,
        leOOBI: leInfo.oobi,
        verificationPath: [
          "GLEIF_ROOT → QVI",
          `QVI → ${org.name} → ${person.legalName} → ${agent.alias}`
        ]
      },
      gleifVerification: {
        gleifVerificationEndpoint: `https://gleif.org/api/v1/lei/${org.lei}`
      },
      keriIdentifiers: {
        agentAID: agentInfo.aid,
        oorHolderAID: personInfo.aid,
        legalEntityAID: leInfo.aid,
        qviAID: qviInfo ? qviInfo.aid : "QVI_AID_PLACEHOLDER"
      }
    }
  };
  
  console.log(`✓ Agent card generated for ${agent.alias}`);
  console.log(`  agentName: ${agent.alias}`);
  console.log(`  oorHolderName: ${person.alias}`);
  console.log(`  Agent AID: ${agentInfo.aid}`);
  console.log(`  Delegator AID: ${personInfo.aid}`);
  console.log(`  LEI: ${org.lei}`);

  return applyCardOverrides(agentCard, agent.card, agent.alias);
}

// ═══════════════════════════════════════════════════════════════
// Update existing A2A card in-place (preserves format)
// Only touches extensions.keriIdentifiers, extensions.vLEImetadata,
// and extensions.gleifIdentity.qvi — everything else stays as-is.
// ═══════════════════════════════════════════════════════════════

function updateA2ACard(cardPath, agentInfo, personInfo, leInfo, qviInfo, oorCredInfo, org, person, agent) {
  try {
    const existingCard = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    console.log(`  ✓ Read existing A2A card: ${cardPath}`);

    // Update keriIdentifiers
    if (!existingCard.extensions) existingCard.extensions = {};

    existingCard.extensions.keriIdentifiers = {
      agentAID:        agentInfo.aid,
      oorHolderAID:    personInfo.aid,
      legalEntityAID:  leInfo.aid,
      qviAID:          qviInfo ? qviInfo.aid : "QVI_AID_PLACEHOLDER"
    };

    // Update vLEImetadata — preserve existing fields like status, verificationEndpoint, timestamp
    const existingMeta = existingCard.extensions.vLEImetadata || {};
    existingCard.extensions.vLEImetadata = {
      ...existingMeta,
      agentName:        agent.alias,
      oorHolderName:    person.alias,
      delegatorAID:     personInfo.aid,
      delegateeAID:     agentInfo.aid,
      delegatorSAID:    oorCredInfo ? oorCredInfo.said : (existingMeta.delegatorSAID || "CREDENTIAL_SAID_PLACEHOLDER"),
      delegateeSAID:    agentInfo.aid,
      delegatorOOBI:    personInfo.oobi,
      delegateeOOBI:    agentInfo.oobi,
      leAID:            leInfo.aid,
      leOOBI:           leInfo.oobi,
      verificationPath: [
        "GLEIF_ROOT → QVI",
        `QVI → ${org.name} → ${person.legalName} → ${agent.alias}`
      ],
      timestamp:        new Date().toISOString()
    };

    // Update gleifIdentity.qvi only — preserve officialRole, engagementRole, etc.
    if (existingCard.extensions.gleifIdentity) {
      existingCard.extensions.gleifIdentity.qvi = qviInfo ? qviInfo.aid : existingCard.extensions.gleifIdentity.qvi;
    }

    writeJson(cardPath, existingCard);
    if (!DRY_RUN) console.log(`  ✓ Updated A2A card: ${cardPath}`);
    return true;

  } catch (error) {
    console.error(`  ✗ Failed to update A2A card ${cardPath}: ${error.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Update existing A2A card for sub-agent (treasury) in-place.
// Adds vLEImetadata and keriIdentifiers if they don't exist yet.
// ═══════════════════════════════════════════════════════════════

function updateA2ASubAgentCard(cardPath, subAgentInfo, parentAgentInfo, personInfo, leInfo, qviInfo, org, person, parentAgent, subAgent) {
  try {
    const existingCard = JSON.parse(fs.readFileSync(cardPath, 'utf8'));
    console.log(`  ✓ Read existing A2A sub-agent card: ${cardPath}`);

    if (!existingCard.extensions) existingCard.extensions = {};

    // Update keriIdentifiers — add parentAgentAID for sub-delegation chain
    existingCard.extensions.keriIdentifiers = {
      agentAID:        subAgentInfo.aid,
      parentAgentAID:  parentAgentInfo.aid,
      oorHolderAID:    personInfo.aid,
      legalEntityAID:  leInfo.aid,
      qviAID:          qviInfo ? qviInfo.aid : "QVI_AID_PLACEHOLDER"
    };

    // Add publicKey if available from task-data
    if (subAgentInfo.publicKey) {
      existingCard.extensions.keriIdentifiers.publicKey = subAgentInfo.publicKey;
    }

    // Update vLEImetadata — sub-delegation: delegator is the PARENT AGENT, not OOR holder
    const existingMeta = existingCard.extensions.vLEImetadata || {};
    existingCard.extensions.vLEImetadata = {
      ...existingMeta,
      agentName:        subAgent.alias,
      oorHolderName:    person.alias,
      parentAgentName:  parentAgent.alias,
      isSubDelegation:  true,
      scope:            subAgent.permissions ? subAgent.permissions.scope : "treasury_operations",
      canDelegate:      subAgent.permissions ? subAgent.permissions.canDelegate : false,
      delegatorAID:     parentAgentInfo.aid,
      delegateeAID:     subAgentInfo.aid,
      delegatorOOBI:    parentAgentInfo.oobi,
      delegateeOOBI:    subAgentInfo.oobi,
      oorHolderAID:     personInfo.aid,
      oorHolderOOBI:    personInfo.oobi,
      leAID:            leInfo.aid,
      leOOBI:           leInfo.oobi,
      verificationPath: [
        "GLEIF_ROOT → QVI",
        `QVI → ${org.name} → ${person.legalName} → ${parentAgent.alias} → ${subAgent.alias}`
      ],
      timestamp:        new Date().toISOString()
    };

    // Update gleifIdentity.qvi — preserve officialRole, engagementRole, etc.
    if (existingCard.extensions.gleifIdentity) {
      existingCard.extensions.gleifIdentity.qvi = qviInfo ? qviInfo.aid : existingCard.extensions.gleifIdentity.qvi;
    }

    writeJson(cardPath, existingCard);
    if (!DRY_RUN) console.log(`  ✓ Updated A2A sub-agent card: ${cardPath}`);
    return true;

  } catch (error) {
    console.error(`  ✗ Failed to update A2A sub-agent card ${cardPath}: ${error.message}`);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// Generate sub-agent card from scratch (for Legent/A2A/agent-cards)
// ═══════════════════════════════════════════════════════════════

function generateSubAgentCard(config, org, person, parentAgent, subAgent) {
  console.log(`\n→ Generating sub-agent card for: ${subAgent.alias}`);

  const subAgentInfo    = readAgentInfo(subAgent.alias);
  const parentAgentInfo = readAgentInfo(parentAgent.alias);
  const personInfo      = readPersonInfo(person.alias);
  const leInfo          = readLEInfo(org.alias);
  const qviInfo         = readQVIInfo();

  if (!subAgentInfo || !parentAgentInfo || !personInfo || !leInfo) {
    console.error(`✗ Missing required data for sub-agent ${subAgent.alias}`);
    return null;
  }

  const subAgentCard = {
    name: "Jupiter Treasury Agent",
    description: "Autonomous treasury AI agent for JUPITER KNITTING COMPANY. Holds the company balance sheet, runs ACTUS PAM cash flow simulations, and validates whether accepting a sale at a given price is safe for liquidity before the seller commits to any deal.",
    url: "http://localhost:7070/",
    provider: {
      organization: org.name,
      url: "https://jupiterknitting.com"
    },
    version: "1.0.0",
    capabilities: {
      streaming: true,
      stateTransitionHistory: true
    },
    skills: [
      {
        id: "cash_flow_validation",
        name: "Cash Flow & Liquidity Validation",
        description: "Runs an ACTUS PAM simulation for a proposed sale: models production outflow (IED) and invoice inflow (Maturity), checks whether cash stays above the safety threshold during the Net-30 gap, computes working-capital financing cost, and calculates NPV at the hurdle rate.",
        tags: ["treasury", "actus", "cashflow", "liquidity", "risk", "simulation"]
      },
      {
        id: "balance_management",
        name: "Balance Sheet Management",
        description: "Maintains the real-time balance sheet of Jupiter Knitting Company including current cash, pending outflows for committed orders, and available free liquidity.",
        tags: ["treasury", "balance", "finance", "accounting"]
      },
      {
        id: "minimum_price_advisory",
        name: "Minimum Viable Price Advisory",
        description: "When a proposed sale price fails the treasury check, computes the minimum price that restores NPV-positivity and cash safety, enabling the seller agent to counter at the correct floor.",
        tags: ["treasury", "pricing", "advisory", "npv", "risk"]
      }
    ],
    extensions: {
      gleifIdentity: {
        lei: org.lei,
        legalEntityName: org.name,
        registryName: org.registryName,
        qvi: qviInfo ? qviInfo.aid : "QVI_AID_PLACEHOLDER",
        // Optional per-sub-agent override from the config "card" block;
        // without it the template values stay exactly as before.
        officialRole: (subAgent.card && subAgent.card.officialRole) || "ChiefFinancialOfficer",
        engagementRole: (subAgent.card && subAgent.card.engagementRole) || "Treasury Agent"
      },
      vLEImetadata: {
        agentName:        subAgent.alias,
        oorHolderName:    person.alias,
        parentAgentName:  parentAgent.alias,
        isSubDelegation:  true,
        scope:            subAgent.permissions ? subAgent.permissions.scope : "treasury_operations",
        canDelegate:      subAgent.permissions ? subAgent.permissions.canDelegate : false,
        delegatorAID:     parentAgentInfo.aid,
        delegateeAID:     subAgentInfo.aid,
        delegatorOOBI:    parentAgentInfo.oobi,
        delegateeOOBI:    subAgentInfo.oobi,
        oorHolderAID:     personInfo.aid,
        oorHolderOOBI:    personInfo.oobi,
        leAID:            leInfo.aid,
        leOOBI:           leInfo.oobi,
        verificationPath: [
          "GLEIF_ROOT → QVI",
          `QVI → ${org.name} → ${person.legalName} → ${parentAgent.alias} → ${subAgent.alias}`
        ],
        timestamp:        new Date().toISOString()
      },
      gleifVerification: {
        gleifVerificationEndpoint: `https://gleif.org/api/v1/lei/${org.lei}`
      },
      keriIdentifiers: {
        agentAID:        subAgentInfo.aid,
        parentAgentAID:  parentAgentInfo.aid,
        oorHolderAID:    personInfo.aid,
        legalEntityAID:  leInfo.aid,
        qviAID:          qviInfo ? qviInfo.aid : "QVI_AID_PLACEHOLDER",
        publicKey:       subAgentInfo.publicKey || undefined
      }
    }
  };

  console.log(`✓ Sub-agent card generated for ${subAgent.alias}`);
  console.log(`  agentName: ${subAgent.alias}`);
  console.log(`  parentAgent: ${parentAgent.alias}`);
  console.log(`  Sub-Agent AID: ${subAgentInfo.aid}`);
  console.log(`  Parent Agent AID (delegator): ${parentAgentInfo.aid}`);
  console.log(`  OOR Holder: ${person.alias}`);
  console.log(`  LEI: ${org.lei}`);
  console.log(`  isSubDelegation: true`);

  return applyCardOverrides(subAgentCard, subAgent.card, subAgent.alias);
}

// ═══════════════════════════════════════════════════════════════
// Main execution
// ═══════════════════════════════════════════════════════════════

function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  vLEI Agent Card Generator');
  console.log(`  Script location: ${SCRIPT_DIR}`);
  console.log(`  Output (Legent): ${OUTPUT_DIR}`);
  console.log(`  Output (A2A):    ${OUTPUT_DIR_A2A}`);
  console.log(`  Output (DD live):${DD_CARDS_DIR ? ' ' + DD_CARDS_DIR : ' (disabled — pass --dd-root)'}`);
  if (DD_CARDS_DIR) console.log(`  DD seed dir:     ${DD_SEED_DIR || '(disabled via --no-seed)'}`);
  if (DRY_RUN)      console.log(`  MODE:            --dry-run (nothing will be written)`);
  console.log('═══════════════════════════════════════════════\n');
  
  // Ensure output directories exist
  if (!DRY_RUN) {
    for (const d of [OUTPUT_DIR, OUTPUT_DIR_A2A, DD_CARDS_DIR].filter(Boolean)) {
      if (!fs.existsSync(d)) {
        fs.mkdirSync(d, { recursive: true });
        console.log(`✓ Created output directory: ${d}`);
      }
    }
  }
  console.log('');
  
  // Load configuration
  const config = readConfig();
  
  // Pre-read shared data once
  const oorCredInfo = readOORCredentialInfo();
  const qviInfo     = readQVIInfo();
  
  let generatedCount = 0;
  let updatedCount   = 0;
  let ddCount        = 0;
  
  // Process each organization
  for (const org of config.organizations) {
    console.log(`\n─────────────────────────────────────────────`);
    console.log(`Processing: ${org.name}`);
    console.log(`─────────────────────────────────────────────`);
    
    for (const person of org.persons) {
      if (!person.agents || person.agents.length === 0) continue;

      for (const agent of person.agents) {
        // ── 1. Generate from scratch → Legent/A2A/agent-cards ────────
        const agentCard = generateAgentCard(config, org, person, agent);
        
        if (agentCard) {
          const outputFile = path.join(OUTPUT_DIR, `${agent.alias}-card.json`);
          writeJson(outputFile, agentCard);
          if (!DRY_RUN) console.log(`✓ Agent card saved: ${outputFile}`);
          generatedCount++;
        }
        
        // ── 2. Update existing card in-place → A2A/js/agent-cards ────
        const a2aCardPath = path.join(OUTPUT_DIR_A2A, `${agent.alias}-card.json`);
        if (fs.existsSync(a2aCardPath)) {
          const agentInfo  = readAgentInfo(agent.alias);
          const personInfo = readPersonInfo(person.alias);
          const leInfo     = readLEInfo(org.alias);
          if (agentInfo && personInfo && leInfo) {
            const ok = updateA2ACard(a2aCardPath, agentInfo, personInfo, leInfo, qviInfo, readOORCredentialInfoFor(person.alias, oorCredInfo), org, person, agent);
            if (ok) updatedCount++;
          }
        } else {
          // No existing A2A card — write the generated one as a new file
          if (agentCard) {
            writeJson(a2aCardPath, agentCard);
            if (!DRY_RUN) console.log(`✓ New A2A card created: ${a2aCardPath}`);
            updatedCount++;
          }
        }

        // ── 2b. Sync DynDiscounting live card → <dd-root>/<cards-subdir> ──
        //  This is the output the running DD agent actually serves.
        if (DD_CARDS_DIR) {
          const agentInfo  = readAgentInfo(agent.alias);
          const personInfo = readPersonInfo(person.alias);
          const leInfo     = readLEInfo(org.alias);
          if (agentInfo && personInfo && leInfo) {
            const agentOorCredInfo = readOORCredentialInfoFor(person.alias, oorCredInfo);
            ddCount += syncDdCard(
              agent.alias,
              (livePath) => updateA2ACard(
                livePath, agentInfo, personInfo, leInfo, qviInfo, agentOorCredInfo, org, person, agent
              ),
              agentCard
            );
          } else {
            console.error(`✗ Skipping DD live card for ${agent.alias}: missing task-data`);
          }
        }

        // ── 3. Process sub-agents ────────────────────────────────────
        if (agent.subAgents && agent.subAgents.length > 0) {
          for (const subAgent of agent.subAgents) {
            // Generate from scratch → Legent/A2A/agent-cards
            const subCard = generateSubAgentCard(config, org, person, agent, subAgent);
            if (subCard) {
              const subOutputFile = path.join(OUTPUT_DIR, `${subAgent.alias}-card.json`);
              writeJson(subOutputFile, subCard);
              if (!DRY_RUN) console.log(`✓ Sub-agent card saved: ${subOutputFile}`);
              generatedCount++;
            }

            // Update existing card in-place → A2A/js/agent-cards
            const subA2APath = path.join(OUTPUT_DIR_A2A, `${subAgent.alias}-card.json`);
            if (fs.existsSync(subA2APath)) {
              const subAgentInfo    = readAgentInfo(subAgent.alias);
              const parentAgentInfo = readAgentInfo(agent.alias);
              const personInfo      = readPersonInfo(person.alias);
              const leInfo          = readLEInfo(org.alias);
              if (subAgentInfo && parentAgentInfo && personInfo && leInfo) {
                const ok = updateA2ASubAgentCard(subA2APath, subAgentInfo, parentAgentInfo, personInfo, leInfo, qviInfo, org, person, agent, subAgent);
                if (ok) updatedCount++;
              }
            } else {
              // No existing A2A card — write the generated one
              if (subCard) {
                writeJson(subA2APath, subCard);
                if (!DRY_RUN) console.log(`✓ New A2A sub-agent card created: ${subA2APath}`);
                updatedCount++;
              }
            }

            // ── Sync DD live card for the sub-agent ──────────────────
            if (DD_CARDS_DIR) {
              const subAgentInfo    = readAgentInfo(subAgent.alias);
              const parentAgentInfo = readAgentInfo(agent.alias);
              const personInfo      = readPersonInfo(person.alias);
              const leInfo          = readLEInfo(org.alias);
              if (subAgentInfo && parentAgentInfo && personInfo && leInfo) {
                ddCount += syncDdCard(
                  subAgent.alias,
                  (livePath) => updateA2ASubAgentCard(
                    livePath, subAgentInfo, parentAgentInfo, personInfo, leInfo, qviInfo,
                    org, person, agent, subAgent
                  ),
                  subCard
                );
              } else {
                console.error(`✗ Skipping DD live card for ${subAgent.alias}: missing task-data`);
              }
            }
          }
        }
      }
    }
  }
  
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  ✅ Generation Complete`);
  console.log(`  Generated ${generatedCount} card(s) → ${OUTPUT_DIR}`);
  console.log(`  Updated   ${updatedCount} card(s) → ${OUTPUT_DIR_A2A}`);
  if (DD_CARDS_DIR) {
    console.log(`  DD live   ${ddCount} card(s) → ${DD_CARDS_DIR}`);
  } else {
    console.log(`  DD live   SKIPPED — no --dd-root given, so no DynDiscounting`);
    console.log(`            agent will see these AIDs. Pass --dd-root <.../A2A/js>.`);
  }
  if (DRY_RUN) console.log(`  [dry-run] nothing was actually written.`);
  console.log('');
  console.log('  Key fields for DEEP-EXT verification:');
  console.log('    - vLEImetadata.agentName');
  console.log('    - vLEImetadata.oorHolderName');
  console.log('');
  console.log('  Sub-delegation fields:');
  console.log('    - vLEImetadata.isSubDelegation');
  console.log('    - vLEImetadata.parentAgentName');
  console.log('    - keriIdentifiers.parentAgentAID');
  console.log('═══════════════════════════════════════════════\n');
}

main();

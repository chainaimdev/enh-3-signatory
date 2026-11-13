#!/usr/bin/env node

/**
 * build-org-config.js — 2-Level OOR Org Model -> 4C / 4D config builder
 *
 * Reads the company files (W3C ORG + PROV-O, JSON-LD) under --org-dir and
 * writes the two config files that run-all-buyerseller-4C-with-agents.sh and
 * run-all-buyerseller-4D-with-subdelegation.sh already understand:
 *
 *   <out-dir>/config-4c.json   same format as appconfig/configBuyerSellerAIAgent1.json
 *   <out-dir>/config-4d.json   same format as appconfig/configBuyerSellerAIAgent1-with-subdelegation.json
 *
 * Nothing existing is read for writing or overwritten: the generated files
 * live in their own directory and are only used when 4C/4D are given the
 * new --config / --config-4c / --config-4d flags.
 *
 * Usage:
 *   node build-org-config.js \
 *     --org-dir    ./appconfig/org \
 *     --seller     jupiter \
 *     --buyer      tommy \
 *     --out-dir    ./appconfig/generated \
 *     [--base-config ./appconfig/configBuyerSellerAIAgent1.json]   # source of root/qvi
 *     [--dry-run]               # validate and print a summary, write nothing
 *     [--fail-on-placeholder]   # refuse values still in <angle brackets>
 *
 * Checks (any failure stops the build, nothing is written):
 *   1. Valid JSON; required fields present on company, people and agents.
 *   2. Every @id reference resolves.
 *   3. reportsTo has no cycles.
 *   4. All alias values unique within the run.
 *   5. Every sub-agent appears in its parent agent's may_act.
 *   6. Limits narrow downwards (agent transactionLimit.max < person approvalLimit.max).
 *   7. Only credentialType OOR.
 *   8. Exactly one seller agent in the seller company, one buyer agent in the buyer company.
 *   9. Every agent gets a non-empty role.
 *  10. With --fail-on-placeholder: no value still in angle brackets.
 *
 * Edit the company files, never <out-dir>/*: generated files are rewritten on
 * every run.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;

// ─────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────

function usage() {
  const src = fs.readFileSync(__filename, 'utf8').split(/\r?\n/);
  const end = src.findIndex((l) => l.trim() === '*/');
  console.log(src.slice(0, end + 1).join('\n'));
  process.exit(0);
}

function die(msg) {
  console.error(`✗ ERROR: ${msg}`);
  process.exit(1);
}

const opts = {
  orgDir: path.join(SCRIPT_DIR, 'appconfig', 'org'),
  outDir: path.join(SCRIPT_DIR, 'appconfig', 'generated'),
  baseConfig: path.join(SCRIPT_DIR, 'appconfig', 'configBuyerSellerAIAgent1.json'),
  seller: null,
  buyer: null,
  dryRun: false,
  failOnPlaceholder: false,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => {
    if (i + 1 >= argv.length) die(`${a} requires a value`);
    return argv[++i];
  };
  switch (a) {
    case '--org-dir':             opts.orgDir = path.resolve(process.cwd(), val()); break;
    case '--out-dir':             opts.outDir = path.resolve(process.cwd(), val()); break;
    case '--base-config':         opts.baseConfig = path.resolve(process.cwd(), val()); break;
    case '--seller':              opts.seller = val(); break;
    case '--buyer':               opts.buyer = val(); break;
    case '--dry-run':             opts.dryRun = true; break;
    case '--fail-on-placeholder': opts.failOnPlaceholder = true; break;
    case '-h':
    case '--help':                usage(); break;
    default: die(`unknown argument: ${a}\n  Run 'node ${path.basename(__filename)} --help' for usage.`);
  }
}

if (!opts.seller) die('--seller <companyId> is required');
if (!opts.buyer) die('--buyer <companyId> is required');
if (opts.seller === opts.buyer) die('--seller and --buyer must be different companies');

// ─────────────────────────────────────────────────────────────
// Load
// ─────────────────────────────────────────────────────────────

const errors = [];
const err = (m) => errors.push(m);

function loadJson(file, what) {
  if (!fs.existsSync(file)) die(`${what} not found: ${file}`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    die(`${what} is not valid JSON (${file}): ${e.message}`);
  }
}

const contextFile = path.join(opts.orgDir, 'context.jsonld');
const context = loadJson(contextFile, 'Shared context');
if (!context || typeof context['@context'] !== 'object') {
  die(`${contextFile} has no "@context" object`);
}

const baseConfig = loadJson(opts.baseConfig, 'Base 4C config (source of root/qvi)');
if (!baseConfig.root || !baseConfig.qvi) {
  die(`${opts.baseConfig} has no "root" / "qvi" block to copy`);
}

const companies = [opts.seller, opts.buyer].map((id) => {
  const file = path.join(opts.orgDir, 'companies', `${id}.json`);
  const c = loadJson(file, `Company file for '${id}'`);
  c.__file = file;
  return c;
});
const [sellerCo, buyerCo] = companies;

// ─────────────────────────────────────────────────────────────
// Check 1: required fields
// ─────────────────────────────────────────────────────────────

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';

function requireFields(obj, fields, where) {
  for (const f of fields) {
    if (!isNonEmptyString(obj[f])) err(`${where}: missing or empty "${f}"`);
  }
}

for (const c of companies) {
  const where = path.basename(c.__file);
  if (!c['@context']) err(`${where}: missing "@context"`);
  requireFields(c, ['@id', 'companyId', 'alias', 'label', 'lei', 'registryName'], where);
  for (const list of ['posts', 'people', 'agents']) {
    if (!Array.isArray(c[list]) || c[list].length === 0) err(`${where}: "${list}" must be a non-empty array`);
  }
  (c.posts || []).forEach((p, i) => {
    requireFields(p, ['@id', 'heldBy'], `${where} posts[${i}]`);
    if (!Number.isInteger(p.level) || p.level < 1) err(`${where} posts[${i}]: "level" must be an integer >= 1`);
  });
  (c.people || []).forEach((p, i) => {
    requireFields(p, ['@id', 'alias', 'personLegalName', 'credentialType', 'officialRole'], `${where} people[${i}]`);
  });
  (c.agents || []).forEach((a, i) => {
    requireFields(a, ['@id', 'alias', 'agentType', 'actedOnBehalfOf'], `${where} agents[${i}]`);
    if (!a.mandate || !Array.isArray(a.mandate.authorization_details)) {
      err(`${where} agents[${i}]: "mandate.authorization_details" must be an array`);
    }
  });
}
if (errors.length) report();

// ─────────────────────────────────────────────────────────────
// Index every @id
// ─────────────────────────────────────────────────────────────

const byId = new Map(); // @id -> { kind, obj, company }
function index(obj, kind, company) {
  if (byId.has(obj['@id'])) err(`duplicate @id: ${obj['@id']}`);
  byId.set(obj['@id'], { kind, obj, company });
}
for (const c of companies) {
  index(c, 'company', c);
  c.posts.forEach((p) => index(p, 'post', c));
  c.people.forEach((p) => index(p, 'person', c));
  c.agents.forEach((a) => index(a, 'agent', c));
}

// ─────────────────────────────────────────────────────────────
// Check 2: every reference resolves (and points at the right kind)
// ─────────────────────────────────────────────────────────────

function ref(value, kinds, where) {
  if (value === undefined || value === null) return null;
  const hit = byId.get(value);
  if (!hit) { err(`${where}: reference "${value}" does not resolve`); return null; }
  if (!kinds.includes(hit.kind)) { err(`${where}: "${value}" is a ${hit.kind}, expected ${kinds.join(' or ')}`); return null; }
  return hit;
}

for (const c of companies) {
  const w = path.basename(c.__file);
  if (c.escalationPolicy) ref(c.escalationPolicy.reportTo, ['person'], `${w} escalationPolicy.reportTo`);
  c.posts.forEach((p) => {
    ref(p.heldBy, ['person'], `${w} ${p['@id']}.heldBy`);
    ref(p.reportsTo, ['post'], `${w} ${p['@id']}.reportsTo`);
  });
  c.people.forEach((p) => {
    ref(p.headOf, ['company'], `${w} ${p['@id']}.headOf`);
    ref(p.escalatesTo, ['person', 'agent'], `${w} ${p['@id']}.escalatesTo`);
  });
  c.agents.forEach((a) => {
    ref(a.actedOnBehalfOf, ['person', 'agent'], `${w} ${a['@id']}.actedOnBehalfOf`);
    ref(a.escalatesTo, ['person', 'agent'], `${w} ${a['@id']}.escalatesTo`);
    const mayAct = (a.mandate && a.mandate.may_act) || [];
    if (!Array.isArray(mayAct)) err(`${w} ${a['@id']}: mandate.may_act must be an array`);
    else mayAct.forEach((m) => ref(m, ['agent'], `${w} ${a['@id']}.may_act`));
  });
}

// Every person must hold exactly one post (it gives the level used for ordering)
const postOfPerson = new Map();
for (const c of companies) {
  for (const p of c.posts) {
    if (postOfPerson.has(p.heldBy)) err(`${p.heldBy} holds more than one post`);
    postOfPerson.set(p.heldBy, p);
  }
  for (const person of c.people) {
    if (!postOfPerson.has(person['@id'])) err(`${person['@id']} holds no post (posts[].heldBy)`);
  }
}
if (errors.length) report();

// ─────────────────────────────────────────────────────────────
// Check 3: reportsTo has no cycles
// ─────────────────────────────────────────────────────────────

for (const c of companies) {
  for (const start of c.posts) {
    const seen = new Set();
    let cur = start;
    while (cur && cur.reportsTo) {
      if (seen.has(cur['@id'])) { err(`reportsTo cycle through ${start['@id']}`); break; }
      seen.add(cur['@id']);
      const next = byId.get(cur.reportsTo);
      cur = next ? next.obj : null;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Check 4: aliases unique within the run
// ─────────────────────────────────────────────────────────────

const aliases = new Map();
function claimAlias(alias, owner) {
  if (aliases.has(alias)) err(`alias "${alias}" used by both ${aliases.get(alias)} and ${owner}`);
  else aliases.set(alias, owner);
}
for (const c of companies) {
  claimAlias(c.alias, c['@id']);
  c.people.forEach((p) => claimAlias(p.alias, p['@id']));
  c.agents.forEach((a) => claimAlias(a.alias, a['@id']));
}
for (const extra of [baseConfig.root.alias, baseConfig.qvi.alias]) {
  if (aliases.has(extra)) err(`alias "${extra}" clashes with the root/qvi alias`);
}

// ─────────────────────────────────────────────────────────────
// Check 5: sub-agents listed in their parent's may_act
//          (and only one level of sub-delegation, which is what 4D runs)
// ─────────────────────────────────────────────────────────────

const parentOf = (a) => byId.get(a.actedOnBehalfOf);
for (const c of companies) {
  for (const a of c.agents) {
    const p = parentOf(a);
    if (!p || p.kind !== 'agent') continue;
    const parent = p.obj;
    const mayAct = (parent.mandate && parent.mandate.may_act) || [];
    if (!mayAct.includes(a['@id'])) err(`${a['@id']} acts for ${parent['@id']} but is not in its mandate.may_act`);
    const gp = parentOf(parent);
    if (gp && gp.kind !== 'person') err(`${a['@id']}: parent ${parent['@id']} is itself a sub-agent; 4D supports one sub-delegation level`);
    if (p.company !== c) err(`${a['@id']}: parent agent belongs to another company`);
  }
  for (const a of c.agents) {
    const p = parentOf(a);
    if (p && p.kind === 'person' && p.company !== c) err(`${a['@id']}: officer belongs to another company`);
  }
}

// ─────────────────────────────────────────────────────────────
// Check 6: limits narrow downwards
// ─────────────────────────────────────────────────────────────

function personOf(agent) {
  let cur = agent;
  for (let i = 0; i < 10 && cur; i++) {
    const p = parentOf(cur);
    if (!p) return null;
    if (p.kind === 'person') return p.obj;
    cur = p.obj;
  }
  return null;
}

for (const c of companies) {
  for (const a of c.agents) {
    const person = personOf(a);
    const limit = person && person.approvalLimit;
    if (!limit || typeof limit.max !== 'number') continue;
    for (const d of a.mandate.authorization_details) {
      const t = d.transactionLimit;
      if (!t || typeof t.max !== 'number') continue;
      if (t.currency && limit.currency && t.currency !== limit.currency) {
        err(`${a['@id']}: transactionLimit currency ${t.currency} differs from ${person['@id']} approvalLimit currency ${limit.currency}`);
      } else if (!(t.max < limit.max)) {
        err(`${a['@id']}: transactionLimit.max ${t.max} is not below ${person['@id']} approvalLimit.max ${limit.max}`);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Check 7: OOR only
// ─────────────────────────────────────────────────────────────

for (const c of companies) {
  for (const p of c.people) {
    if (p.credentialType !== 'OOR') err(`${p['@id']}: credentialType "${p.credentialType}" not supported (OOR only; ECR is out of scope)`);
  }
}

// ─────────────────────────────────────────────────────────────
// Check 8: exactly one seller / one buyer agent
// ─────────────────────────────────────────────────────────────

const tradeAgents = (c, role) => c.agents.filter((a) => a.tradeRole === role);
const sellers = tradeAgents(sellerCo, 'seller');
const buyers = tradeAgents(buyerCo, 'buyer');
if (sellers.length !== 1) err(`${sellerCo.companyId}: expected exactly one agent with tradeRole "seller", found ${sellers.length}`);
if (buyers.length !== 1) err(`${buyerCo.companyId}: expected exactly one agent with tradeRole "buyer", found ${buyers.length}`);
for (const [c, role] of [[sellerCo, 'seller'], [buyerCo, 'buyer']]) {
  const otherRole = role === 'seller' ? 'buyer' : 'seller';
  if (tradeAgents(c, otherRole).length) err(`${c.companyId}: has a "${otherRole}" agent but is used as ${role}`);
}

// ─────────────────────────────────────────────────────────────
// Check 9: role on every agent
// ─────────────────────────────────────────────────────────────

function roleOf(a) {
  if (isNonEmptyString(a.tradeRole)) return a.tradeRole;
  const first = a.mandate.authorization_details[0];
  return first && isNonEmptyString(first.type) ? first.type : null;
}
function scopeOf(a) {
  const first = a.mandate.authorization_details[0];
  return first && isNonEmptyString(first.type) ? first.type : null;
}
for (const c of companies) {
  for (const a of c.agents) {
    if (!roleOf(a)) err(`${a['@id']}: no role (set tradeRole or mandate.authorization_details[0].type)`);
  }
}

// ─────────────────────────────────────────────────────────────
// Check 10: placeholders
// ─────────────────────────────────────────────────────────────

const placeholders = [];
function scan(v, where) {
  if (typeof v === 'string') { if (/<[^<>]+>/.test(v)) placeholders.push(`${where} = ${v}`); }
  else if (Array.isArray(v)) v.forEach((x, i) => scan(x, `${where}[${i}]`));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== '__file') scan(x, `${where}.${k}`);
}
companies.forEach((c) => scan(c, path.basename(c.__file)));
if (opts.failOnPlaceholder) placeholders.forEach((p) => err(`placeholder not filled: ${p}`));

if (errors.length) report();

// ─────────────────────────────────────────────────────────────
// Build
// ─────────────────────────────────────────────────────────────

const shortAlias = (id) => byId.get(id).obj.alias;

function orgBlock(c, with4d) {
  const people = [...c.people].sort(
    (a, b) => postOfPerson.get(a['@id']).level - postOfPerson.get(b['@id']).level
  );
  return {
    id: c.companyId,
    alias: c.alias,
    name: c.label,
    lei: c.lei,
    registryName: c.registryName,
    persons: people.map((person) => ({
      alias: person.alias,
      legalName: person.personLegalName,
      officialRole: person.officialRole,
      agents: c.agents
        .filter((a) => a.actedOnBehalfOf === person['@id'])
        .map((a) => {
          const out = { alias: a.alias, agentType: a.agentType, role: roleOf(a) };
          if (!with4d) return out;
          const mayAct = (a.mandate.may_act || []).map(shortAlias);
          out.permissions = { canDelegate: mayAct.length > 0, scope: scopeOf(a) };
          out.may_act = mayAct;
          if (a.card) out.card = a.card;
          const subs = c.agents.filter((s) => s.actedOnBehalfOf === a['@id']);
          if (subs.length) {
            out.subAgents = subs.map((s) => {
              const sMayAct = (s.mandate.may_act || []).map(shortAlias);
              const so = {
                alias: s.alias,
                agentType: s.agentType,
                permissions: { canDelegate: sMayAct.length > 0, scope: scopeOf(s) },
                may_act: sMayAct,
              };
              if (s.description) so.description = s.description;
              if (s.advisoryOnly === true) so.advisoryOnly = true;
              if (s.card) so.card = s.card;
              return so;
            });
          }
          return out;
        }),
    })),
  };
}

const config4c = { root: baseConfig.root, qvi: baseConfig.qvi, organizations: companies.map((c) => orgBlock(c, false)) };
const config4d = { root: baseConfig.root, qvi: baseConfig.qvi, organizations: companies.map((c) => orgBlock(c, true)) };

// ─────────────────────────────────────────────────────────────
// Summary + write
// ─────────────────────────────────────────────────────────────

console.log('═══════════════════════════════════════════════');
console.log('  build-org-config: all 10 checks passed');
console.log(`  seller: ${sellerCo.companyId} (agent ${sellers[0].alias})`);
console.log(`  buyer:  ${buyerCo.companyId} (agent ${buyers[0].alias})`);
console.log('═══════════════════════════════════════════════');
for (const org of config4d.organizations) {
  console.log(`\n${org.name} [${org.alias}]`);
  for (const p of org.persons) {
    console.log(`  OOR ${p.alias} (${p.officialRole})`);
    for (const a of p.agents) {
      console.log(`    agent ${a.alias} role=${a.role} scope=${a.permissions.scope} canDelegate=${a.permissions.canDelegate}`);
      for (const s of a.subAgents || []) console.log(`      sub-agent ${s.alias} scope=${s.permissions.scope}`);
    }
  }
}
if (placeholders.length) {
  console.log(`\n⚠ ${placeholders.length} placeholder value(s) still in <angle brackets>:`);
  placeholders.forEach((p) => console.log(`    ${p}`));
  console.log('  Fill them before a real run (or use --fail-on-placeholder to enforce).');
}

if (opts.dryRun) {
  console.log('\n[dry-run] nothing written.');
  process.exit(0);
}

fs.mkdirSync(opts.outDir, { recursive: true });
const out4c = path.join(opts.outDir, 'config-4c.json');
const out4d = path.join(opts.outDir, 'config-4d.json');
fs.writeFileSync(out4c, JSON.stringify(config4c, null, 2) + '\n');
fs.writeFileSync(out4d, JSON.stringify(config4d, null, 2) + '\n');
console.log(`\n✓ Wrote ${out4c}`);
console.log(`✓ Wrote ${out4d}`);
console.log('\nRun 4D with:');
const rel = (p) => './' + path.relative(process.cwd(), p).split(path.sep).join('/');
console.log(`  ./run-all-buyerseller-4D-with-subdelegation.sh --config-4c ${rel(out4c)} --config-4d ${rel(out4d)} --force-base`);
const nearInvoice = path.join(SCRIPT_DIR, 'appconfig', 'invoiceConfig-near.json');
if (fs.existsSync(nearInvoice)) {
  console.log(`  (Signatory / NEAR invoice: also add --invoice-config ${rel(nearInvoice)})`);
}

function report() {
  console.error(`✗ build-org-config: ${errors.length} check failure(s), nothing written:`);
  errors.forEach((e) => console.error(`    - ${e}`));
  process.exit(1);
}

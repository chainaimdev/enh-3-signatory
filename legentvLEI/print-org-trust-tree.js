#!/usr/bin/env node
/**
 * print-org-trust-tree.js
 *
 * Prints the vLEI trust tree that a 4D run ACTUALLY produced, built from the
 * config it ran with (e.g. appconfig/generated/config-4d.json) plus the
 * *-info.json files the run wrote into task-data. Nothing is hard-coded:
 * every company, OOR officer, agent and sub-agent in the config is shown,
 * with the AID / credential SAID read from task-data.
 *
 * Reads only. Never prints BRANs (it does not open *-bran.txt files).
 *
 * FLAGS
 *   --config <file>     Config the 4D run used.
 *                       default: ./appconfig/generated/config-4d.json
 *   --task-data <dir>   Where the run wrote *-info.json.
 *                       default: ./task-data
 *   --out <file>        Also write the tree (no colours) to this file.
 *   --strict            Exit 1 if any expected identity file is missing.
 *                       Use this as a post-run check.
 *   --no-color          Plain output.
 *   -h | --help         Show this help.
 *
 * Files read (all in --task-data):
 *   qvi-info.json                          QVI AID
 *   <org alias>-info.json                  Legal Entity AID
 *   <officer alias>-info.json              OOR holder AID
 *   <officer alias>-oor-credential-info.json  OOR credential SAID
 *   <agent alias>-info.json                agent / sub-agent AID
 */
'use strict';

const fs = require('fs');
const path = require('path');

const opts = {
  config: './appconfig/generated/config-4d.json',
  taskData: './task-data',
  out: null,
  strict: false,
  color: true,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => {
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) {
      console.error(`ERROR: ${a} requires a value`);
      process.exit(1);
    }
    return v;
  };
  switch (a) {
    case '--config': opts.config = val(); break;
    case '--task-data': opts.taskData = val(); break;
    case '--out': opts.out = val(); break;
    case '--strict': opts.strict = true; break;
    case '--no-color': opts.color = false; break;
    case '-h':
    case '--help': {
      const src = fs.readFileSync(__filename, 'utf8');
      const m = src.match(/\/\*\*([\s\S]*?)\*\//);
      console.log(m ? m[1].replace(/^ \* ?/gm, '') : 'see file header');
      process.exit(0);
    }
    default:
      console.error(`ERROR: unknown argument: ${a} (see --help)`);
      process.exit(1);
  }
}

const C = opts.color && process.stdout.isTTY !== false
  ? { g: '\x1b[0;32m', r: '\x1b[0;31m', c: '\x1b[0;36m', y: '\x1b[1;33m', n: '\x1b[0m' }
  : { g: '', r: '', c: '', y: '', n: '' };

let config;
try {
  config = JSON.parse(fs.readFileSync(opts.config, 'utf8'));
} catch (e) {
  console.error(`ERROR: cannot read config ${opts.config}: ${e.message}`);
  process.exit(1);
}

const missing = [];
function info(file, field) {
  const p = path.join(opts.taskData, file);
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'))[field];
    if (v) return v;
    missing.push(`${file} (no "${field}")`);
  } catch (_) {
    missing.push(file);
  }
  return null;
}

const lines = []; // [plainText, colouredText]
function out(plain, coloured) { lines.push([plain, coloured === undefined ? plain : coloured]); }
function id(label, value) {
  return value
    ? [`${label}: ${value}`, `${label}: ${C.g}${value}${C.n}`]
    : [`${label}: NOT FOUND`, `${label}: ${C.r}NOT FOUND${C.n}`];
}

out('vLEI Trust Tree (from run data)', `${C.c}vLEI Trust Tree (from run data)${C.n}`);
out(`config: ${opts.config}   task-data: ${opts.taskData}`);
out('');
out('ROOT (GLEIF)');
const qviAid = info('qvi-info.json', 'aid');
{ const [p, c] = id('QVI AID', qviAid); out(`└─ QVI   ${p}`, `└─ QVI   ${c}`); }

const orgs = config.organizations || [];
const subChecks = [];
orgs.forEach((org, oi) => {
  const lastOrg = oi === orgs.length - 1;
  const o1 = lastOrg ? '    └─ ' : '    ├─ ';
  const o2 = lastOrg ? '       ' : '    │  ';
  const roles = [...new Set((org.persons || []).flatMap(p => (p.agents || []).map(a => a.role)))]
    .filter(r => r === 'seller' || r === 'buyer');
  out(`${o1}${org.name}${roles.length ? ` (${roles.join('/')})` : ''}   LEI: ${org.lei}`);
  { const [p, c] = id('LE AID', info(`${org.alias}-info.json`, 'aid')); out(`${o2}   ${p}`, `${o2}   ${c}`); }

  const persons = org.persons || [];
  persons.forEach((person, pi) => {
    const lastP = pi === persons.length - 1;
    const p1 = o2 + (lastP ? '└─ ' : '├─ ');
    const p2 = o2 + (lastP ? '   ' : '│  ');
    out(`${p1}OOR officer ${person.alias}  [role: ${person.officialRole}]`);
    { const [p, c] = id('AID', info(`${person.alias}-info.json`, 'aid')); out(`${p2}   ${p}`, `${p2}   ${c}`); }
    { const [p, c] = id('OOR SAID', info(`${person.alias}-oor-credential-info.json`, 'said')); out(`${p2}   ${p}`, `${p2}   ${c}`); }

    const agents = person.agents || [];
    agents.forEach((agent, ai) => {
      const lastA = ai === agents.length - 1;
      const a1 = p2 + (lastA ? '└─ ' : '├─ ');
      const a2 = p2 + (lastA ? '   ' : '│  ');
      const scope = agent.permissions && agent.permissions.scope ? `, scope: ${agent.permissions.scope}` : '';
      out(`${a1}agent ${agent.alias}  [role: ${agent.role}${scope}]  delegated from ${person.alias}`);
      { const [p, c] = id('AID', info(`${agent.alias}-info.json`, 'aid')); out(`${a2}   ${p}`, `${a2}   ${c}`); }

      const subs = agent.subAgents || [];
      subs.forEach((sub, si) => {
        const lastS = si === subs.length - 1;
        const s1 = a2 + (lastS ? '└─ ' : '├─ ');
        const s2 = a2 + (lastS ? '   ' : '│  ');
        const sscope = sub.permissions && sub.permissions.scope ? `  [scope: ${sub.permissions.scope}]` : '';
        out(`${s1}sub-agent ${sub.alias}${sscope}  delegated from ${agent.alias}`);
        { const [p, c] = id('AID', info(`${sub.alias}-info.json`, 'aid')); out(`${s2}   ${p}`, `${s2}   ${c}`); }
        subChecks.push(`./DEEP-EXT-subagent.sh ${sub.alias} ${agent.alias} --oor-holder ${person.alias}`);
      });
    });
  });
});

out('');
if (subChecks.length) {
  out('Deep KEL check of each sub-delegation:');
  subChecks.forEach(s => out(`  ${s}`));
  out('');
}
if (missing.length) {
  out(`${missing.length} identity file(s) missing in ${opts.taskData}:`, `${C.r}${missing.length} identity file(s) missing in ${opts.taskData}:${C.n}`);
  missing.forEach(m => out(`  - ${m}`));
} else {
  out('All identities in the config were found in task-data.', `${C.g}All identities in the config were found in task-data.${C.n}`);
}

console.log(lines.map(l => l[1]).join('\n'));
if (opts.out) {
  fs.writeFileSync(opts.out, lines.map(l => l[0]).join('\n') + '\n');
  console.log(`\nWritten: ${opts.out}`);
}
process.exit(opts.strict && missing.length ? 1 : 0);

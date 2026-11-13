#!/usr/bin/env node
/**
 * export-signatory-evidence.js
 *
 * Writes ONE public JSON file (signatory-evidence.json) with the identities,
 * delegation KELs and the invoice credential produced by a 4D run, so the
 * NEAR bridge and reviewers can check them without running KERIA.
 *
 * Read-only. Reads only task-data/*-info.json files listed below plus the
 * KEL served by each AID's OOBI URL. It NEVER opens *-bran.txt,
 * agent-brans.json, subagent-brans.json or any .env file, and never copies
 * the "branFile" field of an info file.
 *
 * FLAGS
 *   --config <file>      Config the 4D run used.
 *                        default: ./appconfig/generated/config-4d.json
 *   --task-data <dir>    Where the run wrote *-info.json. default: ./task-data
 *   --out <file>         Output file. default: ./task-data/signatory-evidence.json
 *   --seller-agent <a>   Invoice issuer agent.   default: jupiterSellerAgent
 *   --buyer-agent <a>    Invoice receiver agent. default: tommyBuyerAgent
 *   --invoice-said <s>   Which invoice becomes "invoice" (must exist; every
 *                        invoice is still listed in "invoices[]").
 *                        default: the first one issued (oldest credential dt)
 *   --fetch-kel on|off   Fetch each AID's KEL from its OOBI URL. default: on
 *                        ("kel" in the output is the raw OOBI CESR stream; for
 *                        a delegated AID it also carries its delegators' events)
 *   --keria-url <url>    Replaces the http://keria:3902 origin of the OOBI
 *                        URLs (that host name only resolves inside Docker).
 *                        default: http://127.0.0.1:3902
 *   --strict             Exit 1 when any check fails (see CHECKS).
 *   --dry-run            Print the summary, write nothing.
 *   -h | --help          Show this help.
 *
 * Files read (all in --task-data):
 *   geda-info.json, qvi-info.json                 root / QVI AID
 *   <org alias>-info.json                         Legal Entity AID + OOBI
 *   <officer alias>-info.json                     OOR holder AID + OOBI
 *   <officer alias>-oor-credential-info.json      OOR credential SAID, issuer, issuee
 *   <agent alias>-info.json                       agent / sub-agent AID + OOBI
 *   <seller>-self-invoice-credential-info[.<SAID>].json  invoice ACDC (raw serialization)
 *   <seller>-ipex-grant-info[.<SAID>].json        IPEX grant SAID
 *   <buyer>-ipex-admit-info[.<SAID>].json         IPEX admit result + credentialHeld
 *   <seller>-invoice-issuance-<SAID>.json         TEL iss event + KEL anchor, written
 *                                                 by task-scripts/invoice/invoice-export-issuance.sh
 *   (.<SAID> copies are kept by issue-additional-invoice.sh; files are grouped
 *    by credential SAID, so several invoices are exported in "invoices[]")
 *
 * CHECKS (reported always; fatal with --strict)
 *   - every identity in the config has its info file
 *   - LE AIDs of different companies are different
 *   - each OOR credential's issuee is that officer's AID and issuer is the QVI
 *   - (KEL on) each agent's inception is a dip whose delegator (di) is its
 *     configured parent (officer for agents, parent agent for sub-agents),
 *     and the parent's KEL anchors a seal for it
 *   - invoice SAID = grant credential SAID (= --invoice-said if given),
 *     issuer = seller agent AID, sellerLEI = the seller company's LEI
 *   - invoice issuer is delegated (dip) from an officer of the seller company
 *     who holds an OOR credential
 *   - the buyer's IPEX admit succeeded and the buyer holds the credential
 *     (credentialHeld, G-34)
 *   - (G-36) an issuance proof exists: TEL iss event for this credential and
 *     registry, TEL state "iss" (not revoked), and (KEL on) the anchoring
 *     ixn is in the issuer's public KEL with seal {i: credential, s: 0, d: iss}
 *   All invoice checks run for every invoice in invoices[].
 *
 * NOT checked here (no data for it outside KERIA): which LE OOBI each
 * sub-agent resolved in its KERIA contacts, and the invoice SAID digest
 * itself (Blake3; recomputed by the bridge).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const opts = {
  config: './appconfig/generated/config-4d.json',
  taskData: './task-data',
  out: null,
  seller: 'jupiterSellerAgent',
  buyer: 'tommyBuyerAgent',
  invoiceSaid: null,
  fetchKel: true,
  keriaUrl: 'http://127.0.0.1:3902',
  strict: false,
  dryRun: false,
};

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const val = () => {
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) { console.error(`ERROR: ${a} requires a value`); process.exit(1); }
    return v;
  };
  switch (a) {
    case '--config': opts.config = val(); break;
    case '--task-data': opts.taskData = val(); break;
    case '--out': opts.out = val(); break;
    case '--seller-agent': opts.seller = val(); break;
    case '--buyer-agent': opts.buyer = val(); break;
    case '--invoice-said': opts.invoiceSaid = val(); break;
    case '--fetch-kel': {
      const v = val();
      if (v !== 'on' && v !== 'off') { console.error('ERROR: --fetch-kel takes on|off'); process.exit(1); }
      opts.fetchKel = v === 'on';
      break;
    }
    case '--keria-url': opts.keriaUrl = val().replace(/\/+$/, ''); break;
    case '--strict': opts.strict = true; break;
    case '--dry-run': opts.dryRun = true; break;
    case '-h':
    case '--help': {
      const m = fs.readFileSync(__filename, 'utf8').match(/\/\*\*([\s\S]*?)\*\//);
      console.log(m ? m[1].replace(/^ \* ?/gm, '') : 'see file header');
      process.exit(0);
    }
    default:
      console.error(`ERROR: unknown argument: ${a} (see --help)`);
      process.exit(1);
  }
}
if (!opts.out) opts.out = path.join(opts.taskData, 'signatory-evidence.json');

// ── Safety: refuse to read anything that can hold key material ──────────
const FORBIDDEN = [/-bran\.txt$/i, /agent-brans\.json$/i, /subagent-brans\.json$/i, /(^|[\\/])\.env/i];
function readTaskJson(file) {
  if (FORBIDDEN.some((re) => re.test(file))) throw new Error(`refusing to read key file ${file}`);
  return JSON.parse(fs.readFileSync(path.join(opts.taskData, file), 'utf8'));
}

const failures = [];
const notes = [];
const fail = (m) => failures.push(m);

function tryRead(file) {
  try { return readTaskJson(file); } catch (e) { fail(`missing/unreadable ${file}`); return null; }
}
const idInfo = (j) => (j ? { aid: j.aid || null, oobi: j.oobi || null } : { aid: null, oobi: null });

// ── KEL fetch via OOBI (same method as verifier-sally fetch_kel_via_oobi) ──
function hostOobi(oobi) {
  return oobi ? oobi.replace(/^http:\/\/keria:3902/, opts.keriaUrl) : null;
}
// KERI JSON events carry their exact byte size in the version string
// ("v":"KERI10JSON00013a_" -> 0x13a bytes). Slice each event by that size;
// the bytes between events are CESR attachments (signatures), kept in "cesr".
function parseKelEvents(text) {
  const events = [];
  const re = /\{"v":"KERI10JSON([0-9a-f]{6})_"/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const size = parseInt(m[1], 16);
    const raw = text.substr(m.index, size);
    try { events.push(JSON.parse(raw)); } catch (_) { /* not a complete event */ }
    re.lastIndex = m.index + Math.max(size, 1);
  }
  return events;
}
async function fetchKel(oobi, label) {
  if (!opts.fetchKel || !oobi) return null;
  const url = hostOobi(oobi);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) { fail(`${label}: OOBI fetch HTTP ${res.status} (${url})`); return null; }
    const cesr = await res.text();
    const events = parseKelEvents(cesr).filter((e) => ['icp', 'dip', 'rot', 'drt', 'ixn'].includes(e.t));
    return { oobi, cesr, events: events.map((e) => ({ t: e.t, i: e.i, s: e.s, d: e.d, di: e.di, a: e.a })) };
  } catch (e) {
    fail(`${label}: OOBI fetch failed (${url}): ${e.message}`);
    return null;
  }
}
const inceptionOf = (kel, aid) => (kel ? kel.events.find((e) => e.i === aid && (e.t === 'icp' || e.t === 'dip')) : null);
// An OOBI stream also carries the delegators' events, so only the parent's
// own events (e.i === parentAid) count as its KEL.
const anchorsSeal = (kel, parentAid, childAid) =>
  !!(kel && kel.events.some((e) => e.i === parentAid && Array.isArray(e.a) && e.a.some((s) => s && s.i === childAid)));

function checkDelegation(label, childAid, childKel, parentAlias, parentAid, parentKel) {
  if (!opts.fetchKel) return null;
  if (!childAid || !parentAid || !childKel || !parentKel) return null;
  const inc = inceptionOf(childKel, childAid);
  const ok = !!inc && inc.t === 'dip' && inc.di === parentAid && anchorsSeal(parentKel, parentAid, childAid);
  if (!inc) fail(`${label}: no inception event in its KEL`);
  else if (inc.t !== 'dip') fail(`${label}: inception is ${inc.t}, expected dip (delegated)`);
  else if (inc.di !== parentAid) fail(`${label}: delegator ${inc.di} is not ${parentAlias} (${parentAid})`);
  else if (!anchorsSeal(parentKel, parentAid, childAid)) fail(`${label}: ${parentAlias}'s KEL has no seal for ${childAid}`);
  return ok;
}

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  let configText;
  try { configText = fs.readFileSync(opts.config, 'utf8'); } catch (e) {
    console.error(`ERROR: cannot read config ${opts.config}: ${e.message}`); process.exit(1);
  }
  const config = JSON.parse(configText);

  const geda = idInfo(tryRead('geda-info.json'));
  const qvi = idInfo(tryRead('qvi-info.json'));

  const evidence = {
    generatedAt: new Date().toISOString(),
    source: {
      gedaAid: geda.aid,
      qviAid: qvi.aid,
      run: { config: opts.config, sha256: crypto.createHash('sha256').update(configText).digest('hex') },
    },
    companies: [],
    invoice: null,
    invoices: [],
    checks: null,
  };

  const agentIndex = new Map(); // alias -> { aid, company, delegatorAlias }
  const leAids = new Map();

  for (const org of config.organizations || []) {
    const le = idInfo(tryRead(`${org.alias}-info.json`));
    if (le.aid) {
      if (leAids.has(le.aid)) fail(`LE AID ${le.aid} is shared by ${leAids.get(le.aid)} and ${org.alias}`);
      leAids.set(le.aid, org.alias);
    }
    const company = { alias: org.alias, name: org.name, lei: org.lei, leAid: le.aid, leOobi: le.oobi, officers: [], agents: [] };

    for (const person of org.persons || []) {
      const p = idInfo(tryRead(`${person.alias}-info.json`));
      const oorFile = tryRead(`${person.alias}-oor-credential-info.json`);
      const oor = oorFile ? { said: oorFile.said || null, issuerAid: oorFile.issuer || null, issueeAid: oorFile.issuee || null, grantSaid: oorFile.grantSaid || null } : null;
      if (oor) {
        if (p.aid && oor.issueeAid !== p.aid) fail(`${person.alias}: OOR issuee ${oor.issueeAid} is not the officer AID ${p.aid}`);
        if (qvi.aid && oor.issuerAid !== qvi.aid) fail(`${person.alias}: OOR issuer ${oor.issuerAid} is not the QVI ${qvi.aid}`);
      }
      const personKel = await fetchKel(p.oobi, person.alias);
      company.officers.push({ alias: person.alias, officialRole: person.officialRole, aid: p.aid, oobi: p.oobi, oorCredential: oor, kel: personKel ? personKel.cesr : null });

      for (const agent of person.agents || []) {
        const ai = idInfo(tryRead(`${agent.alias}-info.json`));
        const agentKel = await fetchKel(ai.oobi, agent.alias);
        const okA = checkDelegation(agent.alias, ai.aid, agentKel, person.alias, p.aid, personKel);
        company.agents.push({
          alias: agent.alias, aid: ai.aid, oobi: ai.oobi, delegatorAlias: person.alias, delegator: p.aid,
          role: agent.role || null, scope: agent.permissions ? agent.permissions.scope : null,
          advisoryOnly: false, delegationVerified: okA, kel: agentKel ? agentKel.cesr : null,
        });
        agentIndex.set(agent.alias, { aid: ai.aid, company: org, delegatorAlias: person.alias, delegatorAid: p.aid, delegationVerified: okA, officerOor: oor, kel: agentKel });

        for (const sub of agent.subAgents || []) {
          const si = idInfo(tryRead(`${sub.alias}-info.json`));
          const subKel = await fetchKel(si.oobi, sub.alias);
          const okS = checkDelegation(sub.alias, si.aid, subKel, agent.alias, ai.aid, agentKel);
          company.agents.push({
            alias: sub.alias, aid: si.aid, oobi: si.oobi, delegatorAlias: agent.alias, delegator: ai.aid,
            role: sub.permissions ? sub.permissions.scope : null, scope: sub.permissions ? sub.permissions.scope : null,
            advisoryOnly: sub.advisoryOnly === true, delegationVerified: okS, kel: subKel ? subKel.cesr : null,
          });
        }
      }
    }
    evidence.companies.push(company);
  }

  // ── Invoice (self-attested by the seller agent, IPEX-granted to the buyer) ──
  // Several invoices (G-32): the issue/grant/admit steps always write the
  // three base files below; issue-additional-invoice.sh keeps a copy of each
  // invoice's files as <base>.<credentialSAID>.json. All copies are scanned
  // and grouped by credential SAID (a base file and its copy count once).
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const listFiles = (base) => {
    const re = new RegExp(`^${esc(base)}(\\.[A-Za-z0-9_-]{44})?\\.json$`);
    try { return fs.readdirSync(opts.taskData).filter((f) => re.test(f)).sort(); } catch (_) { return []; }
  };
  const readQuiet = (f) => { try { return readTaskJson(f); } catch (_) { fail(`unreadable ${f}`); return null; } };
  const credBase = `${opts.seller}-self-invoice-credential-info`;
  const credFiles = listFiles(credBase);
  if (!credFiles.length) fail(`missing ${credBase}.json`);
  const grants = listFiles(`${opts.seller}-ipex-grant-info`).map(readQuiet).filter(Boolean);
  const admits = listFiles(`${opts.buyer}-ipex-admit-info`).map(readQuiet).filter(Boolean);
  const credBySaid = new Map();
  for (const f of credFiles) {
    const ci = readQuiet(f);
    if (!ci) continue;
    const raw = ci.acdc && ci.acdc._raw ? ci.acdc._raw : null;
    if (!raw) { fail(`${f} has no acdc._raw`); continue; }
    const acdc = JSON.parse(raw);
    if (!credBySaid.has(acdc.d)) credBySaid.set(acdc.d, { credInfo: ci, raw, acdc });
  }
  const seller = agentIndex.get(opts.seller);
  if (!seller) fail(`seller agent ${opts.seller} is not in the config`);
  const buyer = agentIndex.get(opts.buyer);

  // Issuance proof check against the issuer's PUBLIC KEL (fetched via OOBI above):
  // the anchoring ixn must be in it and carry seal {i: credential, s: "0", d: iss}.
  function checkIssuance(said, acdc, iss) {
    if (!iss) { fail(`invoice ${said}: no issuance proof (run task-scripts/invoice/invoice-export-issuance.sh ${opts.seller} ${said})`); return false; }
    const ev = iss.telEvent || {};
    const sad = ev.sad || {};
    let ok = true;
    const bad = (m) => { fail(`invoice ${said}: ${m}`); ok = false; };
    if (iss.credentialSaid !== said || sad.i !== said) bad('issuance proof is for another credential');
    if (sad.t !== 'iss' || ev.said !== sad.d) bad('TEL event is not a valid iss event');
    if (sad.ri !== acdc.ri || iss.registry !== acdc.ri) bad(`TEL registry ${sad.ri} is not the credential registry ${acdc.ri}`);
    if (!iss.telState || iss.telState.et !== 'iss') bad(`TEL state is ${iss.telState ? iss.telState.et : 'missing'}, expected iss (not revoked)`);
    if (opts.fetchKel && seller && seller.kel) {
      const anc = seller.kel.events.find((e) => e.i === seller.aid && e.d === iss.anchor.ixnSaid);
      if (!anc) bad(`anchor ${iss.anchor.ixnSaid} is not in ${opts.seller}'s KEL`);
      else if (String(anc.s) !== String(iss.anchor.kelSeq)) bad(`anchor sequence ${anc.s} is not ${iss.anchor.kelSeq}`);
      else if (!(Array.isArray(anc.a) && anc.a.some((s) => s && s.i === said && String(s.s) === '0' && s.d === ev.said))) bad(`anchor ${anc.d} has no seal for iss ${ev.said}`);
    }
    return ok;
  }

  for (const [said, { credInfo, raw, acdc }] of credBySaid) {
    const grant = grants.find((g) => g.credentialSAID === said) || null;
    const admit = admits.find((a) => a.credentialSAID === said) || null;
    const issFile = `${opts.seller}-invoice-issuance-${said}.json`;
    let iss = null;
    if (fs.existsSync(path.join(opts.taskData, issFile))) iss = readQuiet(issFile);
    const inv = {
      said,
      schemaSaid: acdc ? acdc.s : credInfo.schema || null,
      registry: acdc ? acdc.ri : credInfo.registry || null,
      selfAttested: credInfo.selfAttested === true,
      issuerAlias: opts.seller,
      issuerAid: acdc ? acdc.i : credInfo.issuer || null,
      holderAlias: opts.buyer,
      holderAid: grant ? grant.receiverAID || null : null,
      acdcRaw: raw, // exact serialization the SAID was computed over
      acdc,
      ipex: {
        grantSaid: grant && grant.grantResult ? grant.grantResult.said : null,
        grantCredentialSaid: grant ? grant.credentialSAID || null : null,
        admitSuccess: admit ? admit.admitSuccess === true : null,
        admitGrantSaid: admit ? admit.grantSAID || null : null,
        credentialHeld: admit ? admit.credentialHeld === true : null,
      },
      issuance: iss ? { telEvent: iss.telEvent, telState: iss.telState, registry: iss.registry, anchor: iss.anchor, fetchedAt: iss.fetchedAt } : null,
    };
    const n = acdc.a && acdc.a.invoiceNumber ? acdc.a.invoiceNumber : said;
    if (!grant) fail(`invoice ${n}: no IPEX grant info for ${said}`);
    if (!admit) fail(`invoice ${n}: no IPEX admit info for ${said}`);
    if (inv.ipex.grantCredentialSaid && inv.ipex.grantCredentialSaid !== said) fail(`IPEX grant carries ${inv.ipex.grantCredentialSaid}, not invoice ${said}`);
    if (inv.ipex.admitGrantSaid && inv.ipex.grantSaid && inv.ipex.admitGrantSaid !== inv.ipex.grantSaid) fail(`invoice ${n}: admit refers to grant ${inv.ipex.admitGrantSaid}, not ${inv.ipex.grantSaid}`);
    if (admit && inv.ipex.admitSuccess !== true) fail(`invoice ${n}: ${opts.buyer} IPEX admit did not succeed (admitSuccess=${inv.ipex.admitSuccess})`);
    if (admit && inv.ipex.credentialHeld !== true) fail(`invoice ${n}: credential not held by ${opts.buyer} after admit (credentialHeld=${inv.ipex.credentialHeld})`);
    inv.issuanceVerified = checkIssuance(said, acdc, iss) && (opts.fetchKel ? !!(seller && seller.kel) : null);

    if (seller) {
      if (inv.issuerAid !== seller.aid) fail(`invoice ${n}: issuer ${inv.issuerAid} is not ${opts.seller} (${seller.aid})`);
      if (acdc.a && acdc.a.sellerLEI !== seller.company.lei) fail(`invoice ${n}: sellerLEI ${acdc.a.sellerLEI} is not ${seller.company.lei}`);
      if (!seller.officerOor || !seller.officerOor.said) fail(`${opts.seller}'s officer ${seller.delegatorAlias} has no OOR credential`);
      if (opts.fetchKel && seller.delegationVerified !== true) fail(`${opts.seller} delegation from ${seller.delegatorAlias} not verified in KEL`);
      inv.issuerDelegatedFrom = { officerAlias: seller.delegatorAlias, officerAid: seller.delegatorAid, officerOorSaid: seller.officerOor ? seller.officerOor.said : null };
    }
    if (buyer && inv.holderAid && inv.holderAid !== buyer.aid) fail(`invoice ${n}: IPEX receiver ${inv.holderAid} is not ${opts.buyer} (${buyer.aid})`);
    evidence.invoices.push(inv);
  }
  // Oldest first (credential "dt"), so invoice = the first one issued (UI-1 compatibility)
  evidence.invoices.sort((x, y) => String(x.acdc.a && x.acdc.a.dt).localeCompare(String(y.acdc.a && y.acdc.a.dt)));
  if (opts.invoiceSaid) {
    evidence.invoice = evidence.invoices.find((i) => i.said === opts.invoiceSaid) || null;
    if (!evidence.invoice) fail(`--invoice-said ${opts.invoiceSaid} not found in task-data`);
  } else {
    evidence.invoice = evidence.invoices[0] || null;
  }

  if (!opts.fetchKel) notes.push('KELs not fetched (--fetch-kel off): delegation checks skipped');
  notes.push('Not checked: the LE OOBI each sub-agent resolved inside KERIA, and the invoice SAID digest (bridge recomputes it).');
  evidence.checks = { strict: opts.strict, passed: failures.length === 0, failures, notes };

  // ── Last guard: no key-like field anywhere in the output ──
  const badKeys = [];
  (function scanKeys(v, where) {
    if (Array.isArray(v)) v.forEach((x, i) => scanKeys(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        if (/bran|passcode|secret|salt|privkey|private/i.test(k)) badKeys.push(`${where}.${k}`);
        scanKeys(x, `${where}.${k}`);
      }
    }
  })(evidence, '$');
  if (badKeys.length) {
    console.error(`ERROR: key-like field(s) in output, refusing to write: ${badKeys.join(', ')}`);
    process.exit(1);
  }
  const outText = JSON.stringify(evidence, null, 2) + '\n';

  for (const c of evidence.companies) {
    console.log(`${c.name}  LEI ${c.lei}  LE ${c.leAid || 'NOT FOUND'}`);
    for (const o of c.officers) console.log(`  OOR ${o.alias}  ${o.aid || 'NOT FOUND'}  OOR SAID ${o.oorCredential ? o.oorCredential.said : 'NOT FOUND'}`);
    for (const a of c.agents) console.log(`  agent ${a.alias}  ${a.aid || 'NOT FOUND'}  <- ${a.delegatorAlias}  KEL-verified: ${a.delegationVerified === null ? 'n/a' : a.delegationVerified}`);
  }
  for (const inv of evidence.invoices) {
    const a = inv.acdc && inv.acdc.a ? inv.acdc.a : {};
    console.log(`invoice ${a.invoiceNumber || '?'} ${inv.said}${inv === evidence.invoice ? ' (invoice)' : ''}  ${a.totalAmount} ${a.currency}  chain ${a.paymentChainID}  payee ${a.paymentWalletAddress}  admit ${inv.ipex.admitSuccess}  held ${inv.ipex.credentialHeld}  issuance-verified ${inv.issuanceVerified}`);
  }
  notes.forEach((n) => console.log(`note: ${n}`));
  if (failures.length) {
    console.log(`\n${failures.length} check failure(s):`);
    failures.forEach((f) => console.log(`  - ${f}`));
  } else {
    console.log('\nAll checks passed.');
  }

  if (opts.dryRun) console.log('[dry-run] nothing written.');
  else { fs.writeFileSync(opts.out, outText); console.log(`Written: ${opts.out}`); }
  process.exit(opts.strict && failures.length ? 1 : 0);
})();

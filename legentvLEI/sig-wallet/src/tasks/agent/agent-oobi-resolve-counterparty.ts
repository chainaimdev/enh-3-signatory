import fs from "fs";
import { ready, SignifyClient, Tier } from "signify-ts";
import { resolveEnvironment, EnvType } from "../../client/resolve-env.js";
import { resolveOobi } from "../../client/oobis.js";

/**
 * C1d (2026-11-13): make <agent> know <counterparty> BEFORE the counterparty sends it an exn (IPEX grant).
 *
 * D1 found the grant never reached tommyBuyerAgent's KERIA. The buyer only resolved the seller's OOBI in
 * the admit step (after the grant), and never resolved the seller's delegator (Jupiter_Chief_Sales_Officer).
 * A grant signed by a delegated AID cannot be validated without the delegator's KEL.
 *
 * What it does: walks the counterparty's delegation chain (state.di) through task-data/*-info.json, then
 * resolves the OOBIs top delegator first, counterparty last. Additive and idempotent.
 * Safety: connect() only (never boot), BRAN read from <taskDataDir>/<agent>-bran.txt and never printed.
 * Never fails the run: prints OOBI_COUNTERPARTY_RESULT=OK|PARTIAL|FAILED and exits 0.
 *
 * Usage: tsx agent-oobi-resolve-counterparty.ts <env> <agent> <counterparty> [taskDataDir] [maxDepth=4]
 */
const [envArg, agentName, counterpartyAlias, taskDirArg, depthArg] = process.argv.slice(2);
const env = (envArg || 'docker') as EnvType;
const taskDataDir = taskDirArg || '/task-data';
const maxDepth = Math.max(1, parseInt(depthArg || '4', 10) || 4);

type Info = { alias: string; aid: string; oobi: string; di?: string };

function loadInfo(alias: string): Info | null {
    const p = `${taskDataDir}/${alias}-info.json`;
    if (!fs.existsSync(p)) return null;
    const d = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return d?.aid && d?.oobi ? { alias, aid: d.aid, oobi: d.oobi, di: d.state?.di || undefined } : null;
}
function findByAid(aid: string): Info | null {
    for (const f of fs.readdirSync(taskDataDir)) {
        if (!f.endsWith('-info.json') || /bran|key|secret/i.test(f)) continue;
        try {
            const i = loadInfo(f.slice(0, -'-info.json'.length));
            if (i && i.aid === aid) return i;
        } catch { /* not an identity file */ }
    }
    return null;
}

async function main() {
    if (!agentName || !counterpartyAlias) {
        console.log('Usage: tsx agent-oobi-resolve-counterparty.ts <env> <agent> <counterparty> [taskDataDir] [maxDepth]');
        process.exit(2);
    }
    console.log(`=== OOBI counterparty resolve: ${agentName} learns ${counterpartyAlias} (+ delegators) ===`);
    const branPath = `${taskDataDir}/${agentName}-bran.txt`;
    if (!fs.existsSync(branPath)) { console.log(`OOBI_COUNTERPARTY_RESULT=FAILED missing BRAN file for ${agentName} (not printed)`); process.exit(0); }
    const bran = fs.readFileSync(branPath, 'utf-8').trim().padEnd(21, '_');

    // Chain: counterparty, its delegator, that one's delegator...
    const chain: Info[] = [];
    let cur = loadInfo(counterpartyAlias);
    if (!cur) { console.log(`OOBI_COUNTERPARTY_RESULT=FAILED no info file for ${counterpartyAlias}`); process.exit(0); }
    while (cur && chain.length < maxDepth) {
        chain.push(cur);
        if (!cur.di) break;
        const next = findByAid(cur.di);
        if (!next) { console.log(`  ⚠ delegator ${cur.di} of ${cur.alias} has no info file in task-data`); break; }
        cur = next;
    }
    const order = [...chain].reverse(); // top delegator first
    console.log(`  chain (resolve order): ${order.map(i => `${i.alias}${i.di ? ' (delegated)' : ''}`).join(' -> ')}`);

    await ready();
    const e = resolveEnvironment(env);
    const client = new SignifyClient(e.adminUrl, bran, Tier.low, e.bootUrl);
    try { await client.connect(); }
    catch (err: any) { console.log(`OOBI_COUNTERPARTY_RESULT=FAILED cannot connect as ${agentName} (no boot attempted): ${err?.message}`); process.exit(0); }

    let ok = 0;
    for (const i of order) {
        try {
            await resolveOobi(client, i.oobi, i.alias);
            let state = 'UNKNOWN';
            try {
                const ks: any = await client.keyStates().get(i.aid);
                const st = Array.isArray(ks) ? ks[0] : ks;
                if (st?.i) state = `KNOWN seq ${st.s} ${st.et}`;
            } catch { /* report as unknown */ }
            console.log(`  ✓ resolved ${i.alias} (${i.aid}) -> ${state}`);
            if (state.startsWith('KNOWN')) ok++;
        } catch (err: any) {
            console.log(`  ✗ ${i.alias}: ${String(err?.message).substring(0, 80)}`);
        }
    }
    const result = ok === order.length ? 'OK' : ok > 0 ? 'PARTIAL' : 'FAILED';
    console.log(`OOBI_COUNTERPARTY_RESULT=${result} known=${ok}/${order.length}`);
}

main().catch((err) => { console.log(`OOBI_COUNTERPARTY_RESULT=FAILED ${err?.message}`); process.exit(0); });

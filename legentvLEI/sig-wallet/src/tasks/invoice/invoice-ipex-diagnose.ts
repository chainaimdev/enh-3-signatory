import fs from "fs";
import { ready, SignifyClient, Tier } from "signify-ts";
import { resolveEnvironment, EnvType } from "../../client/resolve-env.js";

/**
 * D1 - READ-ONLY IPEX diagnosis (2026-11-13)
 *
 * Answers: why did tommyBuyerAgent not admit the invoice grant?
 *   cause 1: grant arrived late          -> notification present now
 *   cause 2: grant never reached KERIA    -> exchange not found in receiver's agent
 *   cause 3: arrived but filter missed it -> exchange found, notification route/read flag differs
 *
 * Read-only guarantees:
 *   - connect() only; never boot() (getOrCreateClient would boot a NEW agent on failure)
 *   - no create / admit / mark / resolve calls
 *   - the BRAN is read from <taskDataDir>/<receiver>-bran.txt and is never printed
 *
 * Usage: tsx invoice-ipex-diagnose.ts <env> <receiverAgent> <senderAgent> [taskDataDir]
 */
const [envArg, receiverAgentName, senderAgentName, taskDirArg] = process.argv.slice(2);
const env = (envArg || 'docker') as EnvType;
const taskDataDir = taskDirArg || '/task-data';

function readJson(path: string): any {
    if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
    return JSON.parse(fs.readFileSync(path, 'utf-8'));
}
function agentFromOobi(oobi: string | undefined): string | null {
    const m = (oobi || '').match(/\/agent\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
}

async function main() {
    if (!receiverAgentName || !senderAgentName) {
        console.log('Usage: tsx invoice-ipex-diagnose.ts <env> <receiverAgent> <senderAgent> [taskDataDir]');
        process.exit(2);
    }
    const grantInfo = readJson(`${taskDataDir}/${senderAgentName}-ipex-grant-info.json`);
    const receiverInfo = readJson(`${taskDataDir}/${receiverAgentName}-info.json`);
    const grantSAID: string = grantInfo.grantResult?.said;
    const credentialSAID: string = grantInfo.credentialSAID;
    const branPath = `${taskDataDir}/${receiverAgentName}-bran.txt`;
    if (!fs.existsSync(branPath)) throw new Error(`missing BRAN file for ${receiverAgentName} (not printed)`);
    const bran = fs.readFileSync(branPath, 'utf-8').trim().padEnd(21, '_');

    console.log('=== D1 IPEX DIAGNOSE (read-only) ===');
    console.log(`receiver        : ${receiverAgentName}`);
    console.log(`sender          : ${senderAgentName}`);
    console.log(`grant SAID      : ${grantSAID}`);
    console.log(`credential SAID : ${credentialSAID}`);
    console.log(`grant written   : ${grantInfo.timestamp || 'n/a'}`);

    await ready();
    const e = resolveEnvironment(env);
    const client = new SignifyClient(e.adminUrl, bran, Tier.low, e.bootUrl);
    try { await client.connect(); }
    catch (err: any) {
        console.log(`RESULT: CANNOT_CONNECT (no boot attempted): ${err?.message}`);
        process.exit(1);
    }

    const aid = await client.identifiers().get(receiverAgentName);
    const oobiAgent = agentFromOobi(receiverInfo.oobi);
    const myAgent = client.agent?.pre || null;
    console.log(`receiver AID    : ${aid.prefix} (info file: ${receiverInfo.aid})`);
    console.log(`KERIA agent now : ${myAgent}`);
    console.log(`agent in OOBI   : ${oobiAgent}`);
    const agentMatch = !!myAgent && myAgent === oobiAgent;
    console.log(`agent match     : ${agentMatch ? 'YES' : 'NO  <- grant was routed to a different KERIA agent'}`);

    // Notifications (all, read and unread)
    let notes: any[] = [];
    try {
        const n = await client.notifications().list(0, 99);
        notes = n?.notes || [];
        console.log(`notifications   : total=${n?.total ?? notes.length}`);
        for (const x of notes) {
            console.log(`  - route=${x.a?.r}  exn=${x.a?.d}  read=${!!x.r}  dt=${x.dt}${x.a?.d === grantSAID ? '   <- THIS GRANT' : ''}`);
        }
    } catch (err: any) { console.log(`notifications   : ERROR ${err?.message}`); }
    const noteForGrant = notes.find((x) => x.a?.d === grantSAID);

    // Exchange message (the grant itself) in the receiver's agent
    let exnFound = false;
    try {
        const exn: any = await client.exchanges().get(grantSAID);
        exnFound = !!exn;
        console.log(`grant exn       : FOUND route=${exn?.exn?.r} from=${exn?.exn?.i}`);
    } catch (err: any) { console.log(`grant exn       : NOT FOUND (${String(err?.message).substring(0, 60)})`); }

    // Credential in the receiver's store
    let credFound = false;
    try {
        const c: any = await client.credentials().get(credentialSAID);
        credFound = !!c;
        console.log(`credential      : ${credFound ? 'FOUND in receiver store' : 'NOT FOUND'}`);
    } catch (err: any) { console.log(`credential      : NOT FOUND (${String(err?.message).substring(0, 60)})`); }

    // Does the receiver know the sender and the sender's delegator? (read-only key-state lookups)
    const senderInfo = readJson(`${taskDataDir}/${senderAgentName}-info.json`);
    const delegatorAID: string | undefined = senderInfo.state?.di;
    async function known(pre: string | undefined): Promise<string> {
        if (!pre) return 'n/a';
        try {
            const ks: any = await client.keyStates().get(pre);
            const st = Array.isArray(ks) ? ks[0] : ks;
            return st?.i ? `KNOWN (seq ${st.s}, ${st.et})` : 'UNKNOWN';
        } catch (err: any) { return `UNKNOWN (${String(err?.message).substring(0, 40)})`; }
    }
    const senderKnown = await known(senderInfo.aid);
    const delegatorKnown = await known(delegatorAID);
    console.log(`sender KEL      : ${senderKnown}  (${senderInfo.aid}, ${senderInfo.state?.et || '?'})`);
    console.log(`sender delegator: ${delegatorKnown}  (${delegatorAID || 'none'})`);

    // Does the receiver know the invoice schema? (read-only)
    let schemaSaid: string | null = process.env.INVOICE_SCHEMA_SAID || null;
    for (const p of ['appconfig/schemaSaids.json', '/vlei/appconfig/schemaSaids.json']) {
        if (schemaSaid) break;
        try { if (fs.existsSync(p)) schemaSaid = JSON.parse(fs.readFileSync(p, 'utf-8'))?.invoiceSchema?.said || null; } catch { /* next */ }
    }
    let schemaKnown = 'n/a';
    if (schemaSaid) {
        try { const sc: any = await client.schemas().get(schemaSaid); schemaKnown = sc?.$id ? 'KNOWN' : 'UNKNOWN'; }
        catch (err: any) { schemaKnown = `UNKNOWN (${String(err?.message).substring(0, 40)})`; }
    }
    console.log(`invoice schema  : ${schemaKnown}  (${schemaSaid || 'SAID not found'})`);

    // Verdict
    let verdict: string;
    if (credFound) verdict = 'ALREADY_HELD: credential is in the receiver store (admit effectively done)';
    else if (!agentMatch) verdict = 'CAUSE_2_ROUTING: grant addressed to a KERIA agent this client does not own';
    else if (exnFound && !schemaKnown.startsWith('KNOWN')) verdict = 'SCHEMA_MISSING: grant delivered (admitted if notification is read) but receiver lacks the invoice schema -> credential in escrow';
    else if (!exnFound && !noteForGrant) verdict = 'CAUSE_2_NOT_DELIVERED: grant never reached the receiver KERIA agent';
    else if (noteForGrant && !noteForGrant.r) verdict = 'CAUSE_1_LATE: unread grant notification present now (check window too short)';
    else if (noteForGrant && noteForGrant.r) verdict = 'CAUSE_3_FILTER: notification present but marked read, so the filter skipped it';
    else verdict = 'CAUSE_3_NO_NOTE: grant exn delivered but no notification; admit by grant SAID will work';
    console.log(`RESULT: ${verdict}`);
    if (!credFound && !schemaKnown.startsWith('KNOWN')) console.log(`HINT: receiver does not know the invoice schema -> an admitted credential stays in escrow`);
    if (!delegatorKnown.startsWith('KNOWN')) console.log(`HINT: receiver does not know the sender's delegator -> a grant signed by a delegated AID cannot be validated`);
    else if (!senderKnown.startsWith('KNOWN')) console.log(`HINT: receiver does not know the sender's KEL`);
}

main().catch((err) => { console.log(`RESULT: ERROR ${err?.message}`); process.exit(1); });

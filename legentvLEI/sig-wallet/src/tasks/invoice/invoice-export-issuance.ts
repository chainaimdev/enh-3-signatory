import fs from "fs";
import { ready, SignifyClient, Tier } from "signify-ts";
import { resolveEnvironment, EnvType } from "../../client/resolve-env.js";

/**
 * G-36 - READ-ONLY export of an invoice credential's issuance proof (2026-11-13)
 *
 * Fetches from KERIA, as the issuer agent:
 *   - the TEL issuance event (iss) + its attachment, from credentials().get()
 *   - the TEL state of the credential, from credentials().state(ri, said)
 *   - the issuer KEL event (ixn) that anchors the iss event, from keyEvents().get()
 * and writes them to <taskDataDir>/<issuer>-invoice-issuance-<said>.json.
 *
 * Read-only guarantees:
 *   - connect() only; never boot() (getOrCreateClient would boot a NEW agent on failure)
 *   - no create / issue / grant / admit / resolve calls
 *   - the BRAN is read from <taskDataDir>/<issuer>-bran.txt and is never printed or written
 *
 * Usage: tsx invoice-export-issuance.ts <env> <issuerAgent> [credentialSAID] [taskDataDir]
 *   credentialSAID default: "said" in <taskDataDir>/<issuer>-self-invoice-credential-info.json
 */
const [envArg, issuerAgent, saidArg, taskDirArg] = process.argv.slice(2);
const env = (envArg || 'docker') as EnvType;
const taskDataDir = taskDirArg || '/task-data';

function readJson(path: string): any {
    if (!fs.existsSync(path)) throw new Error(`missing file: ${path}`);
    return JSON.parse(fs.readFileSync(path, 'utf-8'));
}
const sealMatches = (s: any, said: string, issSaid: string) =>
    s && s.i === said && String(s.s) === '0' && s.d === issSaid;

async function main() {
    if (!issuerAgent) {
        console.log('Usage: tsx invoice-export-issuance.ts <env> <issuerAgent> [credentialSAID] [taskDataDir]');
        process.exit(2);
    }
    const said: string = saidArg || readJson(`${taskDataDir}/${issuerAgent}-self-invoice-credential-info.json`).said;
    if (!said) throw new Error('no credential SAID given or found');
    const issuerInfo = readJson(`${taskDataDir}/${issuerAgent}-info.json`);

    const branPath = `${taskDataDir}/${issuerAgent}-bran.txt`;
    if (!fs.existsSync(branPath)) throw new Error(`missing BRAN file for ${issuerAgent} (not printed)`);
    const bran = fs.readFileSync(branPath, 'utf-8').trim().padEnd(21, '_');

    await ready();
    const e = resolveEnvironment(env);
    const client = new SignifyClient(e.adminUrl, bran, Tier.low, e.bootUrl);
    try { await client.connect(); }
    catch (err: any) {
        console.error(`CANNOT_CONNECT (no boot attempted): ${err?.message}`);
        process.exit(1);
    }

    const aid = await client.identifiers().get(issuerAgent);
    if (aid.prefix !== issuerInfo.aid) throw new Error(`KERIA AID ${aid.prefix} != info file AID ${issuerInfo.aid}`);

    const cred: any = await client.credentials().get(said);
    const sad = cred?.sad;
    const iss = cred?.iss;
    if (!sad || sad.d !== said) throw new Error(`credential ${said} not found in ${issuerAgent}'s KERIA store`);
    if (sad.i !== aid.prefix) throw new Error(`credential issuer ${sad.i} is not ${issuerAgent} (${aid.prefix})`);
    if (!iss || iss.t !== 'iss' || iss.i !== said || iss.ri !== sad.ri) {
        throw new Error(`credential ${said} has no matching TEL iss event`);
    }

    const state: any = await client.credentials().state(sad.ri, said);

    // Find the issuer KEL event that anchors the iss event: seal {i: said, s: "0", d: iss.d}
    const kel: any[] = await client.keyEvents().get(aid.prefix);
    const anchorEvt = (kel || []).map((x: any) => x?.ked ?? x).find((k: any) =>
        k && k.i === aid.prefix && Array.isArray(k.a) && k.a.some((s: any) => sealMatches(s, said, iss.d)));
    if (!anchorEvt) throw new Error(`no event in ${issuerAgent}'s KEL anchors iss ${iss.d}`);

    const out = {
        credentialSaid: said,
        issuerAlias: issuerAgent,
        issuerAid: aid.prefix,
        registry: sad.ri,
        telEvent: {
            said: iss.d,
            t: iss.t,
            s: iss.s,
            dt: iss.dt,
            sad: iss,
            cesr: JSON.stringify(iss) + (cred.issatc || ''),
        },
        telState: state ? { et: state.et, s: state.s, d: state.d, ri: state.ri, dt: state.dt } : null,
        anchor: { kelSeq: anchorEvt.s, ixnSaid: anchorEvt.d, t: anchorEvt.t },
        fetchedAt: new Date().toISOString(),
        source: 'KERIA (issuer agent, read-only)',
    };
    const outPath = `${taskDataDir}/${issuerAgent}-invoice-issuance-${said}.json`;
    fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

    console.log(`credential : ${said}`);
    console.log(`registry   : ${sad.ri}`);
    console.log(`TEL iss    : ${iss.d} (s=${iss.s})  state et=${out.telState?.et ?? 'n/a'}`);
    console.log(`anchor     : ${anchorEvt.t} s=${anchorEvt.s} d=${anchorEvt.d}`);
    console.log(`written    : ${outPath}`);
}

main().catch((err) => { console.error(`ERROR: ${err?.message || err}`); process.exit(1); });

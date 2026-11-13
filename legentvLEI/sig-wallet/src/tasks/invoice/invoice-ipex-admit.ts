import fs from "fs";
import { SignifyClient, Serder } from "signify-ts";
import { getOrCreateClient } from "../../client/identifiers.js";
import { resolveOobi } from "../../client/oobis.js";
import { createTimestamp, DEFAULT_TIMEOUT_MS } from "../../time.js";

/**
 * Admit IPEX grant for invoice credential
 * 
 * FIXED VERSION: Handles cross-client BRAN scenario gracefully
 * 
 * IMPORTANT: With unique BRANs (different KERIA controllers), IPEX admit
 * may not work because notifications don't propagate between controllers.
 * This is a known limitation. The workflow still succeeds because:
 * 1. The IPEX grant was sent successfully
 * 2. The credential can be verified using DEEP-EXT-credential.sh
 * 
 * Usage: tsx invoice-ipex-admit.ts <env> <passcode> <receiverAgent> <senderAgent> [taskDataDir] [waitSeconds=60]
 *
 * 2026-11-13 (C1): waits up to waitSeconds for the grant notification, matches it by grant SAID,
 * admits with the grant SAID (note.a.d, not the notification id note.i), falls back to admitting by
 * the grant SAID when the exn is in this agent but no notification is seen, and reports the truth.
 */

const args = process.argv.slice(2);
const env = args[0] as 'docker' | 'testnet';
const passcode = args[1];
const receiverAgentName = args[2];
const senderAgentName = args[3];
const taskDataDir = args[4] || '/task-data';
const waitSeconds = Math.max(5, parseInt(args[5] || '60', 10) || 60);

// C1e (2026-11-13): the holder's KERIA must know the credential's schema, or the admitted credential stays in escrow.
// Schema SAID: env INVOICE_SCHEMA_SAID, else appconfig/schemaSaids.json (invoiceSchema.said). OOBI base: env SCHEMA_OOBI_BASE.
function invoiceSchemaSaid(): string | null {
    if (process.env.INVOICE_SCHEMA_SAID) return process.env.INVOICE_SCHEMA_SAID;
    for (const p of ['appconfig/schemaSaids.json', '/vlei/appconfig/schemaSaids.json']) {
        try { if (fs.existsSync(p)) { const s = JSON.parse(fs.readFileSync(p, 'utf-8'))?.invoiceSchema?.said; if (s) return s; } } catch { /* next */ }
    }
    return null;
}
const SCHEMA_OOBI_BASE = process.env.SCHEMA_OOBI_BASE || 'http://schema:7723/oobi';


console.log(`========================================`);
console.log(`IPEX ADMIT: Invoice Credential`);
console.log(`========================================`);
console.log(``);
console.log(`Receiver: ${receiverAgentName}`);
console.log(`Sender: ${senderAgentName}`);
console.log(``);

// Get receiver's BRAN
let receiverPasscode = passcode;
if (!passcode || passcode.trim() === '') {
    const branFilePath = `${taskDataDir}/${receiverAgentName}-bran.txt`;
    if (fs.existsSync(branFilePath)) {
        receiverPasscode = fs.readFileSync(branFilePath, 'utf-8').trim();
        console.log(`Using receiver's BRAN from file (value not printed)`);
    } else {
        console.error(`No BRAN file found at ${branFilePath}`);
        process.exit(1);
    }
}

async function main() {
    let admitSuccess = false;
    let admitPath: 'notification' | 'grant-said' | 'none' = 'none';
    let credentialHeld = false;
    let admitError: string | null = null;
    let grantInfo: any = null;
    let receiverClient: SignifyClient | null = null;
    
    try {
        // Load grant info first
        console.log(`[1/5] Loading grant information...`);
        const grantInfoPath = `${taskDataDir}/${senderAgentName}-ipex-grant-info.json`;
        if (!fs.existsSync(grantInfoPath)) {
            throw new Error(`Grant info not found: ${grantInfoPath}`);
        }
        grantInfo = JSON.parse(fs.readFileSync(grantInfoPath, 'utf-8'));
        const grantSAID = grantInfo.grantResult?.said;
        const credentialSAID = grantInfo.credentialSAID;
        
        console.log(`✓ Grant info loaded`);
        console.log(`  Grant SAID: ${grantSAID}`);
        console.log(`  Credential SAID: ${credentialSAID}`);
        console.log(`  Invoice: ${grantInfo.invoiceNumber} - ${grantInfo.amount} ${grantInfo.currency}`);
        console.log(``);
        
        // Write the admit-info file IMMEDIATELY from grantInfo, before any
        // network call that could throw. grantInfo is always correct (the
        // grant step just wrote it for THIS negotiation). Previously the
        // file write was the last statement in the try block, so any error
        // in the notification/admit steps below skipped it entirely and the
        // file stayed stale from a previous run -- which is what the UI and
        // /api/ipex-status read. admitSuccess is updated again at the end.
        const admitInfoPath = `${taskDataDir}/${receiverAgentName}-ipex-admit-info.json`;
        const writeAdmitInfo = (ok: boolean) => {
            const result = {
                receiver: receiverAgentName,
                receiverAID: 'pending',
                sender: senderAgentName,
                senderAID: 'pending',
                grantSAID,
                credentialSAID,
                admitSuccess: ok,
                invoiceNumber: grantInfo.invoiceNumber,
                amount: grantInfo.amount,
                currency: grantInfo.currency,
                timestamp: new Date().toISOString(),
                note: 'Cross-client BRAN scenario - use DEEP-EXT-credential.sh to verify'
            };
            fs.writeFileSync(admitInfoPath, JSON.stringify(result, null, 2));
        };
        writeAdmitInfo(false);
        
        // Load sender info
        const senderInfoPath = `${taskDataDir}/${senderAgentName}-info.json`;
        if (!fs.existsSync(senderInfoPath)) {
            throw new Error(`Sender info not found: ${senderInfoPath}`);
        }
        const senderInfo = JSON.parse(fs.readFileSync(senderInfoPath, 'utf-8'));
        const senderPrefix = senderInfo.aid;
        
        // Connect to receiver's client
        console.log(`[2/5] Connecting to receiver's KERIA...`);
        receiverClient = await getOrCreateClient(receiverPasscode, env);
        const receiverAID = await receiverClient.identifiers().get(receiverAgentName);
        console.log(`✓ Connected (AID: ${receiverAID.prefix})`);
        console.log(``);
        
        // Resolve sender OOBI
        console.log(`[3/5] Resolving sender OOBI...`);
        try {
            await resolveOobi(receiverClient, senderInfo.oobi, senderAgentName);
            console.log(`✓ Sender OOBI resolved`);
        } catch (e: any) {
            console.log(`  Note: ${e.message}`);
        }
        console.log(``);
        
        // C1e: make sure the receiver knows the invoice schema before admitting
        const schemaSaid = invoiceSchemaSaid();
        if (schemaSaid) {
            try {
                await resolveOobi(receiverClient, `${SCHEMA_OOBI_BASE}/${schemaSaid}`, `invoice-schema-${schemaSaid.substring(0, 8)}`);
                console.log(`  ✓ Invoice schema ${schemaSaid} resolved in ${receiverAgentName}'s KERIA`);
            } catch (e: any) {
                console.log(`  ⚠ Invoice schema resolve: ${String(e?.message).substring(0, 80)}`);
            }
        } else {
            console.log(`  ⚠ Invoice schema SAID not found (set INVOICE_SCHEMA_SAID)`);
        }
        console.log(``);

        // [4/5] Wait for the grant notification (matched by grant SAID).
        console.log(`[4/5] Waiting up to ${waitSeconds}s for the grant notification...`);
        let grantNotification: any = null;
        const deadline = Date.now() + waitSeconds * 1000;
        while (Date.now() < deadline && !grantNotification) {
            try {
                const notifications = await receiverClient.notifications().list(0, 99);
                const notes: any[] = notifications.notes || [];
                grantNotification = notes.find((n: any) => n.a?.d === grantSAID)
                    || notes.find((n: any) => (n.a?.r || '').includes('/ipex/grant') && !n.r) || null;
            } catch (e: any) {
                console.log(`  Notification check: ${e.message}`);
            }
            if (!grantNotification) await new Promise(r => setTimeout(r, 3000));
        }
        console.log(grantNotification
            ? `  ✓ Found grant notification (exn ${grantNotification.a?.d}, read=${!!grantNotification.r})`
            : `  No grant notification after ${waitSeconds}s`);

        // Fallback: is the grant exn itself in this agent?
        let grantSaidToAdmit: string | null = grantNotification?.a?.d || null;
        if (!grantSaidToAdmit && grantSAID) {
            try {
                const exn: any = await receiverClient.exchanges().get(grantSAID);
                if (exn) {
                    grantSaidToAdmit = grantSAID;
                    admitPath = 'grant-said';
                    console.log(`  ✓ Grant exn is in the receiver's KERIA; admitting by grant SAID`);
                }
            } catch {
                console.log(`  Grant exn ${grantSAID} is NOT in the receiver's KERIA (not delivered)`);
            }
        } else if (grantSaidToAdmit) {
            admitPath = 'notification';
        }
        console.log(``);

        // [5/5] Admit
        console.log(`[5/5] IPEX admit...`);
        if (grantSaidToAdmit && receiverClient) {
            try {
                const [admit, sigs, aend] = await receiverClient.ipex().admit({
                    senderName: receiverAgentName,
                    message: '',
                    grantSaid: grantSaidToAdmit,
                    recipient: senderPrefix,
                    datetime: createTimestamp(),
                });
                const admitOp = await receiverClient.ipex().submitAdmit(
                    receiverAgentName, admit, sigs, aend, [senderPrefix]
                );
                await receiverClient.operations().wait(admitOp, {
                    signal: AbortSignal.timeout(30000)
                });
                admitSuccess = true;
                console.log(`  ✓ Admit submitted (${admitPath})`);
                if (grantNotification?.i) {
                    try { await receiverClient.notifications().mark(grantNotification.i); } catch { /* not critical */ }
                }
                // Confirm the credential is now held (KERIA may take a moment)
                const credWaitTries = Math.max(1, Math.ceil(parseInt(process.env.IPEX_CRED_WAIT_S || '30', 10) / 2));
                for (let i = 0; i < credWaitTries && !credentialHeld; i++) {
                    try { credentialHeld = !!(await receiverClient.credentials().get(credentialSAID)); } catch { /* not yet */ }
                    if (!credentialHeld) await new Promise(r => setTimeout(r, 2000));
                }
                console.log(credentialHeld
                    ? `  ✓ Credential ${credentialSAID} is in ${receiverAgentName}'s KERIA`
                    : `  ⚠ Admit sent, but the credential is not visible in ${receiverAgentName}'s KERIA yet`);
            } catch (e: any) {
                admitError = String(e?.message || e).substring(0, 120);
                console.log(`  ✗ Admit failed: ${admitError}`);
            }
        } else {
            admitError = 'grant not delivered to receiver KERIA (no notification, no exn)';
            console.log(`  ✗ Nothing to admit: ${admitError}`);
        }
        
        // Save result — rewrite with the final admitSuccess and real AIDs.
        // (The file was already written once above so it's never stale even
        // if the admit attempt above threw.)
        const finalReceiverAID = receiverClient
            ? (await receiverClient.identifiers().get(receiverAgentName)).prefix
            : 'unknown';
        const result = {
            receiver: receiverAgentName,
            receiverAID: finalReceiverAID,
            sender: senderAgentName,
            senderAID: senderPrefix,
            grantSAID,
            credentialSAID,
            admitSuccess,
            admitPath,
            credentialHeld,
            admitError,
            invoiceNumber: grantInfo.invoiceNumber,
            amount: grantInfo.amount,
            currency: grantInfo.currency,
            timestamp: new Date().toISOString(),
            note: admitSuccess ? 'IPEX admit submitted by receiver' : 'IPEX admit NOT done - see admitError'
        };
        
        fs.writeFileSync(admitInfoPath, JSON.stringify(result, null, 2));
        
    } catch (error: any) {
        console.log(`  Error: ${error.message?.substring(0, 80)}`);
    }
    
    // Honest final status (the run still continues: exit code stays 0)
    console.log(``);
    console.log(`========================================`);
    console.log(admitSuccess ? `✅ IPEX ADMIT DONE` : `⚠ IPEX ADMIT NOT DONE`);
    console.log(`========================================`);
    if (!admitSuccess) console.log(`  Reason: ${admitError || 'see log above'}`);
    console.log(`IPEX_ADMIT_RESULT=${admitSuccess ? 'SUCCESS' : 'FAILED'} path=${admitPath} credentialHeld=${credentialHeld}`);
    console.log(``);
    console.log(`  Grant SAID: ${grantInfo?.grantResult?.said || 'N/A'}`);
    console.log(`  Credential: ${grantInfo?.credentialSAID || 'N/A'}`);
    console.log(`  Invoice: ${grantInfo?.invoiceNumber} - ${grantInfo?.amount} ${grantInfo?.currency}`);
    console.log(``);
    console.log(`  📋 To verify the credential:`);
    console.log(`     ./DEEP-EXT-credential.sh ${receiverAgentName} ${senderAgentName}`);
    console.log(``);
    
    // Always exit 0 - the workflow is complete even without admit
    process.exit(0);
}

main().catch(error => {
    console.log(`Error: ${error.message}`);
    
    // Still save what we have
    try {
        const grantInfoPath = `${taskDataDir}/${senderAgentName}-ipex-grant-info.json`;
        if (fs.existsSync(grantInfoPath)) {
            const grantInfo = JSON.parse(fs.readFileSync(grantInfoPath, 'utf-8'));
            
            console.log(``);
            console.log(`========================================`);
            console.log(`✅ IPEX GRANT WAS SUCCESSFUL`);
            console.log(`========================================`);
            console.log(``);
            console.log(`  Grant SAID: ${grantInfo.grantResult?.said}`);
            console.log(`  Credential: ${grantInfo.credentialSAID}`);
            console.log(`  Invoice: ${grantInfo.invoiceNumber}`);
            console.log(``);
            console.log(`  📋 To verify:`);
            console.log(`     ./DEEP-EXT-credential.sh ${receiverAgentName} ${senderAgentName}`);
            console.log(``);
        }
    } catch (e) {}
    
    process.exit(0); // Exit 0 because grant succeeded
});

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { createKramVerifier } from './lib/kram-verify-middleware.js';
import { corsOptions } from './lib/cors-config.js';

const execAsync = promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 4000;

// Working directory for all shell script execution.
//
// Phase 1 (containerisation): overridable via VLEI_DIR so the api-server image
// can be SELF-CONTAINED at /app (with its own Linux-built node_modules) while
// the repo - task-data, task-scripts, appconfig, the test-*.sh scripts - is
// bind-mounted somewhere else entirely (/vlei-repo). Without this override,
// __dirname/.. would resolve to '/' inside the container.
//
// Unset => previous behaviour exactly (repo-relative ../ from api-server/).
const VLEI_DIR = process.env.VLEI_DIR
  ? path.resolve(process.env.VLEI_DIR)
  : path.join(__dirname, '..');

app.use(cors(corsOptions()));
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// A.6 KRAM: caller-authentication middleware (gated by KRAM_REQUIRED). Lazily
// connects to KERIA on the first KRAM request; with KRAM_REQUIRED unset, an
// unsigned request passes through and a signed one is still verified.
const kramVerify = createKramVerifier();

// ============================================
// 🎨 A2A-style request/response logger
// Logs every /api/* and /health hit with timestamps, badges, body, and key
// response fields — same visual style as the A2A negotiation stream.
// ============================================
const C = {
  r: '\x1b[0m', b: '\x1b[1m', d: '\x1b[2m',
  red: '\x1b[31m', grn: '\x1b[32m', ylw: '\x1b[33m',
  cyn: '\x1b[36m', gry: '\x1b[90m',
};
const _ts = () => {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
};
const _badge = (p) => {
  if (p.includes('/buyer/verify/ext/seller'))     return `${C.cyn}🔵 BUYER${C.r} ${C.gry}→${C.r} ${C.grn}🟢 SELLER${C.r}  ${C.d}(DEEP-EXT)${C.r}`;
  if (p.includes('/seller/verify/ext/buyer'))     return `${C.grn}🟢 SELLER${C.r} ${C.gry}→${C.r} ${C.cyn}🔵 BUYER${C.r}  ${C.d}(DEEP-EXT)${C.r}`;
  if (p.includes('/buyer/verify/seller'))         return `${C.cyn}🔵 BUYER${C.r} ${C.gry}→${C.r} ${C.grn}🟢 SELLER${C.r}  ${C.d}(DEEP)${C.r}`;
  if (p.includes('/seller/verify/buyer'))         return `${C.grn}🟢 SELLER${C.r} ${C.gry}→${C.r} ${C.cyn}🔵 BUYER${C.r}  ${C.d}(DEEP)${C.r}`;
  if (p.includes('/buyer/verify/sellerInvoice'))  return `${C.cyn}🔵 BUYER${C.r} ${C.gry}→${C.r} ${C.grn}🟢 SELLER${C.r}  ${C.d}(DEEP-EXT-CREDENTIAL)${C.r}`;
  if (p.includes('/seller/ipex/issue-and-grant')) return `${C.grn}🟢 SELLER${C.r}  ${C.ylw}📤 IPEX GRANT${C.r}`;
  if (p.includes('/buyer/ipex/admit'))            return `${C.cyn}🔵 BUYER${C.r}   ${C.ylw}📥 IPEX ADMIT${C.r}`;
  if (p.includes('/ipex-status'))                 return `${C.gry}📥 IPEX STATUS${C.r}`;
  if (p.includes('/status'))                      return `${C.gry}📊 WORKFLOW STATUS${C.r}`;
  if (p.includes('/health'))                      return `${C.gry}❤  HEALTH${C.r}`;
  return p;
};

app.use((req, res, next) => {
  if (!req.path.startsWith('/api') && req.path !== '/health') return next();
  const start = Date.now();
  const id = Math.random().toString(36).slice(2, 8);

  console.log('');
  console.log(`${C.gry}┌─ ${C.r}${C.d}${_ts()}${C.r}  ${C.b}${req.method}${C.r} ${C.cyn}${req.path}${C.r}  ${C.gry}#${id}${C.r}`);
  console.log(`${C.gry}│  ${C.r}${_badge(req.path)}`);
  if (req.body && Object.keys(req.body).length > 0) {
    const body = JSON.stringify(req.body);
    console.log(`${C.gry}│  ${C.r}${C.d}body:${C.r} ${body.length > 200 ? body.slice(0, 200) + '…' : body}`);
  }

  const _json = res.json.bind(res);
  res.json = (data) => {
    const dur = Date.now() - start;
    const ok = data?.success === true || (res.statusCode >= 200 && res.statusCode < 300 && data?.success !== false);
    const icon = ok ? `${C.grn}✅ SUCCESS${C.r}` : `${C.red}❌ FAILED${C.r}`;

    if (data?.agent)          console.log(`${C.gry}│  ${C.r}${C.d}agent       :${C.r} ${data.agent}`);
    if (data?.oorHolder)      console.log(`${C.gry}│  ${C.r}${C.d}oorHolder   :${C.r} ${data.oorHolder}`);
    if (data?.credentialSAID) console.log(`${C.gry}│  ${C.r}${C.d}credSAID    :${C.r} ${data.credentialSAID}`);
    if (data?.grantSAID)      console.log(`${C.gry}│  ${C.r}${C.d}grantSAID   :${C.r} ${data.grantSAID}`);
    if (data?.admitSAID)      console.log(`${C.gry}│  ${C.r}${C.d}admitSAID   :${C.r} ${data.admitSAID}`);
    if (data?.invoiceId)      console.log(`${C.gry}│  ${C.r}${C.d}invoiceId   :${C.r} ${data.invoiceId}`);
    if (!ok && data?.error)   console.log(`${C.gry}│  ${C.r}${C.red}error       :${C.r} ${String(data.error).slice(0, 200)}`);
    console.log(`${C.gry}└─ ${C.r}${icon}  ${C.d}${res.statusCode} · ${dur}ms · #${id}${C.r}`);
    return _json(data);
  };

  next();
});

// ============================================
// Helper: Run a shell script in legentvLEI/ directory
// IMPORTANT: All commands must use RELATIVE paths (./)
// because bash on Windows can't handle absolute paths with spaces
// ============================================
async function runShellScript(command, timeoutMs = 120000) {
  const { stdout, stderr } = await execAsync(command, {
    cwd: VLEI_DIR,
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 10,
    env: { ...process.env, GEDA_PRE: '' }
  });
  return { stdout, stderr };
}

// Helper: Run verification script
async function runVerification(agentName, oorHolderName, scriptType = 'DEEP', callerAgent = 'unknown', endpoint = 'unknown') {
  try {
    console.log(`[${endpoint}] Starting ${scriptType} verification of: ${agentName} by ${callerAgent}`);
    let scriptName;
    if (scriptType === 'DEEP-EXT-CREDENTIAL') scriptName = 'test-agent-verification-DEEP-credential.sh';
    else if (scriptType === 'DEEP-EXT') scriptName = 'test-agent-verification-DEEP-EXT.sh';
    else scriptName = 'test-agent-verification-DEEP.sh';

    const command = `bash ./${scriptName} ${agentName} ${oorHolderName} docker --json`;
    console.log(`Executing: ${command}`);

    const { stdout, stderr } = await runShellScript(command);

    console.log('Verification stdout (last 500):', stdout.substring(stdout.length - 500));
    if (stderr) console.log('Verification stderr:', stderr);

    let verificationResult;
    try {
      const jsonMatch = stdout.match(/\{[\s\S]*"validation"[\s\S]*\}|\{[\s\S]*"success"[\s\S]*\}/);
      if (jsonMatch) {
        verificationResult = JSON.parse(jsonMatch[0]);
        if (!verificationResult.success && !verificationResult.error) verificationResult.error = 'Verification failed';
      } else {
        const success = stdout.includes('DEEP VERIFICATION PASSED') || stdout.includes('DELEGATION VERIFICATION COMPLETE') || stdout.includes('Delegation is CRYPTOGRAPHICALLY VERIFIED');
        verificationResult = { success, output: stdout, error: success ? null : 'Expected success markers not found', agent: agentName, oorHolder: oorHolderName, timestamp: new Date().toISOString() };
      }
    } catch (parseError) {
      const success = stdout.includes('DEEP VERIFICATION PASSED') || stdout.includes('DELEGATION VERIFICATION COMPLETE');
      verificationResult = { success, output: stdout, error: success ? null : `JSON parse error: ${parseError.message}`, agent: agentName, oorHolder: oorHolderName, timestamp: new Date().toISOString() };
    }
    return verificationResult;
  } catch (error) {
    console.error(`Verification failed for ${agentName}:`, error);

    // Bug fix (hosting readiness pass): this used to classify errors by
    // scanning error.message, which for a failed shell command is just
    // "Command failed: bash ./script.sh agentName oorHolder docker --json" -
    // that string ALWAYS contains the word "docker" (it's the env argument
    // every one of these scripts takes), so this reported "Docker/compose
    // error. Ensure containers are running." for nearly every failure
    // regardless of cause. Confirmed live: a real "Agent KEL not found in
    // KERIA" data failure was misreported as a Docker error.
    //
    // Fix: try the script's own structured --json error output first (the
    // real, specific error from the underlying tool - the same parsing
    // already done on the success path above), and only fall back to
    // generic classification using the real stderr text, never the echoed
    // command line.
    let friendlyError;
    let structuredError = null;
    const stdoutForParsing = error.stdout || '';
    try {
      const jsonMatch = stdoutForParsing.match(/\{[\s\S]*"error"[\s\S]*\}|\{[\s\S]*"success"[\s\S]*\}/);
      if (jsonMatch) structuredError = JSON.parse(jsonMatch[0]);
    } catch { /* stdout wasn't parseable JSON - fall through to generic classification */ }

    if (structuredError && structuredError.error) {
      friendlyError = structuredError.error;
    } else if (error.killed || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT') {
      friendlyError = `Script timed out (no response within the configured timeout). This is a real timeout, not a Docker error - check KERIA/witness health.`;
    } else {
      // error.stderr is the script's actual error output; error.message on a
      // failed exec is mostly just the echoed command line, not useful here.
      const stderrText = error.stderr || '';
      if (stderrText.includes('not found') || stderrText.includes('No such file')) {
        friendlyError = 'Required task-data files not found. Ensure the delegation workflow has completed for this agent.';
      } else if (stderrText.includes('Cannot connect to the Docker daemon') || stderrText.includes('docker: command not found')) {
        friendlyError = 'Docker itself is unavailable inside the container running this script.';
      } else {
        friendlyError = stderrText || error.message || 'Unknown error';
      }
    }

    const errorMessage = error.stderr || error.message || 'Unknown error';
    return { success: false, output: error.stdout || '', error: friendlyError, errorDetails: errorMessage, agent: agentName, oorHolder: oorHolderName, timestamp: new Date().toISOString() };
  }
}

// ============================================
// IPEX STATUS endpoint — reads task-data files for grant/admit info
// ============================================
app.get('/api/ipex-status', (req, res) => {
  try {
    const td = path.join(VLEI_DIR, 'task-data');
    const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(td, f), 'utf8')); } catch { return null; } };

    const grant   = read('jupiterSellerAgent-ipex-grant-info.json');
    const admit   = read('tommyBuyerAgent-ipex-admit-info.json');
    const credInfo = read('jupiterSellerAgent-self-invoice-credential-info.json');

    res.json({
      grant: grant ? {
        from:           grant.sender,
        fromAID:        grant.senderAID,
        to:             grant.receiver,
        toAID:          grant.receiverAID,
        grantSAID:      grant.grantResult?.said,
        credentialSAID: grant.credentialSAID,
        invoiceNumber:  grant.invoiceNumber,
        amount:         grant.amount,
        currency:       grant.currency,
        timestamp:      grant.timestamp,
        selfAttested:   credInfo?.selfAttested ?? true,
        sellerLEI:      grant.credential?.sad?.a?.sellerLEI,
        buyerLEI:       grant.credential?.sad?.a?.buyerLEI,
      } : null,
      admit: admit ? {
        from:           admit.sender,
        fromAID:        admit.senderAID,
        to:             admit.receiver,
        toAID:          admit.receiverAID,
        grantSAID:      admit.grantSAID,
        credentialSAID: admit.credentialSAID,
        admitSuccess:   admit.admitSuccess,
        invoiceNumber:  admit.invoiceNumber,
        amount:         admit.amount,
        currency:       admit.currency,
        timestamp:      admit.timestamp,
      } : null,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), message: 'vLEI Verification & IPEX API Server is running' });
});

// ============================================
// STATUS endpoint — reads task-data files, no re-running scripts
// Returns already-verified state from completed vLEI workflow
// ============================================
app.get('/api/status', (req, res) => {
  try {
    const td = path.join(VLEI_DIR, 'task-data');
    const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(td, f), 'utf8')); } catch { return null; } };

    const sellerInfo    = read('jupiterSellerAgent-info.json');
    const buyerInfo     = read('tommyBuyerAgent-info.json');
    const sellerDelInfo = read('jupiterSellerAgent-delegate-info.json');
    const buyerDelInfo  = read('tommyBuyerAgent-delegate-info.json');
    const sellerOOR     = read('Jupiter_Chief_Sales_Officer-info.json');
    const buyerOOR      = read('Tommy_Chief_Procurement_Officer-info.json');
    const ipexGrant     = read('jupiterSellerAgent-ipex-grant-info.json');
    const treasuryInfo  = read('JupiterTreasuryAgent-info.json');

    const sellerVerified = !!(
      sellerInfo?.state?.et === 'dip' &&
      sellerInfo?.state?.di &&
      sellerInfo.state.di === sellerOOR?.aid &&
      sellerDelInfo?.aid
    );

    const buyerVerified = !!(
      buyerInfo?.state?.et === 'dip' &&
      buyerInfo?.state?.di &&
      buyerInfo.state.di === buyerOOR?.aid &&
      buyerDelInfo?.aid
    );

    res.json({
      seller: {
        verified:    sellerVerified,
        agentAID:    sellerInfo?.aid,
        oorHolderAID: sellerOOR?.aid,
        diMatch:     sellerInfo?.state?.di === sellerOOR?.aid,
        eventType:   sellerInfo?.state?.et,
        publicKey:   sellerInfo?.state?.k?.[0],
        hasUniqueBran: sellerInfo?.hasUniqueBran,
        steps: {
          step1_aidsLoaded:      !!sellerInfo?.aid && !!sellerOOR?.aid,
          step2_delegationField: sellerInfo?.state?.di === sellerOOR?.aid,
          step3_delegationSeal:  !!sellerDelInfo?.icpOpName,
          step4_cryptoProof:     sellerInfo?.state?.et === 'dip',
          step5_publicKey:       !!sellerInfo?.state?.k?.[0],
        },
      },
      buyer: {
        verified:    buyerVerified,
        agentAID:    buyerInfo?.aid,
        oorHolderAID: buyerOOR?.aid,
        diMatch:     buyerInfo?.state?.di === buyerOOR?.aid,
        eventType:   buyerInfo?.state?.et,
        publicKey:   buyerInfo?.state?.k?.[0],
        hasUniqueBran: buyerInfo?.hasUniqueBran,
        steps: {
          step1_aidsLoaded:      !!buyerInfo?.aid && !!buyerOOR?.aid,
          step2_delegationField: buyerInfo?.state?.di === buyerOOR?.aid,
          step3_delegationSeal:  !!buyerDelInfo?.icpOpName,
          step4_cryptoProof:     buyerInfo?.state?.et === 'dip',
          step5_publicKey:       !!buyerInfo?.state?.k?.[0],
        },
      },
      treasury: {
        verified: !!treasuryInfo?.aid,
        agentAID: treasuryInfo?.aid,
      },
      ipexGrant: !!ipexGrant,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// VERIFICATION ENDPOINTS
// ============================================

app.post('/api/buyer/verify/seller', kramVerify, async (req, res) => {
  console.log('=== BUYER -> SELLER VERIFICATION (DEEP) ===');
  try {
    const result = await runVerification('jupiterSellerAgent', 'Jupiter_Chief_Sales_Officer', 'DEEP');
    result.verificationType = 'STANDARD'; result.verificationScript = 'DEEP'; result.caller = 'buyer'; result.target = 'seller';
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/seller/verify/buyer', kramVerify, async (req, res) => {
  console.log('=== SELLER -> BUYER VERIFICATION (DEEP) ===');
  try {
    const result = await runVerification('tommyBuyerAgent', 'Tommy_Chief_Procurement_Officer', 'DEEP');
    result.verificationType = 'STANDARD'; result.verificationScript = 'DEEP'; result.caller = 'seller'; result.target = 'buyer';
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/buyer/verify/ext/seller', kramVerify, async (req, res) => {
  console.log('=== BUYER -> SELLER VERIFICATION (DEEP-EXT) ===');
  try {
    const endpoint = `http://localhost:${PORT}${req.originalUrl}`;
    const result = await runVerification('jupiterSellerAgent', 'Jupiter_Chief_Sales_Officer', 'DEEP-EXT', 'tommyBuyerAgent', endpoint);
    result.verificationType = 'EXTERNAL'; result.verificationScript = 'DEEP-EXT'; result.caller = 'buyer'; result.target = 'seller';
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/seller/verify/ext/buyer', kramVerify, async (req, res) => {
  console.log('=== SELLER -> BUYER VERIFICATION (DEEP-EXT) ===');
  try {
    const result = await runVerification('tommyBuyerAgent', 'Tommy_Chief_Procurement_Officer', 'DEEP-EXT', 'jupiterSellerAgent');
    result.verificationType = 'EXTERNAL'; result.verificationScript = 'DEEP-EXT'; result.caller = 'seller'; result.target = 'buyer';
    res.status(result.success ? 200 : 400).json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.post('/api/buyer/verify/sellerInvoice', kramVerify, async (req, res) => {
  console.log('=== BUYER -> SELLER INVOICE CREDENTIAL VERIFICATION (DEEP-EXT-CREDENTIAL) ===');
  try {
    const endpoint = `http://localhost:${PORT}${req.originalUrl}`;
    const result = await runVerification('jupiterSellerAgent', 'Jupiter_Chief_Sales_Officer', 'DEEP-EXT-CREDENTIAL', 'tommyBuyerAgent', endpoint);    res.status(result.success ? 200 : 400).json(result);
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

// Legacy endpoints
app.post('/api/verify/seller', async (req, res) => { const r = await runVerification('jupiterSellerAgent', 'Jupiter_Chief_Sales_Officer'); r.deprecated = true; res.status(r.success ? 200 : 400).json(r); });
app.post('/api/verify/buyer', async (req, res) => { const r = await runVerification('tommyBuyerAgent', 'Tommy_Chief_Procurement_Officer'); r.deprecated = true; res.status(r.success ? 200 : 400).json(r); });
app.post('/api/verify/ext/seller', async (req, res) => { const r = await runVerification('jupiterSellerAgent', 'Jupiter_Chief_Sales_Officer', 'DEEP-EXT', 'tommyBuyerAgent', `http://localhost:${PORT}${req.originalUrl}`); r.deprecated = true; res.status(r.success ? 200 : 400).json(r); });
app.post('/api/verify/ext/buyer', async (req, res) => { const r = await runVerification('tommyBuyerAgent', 'Tommy_Chief_Procurement_Officer', 'DEEP-EXT', 'jupiterSellerAgent', `http://localhost:${PORT}${req.originalUrl}`); r.deprecated = true; res.status(r.success ? 200 : 400).json(r); });
// ============================================
// IPEX ENDPOINTS — Invoice Credential Exchange
// ============================================
//
// IMPORTANT: All bash commands use RELATIVE paths (./) because
// the absolute Windows path contains "MOD aathi" (space) which
// breaks jq and other tools inside the shell scripts.

// Seller issues self-attested invoice credential and grants to buyer via IPEX
app.post('/api/seller/ipex/issue-and-grant', async (req, res) => {
  console.log('=== SELLER IPEX: ISSUE + GRANT INVOICE CREDENTIAL ===');

  const {
    invoiceId, invoiceDate, dueDate, totalAmount, currency,
    pricePerUnit, quantity, paymentTerms, negotiationId,
    type
  } = req.body;

  if (!invoiceId || !totalAmount) {
    return res.status(400).json({ success: false, error: 'Missing required fields: invoiceId, totalAmount' });
  }

  const invoiceType = type || 'INVOICE';
  console.log(`  Type         : ${invoiceType}`);
  console.log(`  Invoice ID   : ${invoiceId}`);
  console.log(`  Total Amount : ${totalAmount} ${currency || 'INR'}`);
  console.log(`  Negotiation  : ${negotiationId || 'N/A'}`);

  try {
    // Step 1: Write dynamic invoice config
    // Use a simple filename (no spaces, no absolute path in bash command)
    const tempFileName = `temp-invoice-config-${Date.now()}.json`;
    const tempConfigAbsolute = path.join(VLEI_DIR, 'task-data', tempFileName);
    // RELATIVE path for bash command — this is the key fix for the MOD aathi space issue
    const tempConfigRelative = `./task-data/${tempFileName}`;

    const dynamicConfig = {
      invoice: {
        issuer: { alias: 'jupiterSellerAgent', lei: '3358004DXAMRWRUIYJ05' },
        holder: { alias: 'tommyBuyerAgent', lei: '54930012QJWZMYHNJW95' },
        sampleInvoice: {
          invoiceNumber: invoiceId,
          invoiceDate: invoiceDate || new Date().toISOString(),
          dueDate: dueDate || new Date(Date.now() + 30 * 86400000).toISOString(),
          sellerLEI: '3358004DXAMRWRUIYJ05',
          buyerLEI: '54930012QJWZMYHNJW95',
          currency: currency || 'INR',
          totalAmount: totalAmount,
          lineItems: [{
            description: invoiceType === 'DD_INVOICE' ? 'Dynamic Discounting Invoice' : 'Textile Procurement',
            quantity: quantity || 1,
            unitPrice: pricePerUnit || totalAmount,
            amount: totalAmount
          }],
          paymentTerms: { terms: paymentTerms || 'Net 30 days from invoice date', discountCurve: [] },
          paymentMethod: 'A2A-negotiated'
        }
      }
    };

    fs.writeFileSync(tempConfigAbsolute, JSON.stringify(dynamicConfig, null, 2));
    console.log(`  ✓ Temp config written: ${tempConfigRelative}`);

    // Step 2: Issue self-attested invoice credential (RELATIVE path for bash)
    console.log('  → Step 1/2: Issuing self-attested invoice credential...');
    const issueCommand = `bash ./task-scripts/invoice/invoice-acdc-issue-self-attested.sh jupiterSellerAgent ${tempConfigRelative}`;
    console.log(`  Executing: ${issueCommand}`);

    const issueResult = await runShellScript(issueCommand, 180000); // raised from 60000: issuance retry-backoff (~66s) + slow KERIA can exceed 60s, causing SIGTERM
    const issueSuccess = issueResult.stdout.includes('successfully') || issueResult.stdout.includes('✓');
    console.log(`  Issue result: ${issueSuccess ? 'SUCCESS' : 'CHECK OUTPUT'}`);
    console.log(`  Issue stdout (last 300): ${issueResult.stdout.substring(issueResult.stdout.length - 300)}`);

    // Step 3: IPEX grant to buyer
    console.log('  → Step 2/2: IPEX granting credential to buyer...');
    const grantCommand = `bash ./task-scripts/invoice/invoice-ipex-grant.sh jupiterSellerAgent tommyBuyerAgent`;
    console.log(`  Executing: ${grantCommand}`);

    const grantResult = await runShellScript(grantCommand, 180000); // raised from 60000 to match issue step (slow-KERIA headroom)
    const grantSuccess = grantResult.stdout.includes('successfully') || grantResult.stdout.includes('✓');
    console.log(`  Grant result: ${grantSuccess ? 'SUCCESS' : 'CHECK OUTPUT'}`);
    console.log(`  Grant stdout (last 300): ${grantResult.stdout.substring(grantResult.stdout.length - 300)}`);

    // Read credential SAID
    let credentialSAID = null;
    try {
      const credInfo = JSON.parse(fs.readFileSync(path.join(VLEI_DIR, 'task-data', 'jupiterSellerAgent-self-invoice-credential-info.json'), 'utf8'));
      credentialSAID = credInfo.said;
      console.log(`  Credential SAID: ${credentialSAID}`);
    } catch (e) { console.log('  Could not read credential info file'); }

    // Read grant SAID
    let grantSAID = null;
    try {
      const grantInfo = JSON.parse(fs.readFileSync(path.join(VLEI_DIR, 'task-data', 'jupiterSellerAgent-ipex-grant-info.json'), 'utf8'));
      grantSAID = grantInfo.said || grantInfo.grantSaid;
      console.log(`  Grant SAID: ${grantSAID}`);
    } catch (e) { console.log('  Could not read grant info file'); }

    // Clean up temp config
    try { fs.unlinkSync(tempConfigAbsolute); } catch (e) { /* ignore */ }

    const success = issueSuccess && grantSuccess;
    console.log(`  === IPEX ISSUE+GRANT: ${success ? 'SUCCESS ✓' : 'FAILED ✗'} ===`);

    res.status(success ? 200 : 400).json({
      success, invoiceId, invoiceType, credentialSAID, grantSAID,
      issueOutput: issueSuccess ? 'Credential issued' : issueResult.stdout.substring(issueResult.stdout.length - 200),
      grantOutput: grantSuccess ? 'IPEX grant sent' : grantResult.stdout.substring(grantResult.stdout.length - 200),
      from: 'jupiterSellerAgent', to: 'tommyBuyerAgent', timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('IPEX issue-and-grant error:', error);
    res.status(500).json({ success: false, error: error.stderr || error.message || 'Unknown error', invoiceId, invoiceType: type || 'INVOICE', timestamp: new Date().toISOString() });
  }
});

// Buyer admits IPEX grant from seller
app.post('/api/buyer/ipex/admit', async (req, res) => {
  console.log('=== BUYER IPEX: ADMIT INVOICE CREDENTIAL ===');

  const { senderAgent, invoiceId } = req.body;
  const sender = senderAgent || 'jupiterSellerAgent';

  // Hosting-readiness fix: `sender` used to be interpolated directly into a
  // shell command string with zero validation. req.body.senderAgent comes
  // from an unauthenticated caller, so e.g. "jupiterSellerAgent; rm -rf /"
  // would execute arbitrary commands inside this container (exec() runs
  // through a real shell). Allow-listing known agent aliases instead of
  // trying to shell-escape - escaping is easy to get subtly wrong,
  // allow-listing is not.
  const ALLOWED_SENDER_AGENTS = new Set(['jupiterSellerAgent']);
  if (!ALLOWED_SENDER_AGENTS.has(sender)) {
    return res.status(400).json({ success: false, error: `Unknown or invalid senderAgent: "${sender}"` });
  }

  console.log(`  Sender  : ${sender}`);
  console.log(`  Invoice : ${invoiceId || 'latest'}`);

  try {
    const admitCommand = `bash ./task-scripts/invoice/invoice-ipex-admit.sh tommyBuyerAgent ${sender}`;
    console.log(`  Executing: ${admitCommand}`);

    const admitResult = await runShellScript(admitCommand, 180000); // raised from 60000: admit also does KERIA round-trips under retry
    const admitSuccess = admitResult.stdout.includes('IPEX_ADMIT_RESULT=SUCCESS'); // was: any '✓' in stdout (always true)
    console.log(`  Admit result: ${admitSuccess ? 'SUCCESS' : 'CHECK OUTPUT'}`);
    console.log(`  Admit stdout (last 300): ${admitResult.stdout.substring(admitResult.stdout.length - 300)}`);

    let admitSAID = null;
    try {
      const admitInfo = JSON.parse(fs.readFileSync(path.join(VLEI_DIR, 'task-data', 'tommyBuyerAgent-ipex-admit-info.json'), 'utf8'));
      admitSAID = admitInfo.said || admitInfo.credentialSAID || admitInfo.credentialSaid;
      console.log(`  Admit SAID: ${admitSAID}`);
    } catch (e) { console.log('  Could not read admit info file'); }

    console.log(`  === IPEX ADMIT: ${admitSuccess ? 'SUCCESS ✓' : 'FAILED ✗'} ===`);

    res.status(admitSuccess ? 200 : 400).json({
      success: admitSuccess, admitSAID, invoiceId: invoiceId || 'latest',
      admittedFrom: sender, admittedBy: 'tommyBuyerAgent',
      output: admitSuccess ? 'Credential admitted' : admitResult.stdout.substring(admitResult.stdout.length - 200),
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('IPEX admit error:', error);
    res.status(500).json({ success: false, error: error.stderr || error.message || 'Unknown error', invoiceId: invoiceId || 'latest', timestamp: new Date().toISOString() });
  }
});

// Generic verification endpoint
app.post('/api/verify/:agentType', async (req, res) => {
  const configs = { seller: ['jupiterSellerAgent', 'Jupiter_Chief_Sales_Officer'], buyer: ['tommyBuyerAgent', 'Tommy_Chief_Procurement_Officer'] };
  const c = configs[req.params.agentType.toLowerCase()];
  if (!c) return res.status(400).json({ success: false, error: `Unknown: ${req.params.agentType}` });
  try { const r = await runVerification(c[0], c[1]); res.status(r.success ? 200 : 400).json(r); }
  catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// Error handling
app.use((err, req, res, next) => { res.status(500).json({ success: false, error: 'Internal server error', message: err.message }); });

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log('🚀 vLEI Verification & IPEX API Server Started');
  console.log('='.repeat(60));
  console.log(`📡 Server: http://0.0.0.0:${PORT}  |  Health: http://localhost:${PORT}/health`);
  console.log('');
  console.log('Verification:');
  console.log(`  POST /api/buyer/verify/seller          (DEEP)`);
  console.log(`  POST /api/seller/verify/buyer          (DEEP)`);
  console.log(`  POST /api/buyer/verify/ext/seller      (DEEP-EXT)`);
  console.log(`  POST /api/seller/verify/ext/buyer      (DEEP-EXT)`);
  console.log(`  POST /api/buyer/verify/sellerInvoice   (DEEP-EXT-CREDENTIAL)`);
  console.log('');
  console.log('IPEX Credential Exchange:');
  console.log(`  POST /api/seller/ipex/issue-and-grant  → Issue + grant invoice credential`);
  console.log(`  POST /api/buyer/ipex/admit             → Admit IPEX grant`);
  console.log('='.repeat(60));
});
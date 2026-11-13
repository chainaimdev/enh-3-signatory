// S-7 runner engine: one run at a time; every step is a real action or real evidence, with an `api` proof block.
//   mode "invoice" (Phase A): pay a pre-issued invoice — steps offer, accept, register, pay, outcome, decision (index 1..6)
//   mode "issue"   (Phase B): issue a new vLEI invoice per request — steps 0..10:
//     preflight, issue, offer, export, verify_seller, verify_buyer, accept, register, pay, outcome, decision
// Network/process access is injected (deps) so the engine is unit-testable without keys:
//   deps.loadEvidence() · deps.getInvoice(said) · deps.getMandate(account)
//   deps.bridgeRegister(said) / deps.signerPay(said) / deps.signerDecide(kind, said)
//       → response JSON, optionally with `_http: {status, ms, url}` (stripped before use)
//   deps.sleep(ms)
//   Phase B only: deps.preflight() → {ok, checks, mandate} · deps.nextInvoiceNumber(evidence) → {invoiceNumber, highest}
//                 deps.writeInvoiceConfig(invoiceNumber, units) → {path, relPath}
//                 deps.runIssue(relPath) / deps.runExport() → {exitCode, timedOut, stdout, stderr, ms, cmd}
//                 deps.readGrantInfo(said) → {grantSaid, path, timestamp} | null
import { formatUnits } from "../../scripts/lib/common.mjs";
import { evidenceInvoices } from "../bridge/rules.mjs";
import { listInvoices, matchInvoice, parseRequest } from "./logic.mjs";
import { lineItemDescription, parseIssueOutput, proofJson, proofTail } from "./vlei.mjs";

export const STEPS = ["offer", "accept", "register", "pay", "outcome", "decision"];
export const STEPS_B = ["preflight", "issue", "offer", "export", "verify_seller", "verify_buyer", "accept", "register", "pay", "outcome", "decision"];

export class RunnerError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function unwrap(res) {
  if (!res || typeof res !== "object") return { body: { ok: false, error: "empty response" }, http: {} };
  const { _http, ...body } = res;
  return { body, http: _http || {} };
}

export function createRunner({
  cfg,
  deps,
  pollMs = 2000,
  waitTimeoutMs = 15 * 60 * 1000,
  keepRuns = 20,
  minUnits = 100n, // 0.0001 USDC (vLEI float guard)
  maxUnits = 250000n, // --max-amount 0.25 (the CPO limit)
  onLog = () => {},
}) {
  const decimals = cfg.tokenDecimals;
  const demoScale = cfg.demoScale ?? 1000000;
  const aliases = cfg.accounts.aliases;
  const role = (r) => Object.entries(aliases).find(([, e]) => e.role === r) || [];
  const [agentAlias, agentEntry] = role("buyer_agent");
  const [cpoAlias, cpoEntry] = role("cpo");
  const [payeeAlias] = role("payee");
  const sellerAgent = cfg.sellerAgent ?? "jupiterSellerAgent";

  const ACTORS = {
    runner: { id: "runner", account: null },
    vlei: { id: "vlei", account: null },
    seller: { id: sellerAgent, account: null },
    agent: { id: agentAlias, account: agentEntry?.account },
    cpo: { id: cpoAlias, account: cpoEntry?.account },
    registrar: { id: "vlei_registrar", account: cfg.accounts.registrar },
    contract: { id: "contract", account: cfg.contractId },
    payee: { id: payeeAlias ?? "payee", account: cfg.accounts.payee },
  };
  const fmt = (u) => formatUnits(u, decimals);
  const runs = new Map();
  let active = null;
  let counter = 0;

  async function invoices() {
    const ev = deps.loadEvidence();
    const saids = evidenceInvoices(ev).map((i) => i.said);
    const chain = Object.fromEntries(await Promise.all(saids.map(async (s) => [s, await deps.getInvoice(s)])));
    return { evidence: ev, list: listInvoices(ev, chain, { decimals, demoScale, realCurrency: cfg.realCurrency }) };
  }

  function newRun(mode) {
    const id = `run-${Date.now().toString(36)}-${(++counter).toString(36)}`;
    const run = { id, mode, plan: mode === "issue" ? STEPS_B : STEPS, state: "running", events: [], listeners: new Set(), seq: 0, said: null, waiter: null, createdAt: new Date().toISOString() };
    runs.set(id, run);
    if (runs.size > keepRuns) {
      for (const [k, r] of runs) {
        if (runs.size <= keepRuns) break;
        if (r.state === "finished") runs.delete(k);
      }
    }
    return run;
  }

  function emit(run, type, data) {
    const ev = { type, data: { runId: run.id, seq: ++run.seq, ts: new Date().toISOString(), ...data } };
    run.events.push(ev);
    for (const l of run.listeners) l(ev);
    onLog({ runId: run.id, type, ...(data.step ? { step: data.step, status: data.status } : { state: data.state, result: data.result }) });
  }

  function step(run, name, status, actor, target, text, extra = {}) {
    const index = run.plan.indexOf(name) + (run.mode === "issue" ? 0 : 1);
    emit(run, "step", { step: name, index, status, actor, target, text, ...extra });
  }

  function finish(run, result, text, extra = {}) {
    run.state = "finished";
    run.result = result;
    emit(run, "run", { state: "finished", mode: run.mode, result, text, said: run.said, ...extra });
    if (active === run) active = null;
  }

  const httpApi = (service, method, path, http) => ({ service, method, path: http.url ? `${http.url}${path}` : path, httpStatus: http.status ?? null, ms: http.ms ?? null });
  const evidenceApi = () => ({ service: "evidence", method: "read", path: cfg.paths?.evidence ?? "evidence" });

  // ---------------------------------------------------------------- start

  async function start({ said, text, mode } = {}) {
    if (active) throw new RunnerError(409, "a run is already active", { activeRunId: active.id });
    if (mode !== undefined && !["invoice", "issue"].includes(mode)) throw new RunnerError(400, 'mode must be "invoice" or "issue"');
    if (said === undefined && (typeof text !== "string" || !text.trim())) throw new RunnerError(400, "give said or text");
    if (said !== undefined && typeof said !== "string") throw new RunnerError(400, "said must be a string");
    if (text !== undefined && (typeof text !== "string" || text.length > 500)) throw new RunnerError(400, "text must be a string of at most 500 characters");
    if (mode === "issue") {
      if (said !== undefined) throw new RunnerError(400, 'mode "issue" creates a new invoice: send {text, mode:"issue"} without said');
      return startIssue(text.trim());
    }

    const { evidence, list } = await invoices();
    let invoice;
    let parsed;
    let error;
    if (said !== undefined) {
      invoice = list.find((i) => i.said === said);
      if (!invoice) throw new RunnerError(404, "no issued invoice with this SAID in the evidence");
      if (!invoice.runnable) throw new RunnerError(409, `${invoice.invoiceNumber} is ${invoice.status}, it cannot be run again`, { invoice });
    } else {
      parsed = parseRequest(text.trim(), { decimals, demoScale });
      ({ invoice, error } = matchInvoice(list, parsed));
    }

    const run = newRun("invoice");
    active = run;
    if (!invoice) {
      emit(run, "run", { state: "started", mode: run.mode, steps: run.plan, said: null, request: { text, parsed } });
      finish(run, "no_match", error);
      return run;
    }
    run.said = invoice.said;
    let mandate;
    try {
      mandate = await deps.getMandate(ACTORS.agent.account);
    } catch (e) {
      emit(run, "run", { state: "started", mode: run.mode, steps: run.plan, said: invoice.said, invoice, ...(parsed ? { request: { text, parsed } } : {}) });
      finish(run, "error", `cannot read the agent mandate: ${e.message}`);
      return run;
    }
    emit(run, "run", {
      state: "started",
      mode: run.mode,
      steps: run.plan,
      said: invoice.said,
      invoice,
      mandate: mandateView(mandate),
      ...(parsed ? { request: { text, parsed } } : {}),
    });
    executeA(run, evidence, invoice).catch((e) => {
      if (run.state !== "finished") finish(run, "error", `runner error: ${e.message}`);
    });
    return run;
  }

  function mandateView(m) {
    return m && { account: ACTORS.agent.account, limitUnits: m.limit_units, limit: fmt(m.limit_units), revoked: m.revoked, approver: m.approver };
  }

  /** Amount rules for Phase B (before anything is issued). Returns {units} or {result, error}. */
  function issueAmount(parsed) {
    if (parsed.amountError) return { result: "bad_amount", error: parsed.amountError };
    if (!parsed.amountUnits) return { result: "no_amount", error: "No amount given: the request names no amount ($<n>, <n> USD or <n> USDC), so no invoice is issued" };
    const units = BigInt(parsed.amountUnits);
    if (units < minUnits) return { result: "bad_amount", error: `${fmt(units)} USDC is below the minimum ${fmt(minUnits)} USDC (vLEI float guard)` };
    if (units > maxUnits) return { result: "bad_amount", error: `${fmt(units)} USDC is above the maximum ${fmt(maxUnits)} USDC (--max-amount)` };
    return { units };
  }

  async function startIssue(text) {
    const parsed = parseRequest(text, { decimals, demoScale });
    const amt = issueAmount(parsed);
    const run = newRun("issue");
    active = run;
    if (amt.result) {
      emit(run, "run", { state: "started", mode: run.mode, steps: run.plan, said: null, request: { text, parsed } });
      finish(run, amt.result, amt.error);
      return run;
    }
    let planned;
    try {
      planned = deps.nextInvoiceNumber(deps.loadEvidence());
    } catch (e) {
      emit(run, "run", { state: "started", mode: run.mode, steps: run.plan, said: null, request: { text, parsed } });
      finish(run, "error", `cannot determine the next invoice number: ${e.message}`, { failedStep: "preflight" });
      return run;
    }
    emit(run, "run", {
      state: "started",
      mode: run.mode,
      steps: run.plan,
      said: null,
      request: { text, parsed },
      planned: {
        invoiceNumber: planned.invoiceNumber, amount: fmt(amt.units), amountUnits: amt.units.toString(), currency: "USDC",
        description: lineItemDescription({ item: parsed.item, quantity: parsed.quantity, units: amt.units, decimals, demoScale }),
      },
    });
    executeB(run, amt.units, parsed).catch((e) => {
      if (run.state !== "finished") finish(run, "error", `runner error: ${e.message}`, { failedStep: run.currentStep });
    });
    return run;
  }

  // ---------------------------------------------------------------- shared steps

  /** register → pay → outcome → (decision). Returns nothing; finishes the run. */
  async function registerPayDecide(run, invoice, { refusalResult }) {
    const amountText = `${invoice.amount} ${invoice.currency}`;

    run.currentStep = "register";
    step(run, "register", "running", ACTORS.registrar, ACTORS.contract, "Checking the credential (SAID recompute + R-IPEX) and registering it on NEAR",
      { api: { service: "bridge", method: "POST", path: "/register" } });
    const { body: reg, http: regHttp } = unwrap(await deps.bridgeRegister(invoice.said));
    const regApi = httpApi("bridge", "POST", "/register", regHttp);
    if (!reg.ok) {
      step(run, "register", "failed", ACTORS.registrar, ACTORS.contract, `Bridge refused: ${reg.reason || reg.error}`,
        { api: regApi, txUrl: reg.txUrl, txHash: reg.txHash, data: { checks: reg.checks, raw: proofJson(reg) } });
      return finish(run, refusalResult, reg.reason || reg.error, { failedStep: "register" });
    }
    if (reg.alreadyRegistered) {
      step(run, "register", "skipped", ACTORS.registrar, ACTORS.contract, "Already registered on NEAR", { api: regApi, data: { checks: reg.checks, raw: proofJson(reg) } });
    } else {
      step(run, "register", "done", ACTORS.registrar, ACTORS.contract, `All vLEI checks passed; invoice registered on NEAR (${amountText})`,
        { api: regApi, txUrl: reg.txUrl, txHash: reg.txHash, data: { checks: reg.checks, raw: proofJson(reg) } });
    }

    run.currentStep = "pay";
    step(run, "pay", "running", ACTORS.agent, ACTORS.contract, `Paying ${amountText} under the agent mandate`, { api: { service: "signer", method: "POST", path: "/pay" } });
    const { body: pay, http: payHttp } = unwrap(await deps.signerPay(invoice.said));
    const payApi = httpApi("signer", "POST", "/pay", payHttp);
    if (!pay.ok) {
      step(run, "pay", "failed", ACTORS.agent, ACTORS.contract, `Payment not sent: ${pay.error}`, { api: payApi, txUrl: pay.txUrl, txHash: pay.txHash, data: { raw: proofJson(pay) } });
      return finish(run, "error", pay.error, { txUrl: pay.txUrl, failedStep: "pay" });
    }
    step(run, "pay", "done", ACTORS.agent, ACTORS.contract, `Sent ${amountText} with ft_transfer_call`, { api: payApi, txUrl: pay.txUrl, txHash: pay.txHash, data: { raw: proofJson(pay) } });

    run.currentStep = "outcome";
    const o = pay.outcome || {};
    const outApi = { service: "contract", method: "tx-logs", path: `${cfg.contractId} EVENT_JSON (from /pay)`, httpStatus: payHttp.status ?? null, ms: null };
    if (o.event === "paid") {
      step(run, "outcome", "done", ACTORS.contract, ACTORS.payee, `Within the agent's limit: ${amountText} forwarded to ${ACTORS.payee.account}`,
        { api: outApi, txUrl: pay.txUrl, txHash: pay.txHash, data: { event: "paid", via: o.via, amountUnits: o.amount_units } });
      return finish(run, "paid", `${invoice.invoiceNumber} paid within the agent's limit`, { txUrl: pay.txUrl });
    }
    if (o.event === "payment_refused") {
      const back = pay.refundedUnits ? `${fmt(pay.refundedUnits)} USDC returned to the agent` : "amount returned to the agent";
      step(run, "outcome", "failed", ACTORS.contract, ACTORS.agent, `Refused by the contract: ${o.reason} — ${back}`,
        { api: outApi, txUrl: pay.txUrl, txHash: pay.txHash, data: { event: "payment_refused", reason: o.reason, refundedUnits: pay.refundedUnits } });
      return finish(run, "refused", o.reason, { txUrl: pay.txUrl });
    }
    if (o.event !== "payment_pending") {
      step(run, "outcome", "failed", ACTORS.contract, ACTORS.agent, "No contract outcome in the transaction logs", { api: outApi, txUrl: pay.txUrl, txHash: pay.txHash });
      return finish(run, "error", "no contract outcome", { txUrl: pay.txUrl, failedStep: "outcome" });
    }
    step(run, "outcome", "waiting", ACTORS.contract, ACTORS.cpo,
      `Above the agent's limit (${amountText} > ${fmt(o.limit_units)}): escalated to the approver ${o.approver}; funds held by the contract`,
      { api: outApi, txUrl: pay.txUrl, txHash: pay.txHash, data: { event: "payment_pending", limitUnits: o.limit_units, approver: o.approver, amountUnits: o.amount_units } });

    run.currentStep = "decision";
    run.state = "waiting";
    const resolved = await waitForDecision(run, invoice);
    if (resolved.kind === "cancelled") return finish(run, "cancelled", "Run cancelled; the invoice stays pending on NEAR and can still be approved or rejected via the signer");
    if (resolved.kind === "timeout") return finish(run, "timeout", `No decision within ${Math.round(waitTimeoutMs / 60000)} min; the invoice stays pending on NEAR`);
    const link = resolved.txUrl ? { txUrl: resolved.txUrl, txHash: resolved.txHash } : {};
    const outside = resolved.txUrl ? "" : " (decided outside the runner)";
    const decApi = resolved.api || { service: "near-rpc", method: "view", path: `${cfg.contractId}.get_invoice (poll every ${pollMs} ms)` };
    if (resolved.status === "paid") {
      step(run, "decision", "done", ACTORS.cpo, ACTORS.contract, `Approved by ${ACTORS.cpo.id}: ${amountText} forwarded to ${ACTORS.payee.account}${outside}`,
        { api: decApi, ...link, data: { decision: "approve", event: "paid", via: "approved", ...(resolved.raw ? { raw: resolved.raw } : {}) } });
      return finish(run, "paid", `${invoice.invoiceNumber} paid after approval`, link);
    }
    step(run, "decision", "done", ACTORS.cpo, ACTORS.contract, `Rejected by ${ACTORS.cpo.id}: ${amountText} refunded to the agent${outside}`,
      { api: decApi, ...link, data: { decision: "reject", event: "payment_rejected", refunded: true, ...(resolved.raw ? { raw: resolved.raw } : {}) } });
    return finish(run, "rejected", `${invoice.invoiceNumber} rejected and refunded`, link);
  }

  function offerData(inv, invoice, grantSaid) {
    return { invoiceNumber: invoice.invoiceNumber, amount: invoice.amount, amountUnits: invoice.amountUnits, currency: invoice.currency, said: invoice.said, grantSaid, issuerAid: inv?.issuerAid, holderAid: inv?.holderAid, dueDate: invoice.dueDate };
  }

  // ---------------------------------------------------------------- Phase A

  async function executeA(run, evidence, invoice) {
    const inv = evidenceInvoices(evidence).find((i) => i.said === invoice.said);
    const ipex = inv.ipex || {};
    const amountText = `${invoice.amount} ${invoice.currency}`;

    step(run, "offer", "done", ACTORS.seller, ACTORS.agent,
      `Invoice ${invoice.invoiceNumber} for ${amountText} (${invoice.realAmount} at demo scale), issued as vLEI credential ${invoice.said} and offered by IPEX grant`,
      { history: true, api: evidenceApi(), data: offerData(inv, invoice, ipex.grantSaid) });

    const accepted = ipex.admitSuccess === true && ipex.credentialHeld === true;
    step(run, "accept", accepted ? "done" : "failed", ACTORS.agent, ACTORS.seller,
      accepted ? `Admitted the IPEX grant and holds credential ${invoice.said}` : `IPEX admit ${ipex.admitSuccess} / credential held ${ipex.credentialHeld} — the bridge will refuse`,
      { history: true, api: evidenceApi(), data: { admitSuccess: ipex.admitSuccess === true, credentialHeld: ipex.credentialHeld === true, admitGrantSaid: ipex.admitGrantSaid } });

    return registerPayDecide(run, invoice, { refusalResult: "register_refused" });
  }

  // ---------------------------------------------------------------- Phase B

  async function executeB(run, units, parsed = {}) {
    const amountText = `${fmt(units)} USDC`;
    const fail = (name, actor, target, text, extra) => {
      step(run, name, "failed", actor, target, text, extra);
      finish(run, "error", text, { failedStep: name });
    };

    // 0. preflight
    run.currentStep = "preflight";
    step(run, "preflight", "running", ACTORS.runner, ACTORS.runner, "Checking signer, bridge, NEAR, Docker/KERIA, vLEI tools, evidence and the agent mandate",
      { api: { service: "runner", method: "GET", path: "/preflight" } });
    const t0 = Date.now();
    const pf = await deps.preflight();
    const pfApi = { service: "runner", method: "GET", path: "/preflight", httpStatus: null, ms: Date.now() - t0 };
    const bad = pf.checks.filter((c) => !c.ok);
    if (!pf.ok) {
      return fail("preflight", ACTORS.runner, ACTORS.runner, `Preflight failed: ${bad.map((c) => `${c.name} (${c.detail})`).join("; ")} — nothing issued`, { api: pfApi, data: { checks: pf.checks } });
    }
    const revoked = pf.mandate?.revoked === true;
    step(run, "preflight", "done", ACTORS.runner, ACTORS.runner,
      `All ${pf.checks.length} checks passed${revoked ? " — note: the agent mandate is revoked, the contract will refuse the payment" : ""}`,
      { api: pfApi, data: { checks: pf.checks, mandate: mandateView(pf.mandate) } });

    // 1. issue (existing vLEI script)
    run.currentStep = "issue";
    let planned;
    let written;
    try {
      planned = deps.nextInvoiceNumber(deps.loadEvidence());
      written = deps.writeInvoiceConfig(planned.invoiceNumber, units, { item: parsed.item, quantity: parsed.quantity });
    } catch (e) {
      return fail("issue", ACTORS.seller, ACTORS.vlei, `Could not write the invoice config: ${e.message}`, { api: { service: "fs", method: "write", path: "appconfig/generated-runs/" } });
    }
    const issueCmd = `bash issue-additional-invoice.sh --invoice-config ${written.relPath}`;
    step(run, "issue", "running", ACTORS.seller, ACTORS.vlei, `Issuing ${planned.invoiceNumber} for ${amountText} as a vLEI credential (issue → IPEX grant → admit → issuance proof)`,
      { api: { service: "vlei", cmd: issueCmd }, data: { invoiceNumber: planned.invoiceNumber, configFile: written.relPath, description: written.description, nextInvoice: planned.highest } });
    const is = await deps.runIssue(written.relPath);
    const issueApi = { service: "vlei", cmd: issueCmd, exitCode: is.exitCode, ms: is.ms, ...(is.timedOut ? { timedOut: true } : {}) };
    const issued = is.exitCode === 0 ? parseIssueOutput(is.stdout) : null;
    const issueRaw = proofTail(`${is.stdout}\n${is.stderr}`);
    if (!issued || issued.invoiceNumber !== planned.invoiceNumber) {
      const why = is.timedOut ? "timed out" : is.spawnError ? is.spawnError : is.exitCode !== 0 ? `exit code ${is.exitCode}` : "success line not found";
      return fail("issue", ACTORS.seller, ACTORS.vlei, `vLEI issue failed (${why})`, { api: issueApi, data: { invoiceNumber: planned.invoiceNumber, configFile: written.relPath, raw: issueRaw } });
    }
    run.said = issued.said;
    step(run, "issue", "done", ACTORS.seller, ACTORS.vlei, `${issued.invoiceNumber} issued as credential ${issued.said}, granted, admitted and held`,
      { api: issueApi, data: { invoiceNumber: issued.invoiceNumber, said: issued.said, configFile: written.relPath, description: written.description, raw: issueRaw } });

    // 2. offer (IPEX grant from the archived grant file)
    run.currentStep = "offer";
    let grant = null;
    try {
      grant = deps.readGrantInfo(issued.said);
    } catch {
      grant = null;
    }
    const offerApi = { service: "vlei-task-data", method: "read", path: grant?.path ?? `task-data/${sellerAgent}-ipex-grant-info.${issued.said}.json` };
    if (!grant?.grantSaid) return fail("offer", ACTORS.seller, ACTORS.agent, `No IPEX grant found for ${issued.said}`, { api: offerApi });
    step(run, "offer", "done", ACTORS.seller, ACTORS.agent, `Invoice ${issued.invoiceNumber} for ${amountText} offered by IPEX grant ${grant.grantSaid}`,
      { api: offerApi, data: { invoiceNumber: issued.invoiceNumber, amount: fmt(units), amountUnits: units.toString(), currency: "USDC", said: issued.said, grantSaid: grant.grantSaid, grantedAt: grant.timestamp } });

    // 3. export (Windows node, strict)
    run.currentStep = "export";
    const exportCmd = deps.exportCmd ?? "node.exe export-signatory-evidence.js --strict --out ../UI/data/signatory-evidence.json";
    step(run, "export", "running", ACTORS.runner, ACTORS.vlei, "Exporting the vLEI evidence (strict: KELs, OOR delegations, IPEX, issuance proofs)", { api: { service: "vlei", cmd: exportCmd } });
    const ex = await deps.runExport();
    const exApi = { service: "vlei", cmd: exportCmd, exitCode: ex.exitCode, ms: ex.ms, ...(ex.timedOut ? { timedOut: true } : {}) };
    const exRaw = proofTail(`${ex.stdout}\n${ex.stderr}`);
    let evidence;
    try {
      evidence = deps.loadEvidence();
    } catch (e) {
      evidence = null;
    }
    const inv = evidence && evidenceInvoices(evidence).find((i) => i.said === issued.said);
    if (ex.exitCode !== 0 || !/All checks passed\./.test(ex.stdout) || !inv) {
      const why = ex.timedOut ? "timed out" : ex.spawnError ? ex.spawnError : ex.exitCode !== 0 ? `exit code ${ex.exitCode}` : !inv ? "new invoice not in the export" : '"All checks passed." not printed';
      return fail("export", ACTORS.runner, ACTORS.vlei, `Strict export failed (${why})`, { api: exApi, data: { raw: exRaw } });
    }
    step(run, "export", "done", ACTORS.runner, ACTORS.vlei, `Strict export passed: ${evidenceInvoices(evidence).length} invoices, all checks passed`,
      { api: exApi, data: { generatedAt: evidence.generatedAt, raw: exRaw } });

    // 4–6. verification from the fresh export
    const companies = evidence.companies || [];
    const agents = companies.flatMap((c) => c.agents || []);
    const officers = companies.flatMap((c) => c.officers || []);
    const agentProof = (alias) => {
      const a = agents.find((x) => x.alias === alias);
      const officer = a && officers.find((o) => o.aid === a.delegator);
      return { agent: a, officer, ok: !!(a && a.delegationVerified === true && officer && officer.oorCredential?.said) };
    };
    const evApi = { service: "evidence", method: "read", path: cfg.paths?.evidence ?? "evidence" };

    run.currentStep = "verify_seller";
    const sp = agentProof(sellerAgent);
    const from = inv.issuerDelegatedFrom || {};
    const sellerOk = sp.ok && inv.issuerAid === sp.agent.aid && from.officerAid === sp.officer.aid && from.officerOorSaid === sp.officer.oorCredential.said && inv.issuanceVerified === true;
    const sellerData = {
      agent: sellerAgent, agentAid: sp.agent?.aid, delegationVerified: sp.agent?.delegationVerified === true,
      officer: sp.officer?.alias, officerAid: sp.officer?.aid, officerOorSaid: sp.officer?.oorCredential?.said,
      issuanceVerified: inv.issuanceVerified === true, issuanceAnchor: inv.issuance?.anchor ?? null,
    };
    if (!sellerOk) return fail("verify_seller", ACTORS.agent, ACTORS.seller, "Seller verification failed (delegation, OOR or issuance proof)", { api: evApi, data: sellerData });
    step(run, "verify_seller", "done", ACTORS.agent, ACTORS.seller,
      `${sellerAgent} is delegated (KEL verified) from ${sp.officer.alias} who holds OOR ${sp.officer.oorCredential.said}; invoice issuance anchored in the seller KEL`,
      { api: evApi, data: sellerData });

    run.currentStep = "verify_buyer";
    const bp = agentProof(agentAlias);
    const buyerData = { agent: agentAlias, agentAid: bp.agent?.aid, delegationVerified: bp.agent?.delegationVerified === true, officer: bp.officer?.alias, officerAid: bp.officer?.aid, officerOorSaid: bp.officer?.oorCredential?.said };
    if (!bp.ok || inv.holderAid !== bp.agent.aid) return fail("verify_buyer", ACTORS.seller, ACTORS.agent, "Buyer verification failed (delegation, OOR or holder)", { api: evApi, data: buyerData });
    step(run, "verify_buyer", "done", ACTORS.seller, ACTORS.agent,
      `${agentAlias} is delegated (KEL verified) from ${bp.officer.alias} who holds OOR ${bp.officer.oorCredential.said}`, { api: evApi, data: buyerData });

    run.currentStep = "accept";
    const ipex = inv.ipex || {};
    const accData = { admitSuccess: ipex.admitSuccess === true, credentialHeld: ipex.credentialHeld === true, admitGrantSaid: ipex.admitGrantSaid, grantSaid: ipex.grantSaid };
    if (!(accData.admitSuccess && accData.credentialHeld)) return fail("accept", ACTORS.agent, ACTORS.seller, `IPEX admit ${ipex.admitSuccess} / credential held ${ipex.credentialHeld}`, { api: evApi, data: accData });
    step(run, "accept", "done", ACTORS.agent, ACTORS.seller, `Admitted IPEX grant ${ipex.grantSaid} and holds credential ${issued.said}`, { api: evApi, data: accData });

    // 7–10. NEAR
    const listed = listInvoices(evidence, { [issued.said]: null }, { decimals, demoScale, realCurrency: cfg.realCurrency }).find((i) => i.said === issued.said);
    return registerPayDecide(run, listed, { refusalResult: "error" });
  }

  // ---------------------------------------------------------------- escalation

  function waitForDecision(run, invoice) {
    return new Promise((resolveWait) => {
      let done = false;
      const resolve = (v) => {
        if (done) return;
        done = true;
        run.waiter = null;
        resolveWait(v);
      };
      run.waiter = { resolve, invoice };
      const deadline = Date.now() + waitTimeoutMs;
      (async () => {
        while (!done) {
          if (Date.now() >= deadline) return resolve({ kind: "timeout" });
          await deps.sleep(pollMs);
          if (done) return;
          try {
            const chain = await deps.getInvoice(invoice.said);
            if (!done && chain && chain.status !== "pending" && !run.deciding) resolve({ kind: "decided", status: chain.status });
          } catch {
            /* transient RPC error: keep polling */
          }
        }
      })();
    });
  }

  async function decide(id, decision) {
    const run = runs.get(id);
    if (!run) throw new RunnerError(404, "no such run");
    if (run.state !== "waiting" || !run.waiter) throw new RunnerError(409, `run is ${run.state}, not waiting for a decision`);
    if (!["approve", "reject"].includes(decision)) throw new RunnerError(400, "decision must be approve or reject");
    if (run.deciding) throw new RunnerError(409, "a decision is already being sent");
    run.deciding = true;
    try {
      const { body: r, http } = unwrap(await deps.signerDecide(decision, run.said));
      const api = httpApi("signer", "POST", `/${decision}`, http);
      if (!r.ok) {
        step(run, "decision", "failed", ACTORS.cpo, ACTORS.contract, `${decision} not applied: ${r.error}; still waiting for a decision`,
          { api, txUrl: r.txUrl, txHash: r.txHash, data: { decision, raw: proofJson(r) } });
        return { ok: false, error: r.error, txUrl: r.txUrl };
      }
      run.waiter?.resolve({ kind: "decided", status: decision === "approve" ? "paid" : "rejected", txUrl: r.txUrl, txHash: r.txHash, api, raw: proofJson(r) });
      return { ok: true, txUrl: r.txUrl, txHash: r.txHash };
    } finally {
      run.deciding = false;
    }
  }

  function cancel(id) {
    const run = runs.get(id);
    if (!run) throw new RunnerError(404, "no such run");
    if (run.state !== "waiting" || !run.waiter) throw new RunnerError(409, `run is ${run.state}; only a run waiting for a decision can be cancelled`);
    if (run.deciding) throw new RunnerError(409, "a decision is being sent");
    run.waiter.resolve({ kind: "cancelled" });
    return { ok: true };
  }

  function subscribe(id, listener, afterSeq = 0) {
    const run = runs.get(id);
    if (!run) throw new RunnerError(404, "no such run");
    for (const ev of run.events) if (ev.data.seq > afterSeq) listener(ev);
    run.listeners.add(listener);
    return () => run.listeners.delete(listener);
  }

  return {
    start,
    decide,
    cancel,
    subscribe,
    issueAmount,
    invoices: async () => (await invoices()).list,
    get: (id) => runs.get(id),
    get active() {
      return active;
    },
    summary: (run) => run && { runId: run.id, mode: run.mode, state: run.state, said: run.said, result: run.result, createdAt: run.createdAt, events: run.seq },
  };
}

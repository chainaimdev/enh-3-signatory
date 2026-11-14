// S-7 runner engine: one run at a time; every step is a real action or real evidence, with an `api` proof block.
//   mode "invoice" (Phase A): pay a pre-issued invoice — steps offer, accept, register, pay, outcome, decision (index 1..6)
//   mode "issue"   (Phase B, business order S-7C): issue a new vLEI invoice per request — steps 0..10:
//     preflight (event only when it FAILS; when it passes its result is inside `request`), request,
//     verify_buyer (before anything is issued), issue, offer, verify_seller (runs the strict export), accept,
//     register, pay, outcome, decision
//   Every step's `api` carries orchestrator:"runner (no keys)"; the runner is never the actor except a failed preflight.
// Network/process access is injected (deps) so the engine is unit-testable without keys:
//   deps.loadEvidence() · deps.getInvoice(said) · deps.getMandate(account)
//   deps.bridgeRegister(said) / deps.signerPay(said) / deps.signerDecide(kind, said)
//       → response JSON, optionally with `_http: {status, ms, url}` (stripped before use)
//   deps.sleep(ms)
//   Phase B only: deps.preflight() → {ok, checks, mandate} · deps.nextInvoiceNumber(evidence) → {invoiceNumber, highest}
//                 deps.writeInvoiceConfig(invoiceNumber, units) → {path, relPath}
//                 deps.runIssue(relPath) / deps.runExport() → {exitCode, timedOut, stdout, stderr, ms, cmd}
//                 deps.runVerifyBuyer(runId) → {exitCode, timedOut, stdout, stderr, ms, cmd, evidence|null}
//                 deps.readGrantInfo(said) → {grantSaid, path, timestamp} | null
//   Change #3 (only when the runner runs with --ap2 on; absent otherwise, and every flow is unchanged):
//                 deps.ap2Checkout(said) → bridge POST /checkout · deps.ap2Mandate({said, checkout, merchantAuthorization})
//                 → signer POST /mandate. Used inside the Phase B `accept` step, after verify_seller.
//   Change #4 mode "order" (purchase order → swarm → negotiation → treasury → the Phase B steps from verify_buyer):
//                 deps.orderBook (swarm.mjs loadOrderBook) · deps.propose (llm.mjs proposer, or null = DD5 rules only)
//                 · deps.negotiator ("rules" | "llm"). Steps: preflight, request, verify_buyer, swarm, negotiate
//                 (verify_seller_agent on the seller's first answer, #4c-2), escalation, treasury, issue … decision.
//                 A failed negotiation waits for the officer (decide approve/reject).
import { formatUnits } from "../../scripts/lib/common.mjs";
import { negotiate, usd } from "../shared/negotiate.mjs";
import { preDealChecks, treasuryChecks } from "./swarm.mjs";
import { evidenceInvoices } from "../bridge/rules.mjs";
import { listInvoices, matchInvoice, parseRequest } from "./logic.mjs";
import { agentChain, lineItemDescription, parseIssueOutput, proofJson, proofTail } from "./vlei.mjs";

export const ORCHESTRATOR = "runner (no keys)";
export const STEPS = ["offer", "accept", "register", "pay", "outcome", "decision"];
export const STEPS_B = ["preflight", "request", "verify_buyer", "issue", "offer", "verify_seller", "accept", "register", "pay", "outcome", "decision"];
// change #4: purchase order with a negotiation in front of the Phase B steps
// change #4c/#4c-2: each party verifies the other when its first message arrives: the seller verifies the buyer on the
// request (before the swarm and any answer); the buyer verifies the seller agent on the seller's first answer (inside
// negotiate, before replying);
// verify_seller after issue still proves that this seller agent issued this invoice.
export const STEPS_C = ["preflight", "request", "verify_buyer", "swarm", "negotiate", "verify_seller_agent", "escalation", "treasury", "issue", "offer", "verify_seller", "accept", "register", "pay", "outcome", "decision"];

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
  paceMs = 0, // change #4: pause between swarm checks / negotiation moves so a demo can follow them (--pace-ms)
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
    const run = { id, mode, plan: mode === "order" ? STEPS_C : mode === "issue" ? STEPS_B : STEPS, state: "running", events: [], listeners: new Set(), seq: 0, said: null, waiter: null, createdAt: new Date().toISOString() };
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
    const index = run.plan.indexOf(name) + (run.mode === "invoice" ? 1 : 0);
    const api = { ...(extra.api || {}), orchestrator: ORCHESTRATOR };
    emit(run, "step", { step: name, index, status, actor, target, text, ...extra, api });
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

  async function start({ said, text, mode, order } = {}) {
    if (active) throw new RunnerError(409, "a run is already active", { activeRunId: active.id });
    if (mode !== undefined && !["invoice", "issue", "order"].includes(mode)) throw new RunnerError(400, 'mode must be "invoice", "issue" or "order"');
    if (mode === "order") return startOrder(order); // change #4
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

  // ---------------------------------------------------------------- change #4: purchase order

  function startOrder(orderId) {
    if (!deps.orderBook || !deps.preflight) throw new RunnerError(501, "order mode not configured");
    if (typeof orderId !== "string") throw new RunnerError(400, 'mode "order" needs {order: "<id>"}');
    const order = deps.orderBook.orders.find((o) => o.id === orderId);
    if (!order) throw new RunnerError(404, `no order ${orderId} (have ${deps.orderBook.orders.map((o) => o.id).join(", ")})`);
    const run = newRun("order");
    active = run;
    emit(run, "run", {
      state: "started", mode: run.mode, steps: run.plan, said: null,
      order: { ...order, item: deps.orderBook.product.item, productCode: deps.orderBook.product.code, budget: usd(order.buyerBudgetCents), opening: usd(order.buyerOpeningCents) },
      negotiator: deps.negotiator ?? "rules",
    });
    executeOrder(run, order).catch((e) => {
      if (run.state !== "finished") finish(run, "error", `runner error: ${e.message}`, { failedStep: run.currentStep });
    });
    return run;
  }

  async function executeOrder(run, order) {
    const book = deps.orderBook;
    const fail = (name, actor, target, text, extra, result = "error", finishText = text) => {
      step(run, name, "failed", actor, target, text, extra);
      finish(run, result, finishText, { failedStep: name });
    };
    const qty = order.quantity.toLocaleString("en-US");
    const pace = () => (paceMs > 0 ? deps.sleep(paceMs) : Promise.resolve());

    // 0. preflight (same checks as Phase B)
    run.currentStep = "preflight";
    const t0 = Date.now();
    const pf = await deps.preflight();
    const pfMs = Date.now() - t0;
    const pfApi = { service: "runner", method: "GET", path: "/preflight", httpStatus: null, ms: pfMs };
    if (!pf.ok) {
      const bad = pf.checks.filter((c) => !c.ok);
      return fail("preflight", ACTORS.runner, ACTORS.runner, `Preflight failed: ${bad.map((c) => `${c.name} (${c.detail})`).join("; ")} — nothing ordered`, { api: pfApi, data: { checks: pf.checks } });
    }

    // 1. request: the buyer agent's purchase order (unsigned request)
    run.currentStep = "request";
    step(run, "request", "done", ACTORS.agent, ACTORS.seller,
      `Purchase order ${order.id}: ${qty} units ${book.product.item} (${book.product.code}) — opening offer $${usd(order.buyerOpeningCents)}/unit (unsigned request)`,
      { api: pfApi, data: { signed: false, label: "unsigned request", order: order.id, quantity: order.quantity, item: book.product.item, productCode: book.product.code, openingCents: order.buyerOpeningCents, basedOn: order.basedOn, preflight: { ok: true, ms: pfMs, checks: pf.checks }, mandate: mandateView(pf.mandate) } });

    // 2. verify_buyer — the seller verifies the buyer agent BEFORE talking price (#4c)
    const vbr = await verifyBuyer(run, fail, "No negotiation, nothing issued.");
    if (!vbr.ok) return;

    const evidence = vbr.evidence;

    // 3. swarm (seller side, before its first answer): inventory + logistics
    run.currentStep = "swarm";
    const swarmApi = { service: "swarm", method: "read", path: "data/dd5/DEMO-DATA (inventory, logistics)" };
    const pre = preDealChecks({ book, order, evidence });
    for (let i = 0; i < pre.length && paceMs > 0; i++) {
      step(run, "swarm", "running", ACTORS.seller, ACTORS.agent, `Checking: ${pre.slice(0, i + 1).map((c) => c.agent).join(", ")}…`, { api: swarmApi, data: { checks: pre.slice(0, i + 1) } });
      await pace();
    }
    if (!pre.every((c) => c.ok)) {
      return fail("swarm", ACTORS.seller, ACTORS.agent, `Swarm check failed: ${pre.filter((c) => !c.ok).map((c) => c.text).join("; ")}`, { api: swarmApi, data: { checks: pre } }, "no_deal");
    }
    step(run, "swarm", "done", ACTORS.seller, ACTORS.agent, pre.map((c) => c.text).join(" · "), { api: swarmApi, data: { checks: pre } });

    // 4. negotiate (DD5 rules; AI proposals when configured, always checked by the guard)
    // 5. verify_seller_agent (#4c-2) runs INSIDE the negotiation: when the seller's first answer reaches the buyer, the buyer
    //    verifies the seller agent BEFORE acting on it (same live export as verify_buyer). Failure stops the negotiation.
    run.currentStep = "negotiate";
    const negApi = { service: "negotiator", method: deps.negotiator === "llm" ? "ai+guard" : "rules", path: "services/shared/negotiate.mjs" };
    step(run, "negotiate", "running", ACTORS.agent, ACTORS.seller, `Negotiating ${qty} units: up to ${book.seller.maxRounds} rounds (${deps.negotiator === "llm" ? "AI proposals checked by the DD5 guard" : "DD5 rules"})`, { api: negApi, data: { moves: [] } });
    const moves = [];
    let sellerVerifiedAfter = null; // index in moves of the seller message that triggered verify_seller_agent
    const vsApi = { service: "vlei", method: "agentChain", path: `${sellerAgent} in the verify_buyer export (live KELs)` };
    const STOP = Symbol("stop");
    let neg;
    try {
      neg = await negotiate({
        order, rules: book, propose: deps.propose ?? null,
        onMove: async (m) => {
          await pace();
          moves.push(m);
          step(run, "negotiate", "running", m.from === "seller" ? ACTORS.seller : ACTORS.agent, m.from === "seller" ? ACTORS.agent : ACTORS.seller,
            `Round ${m.round} · ${m.from === "seller" ? sellerAgent : agentAlias}: ${m.action}${m.price != null ? ` $${usd(m.price)}` : ""}`,
            { api: negApi, data: { move: m, moves: [...moves], sellerVerifiedAfter } });
          if (m.from !== "seller" || sellerVerifiedAfter !== null) return;
          // first message from the seller reached the buyer → verify the sender before acting on it
          const trigger = `${sellerAgent}'s round ${m.round} ${m.action.toLowerCase()}${m.price != null ? ` $${usd(m.price)}` : ""}`;
          run.currentStep = "verify_seller_agent";
          step(run, "verify_seller_agent", "running", ACTORS.agent, ACTORS.seller, `First message from ${sellerAgent} received (${trigger}) — verifying the sender before replying`, { api: vsApi, data: { trigger } });
          await pace();
          const sc = agentChain(vbr.evidence, sellerAgent);
          if (!sc.ok) {
            fail("verify_seller_agent", ACTORS.agent, ACTORS.seller, `Buyer refused: seller agent not verified — ${sc.reason}. The answer (${trigger}) is ignored; nothing issued.`,
              { api: vsApi, data: { ...sc.data, trigger } }, "buyer_refused", `buyer refused: seller agent not verified — ${sc.reason}`);
            throw STOP;
          }
          const sd = sc.data;
          sellerVerifiedAfter = moves.length - 1;
          step(run, "verify_seller_agent", "done", ACTORS.agent, ACTORS.seller,
            `${sellerAgent} verified on its first message (${trigger}): delegated (live KEL) from ${sd.officer}, who holds OOR ${sd.officerOorSaid} issued by the QVI; Legal Entity ${sd.legalEntity} (LEI ${sd.lei}). LE → QVI is not checked by the exporter.`,
            { api: vsApi, data: { ...sd, trigger } });
          run.currentStep = "negotiate";
        },
      });
    } catch (e) {
      if (e === STOP) return;
      throw e;
    }
    const negData = { sellerVerifiedAfter, moves: neg.moves, deal: neg.deal, priceCents: neg.priceCents ?? null, round: neg.round, reason: neg.reason ?? null, lastSellerCents: neg.lastSellerCents, lastBuyerCents: neg.lastBuyerCents, negotiator: deps.negotiator ?? "rules" };
    let priceCents = neg.priceCents;
    if (neg.deal) {
      step(run, "negotiate", "done", ACTORS.agent, ACTORS.seller, `Agreed at $${usd(priceCents)}/unit in round ${neg.round}`, { api: negApi, data: negData });
      step(run, "escalation", "skipped", ACTORS.agent, ACTORS.cpo, "Not needed — the agents agreed", { api: negApi });
    } else {
      step(run, "negotiate", "no_deal", ACTORS.agent, ACTORS.seller, `No deal: ${neg.reason} (buyer last $${usd(neg.lastBuyerCents)}, seller last $${usd(neg.lastSellerCents)})`, { api: negApi, data: negData });
      // 6. escalation → the human officer (off-chain decision, recorded by the runner; not a KERI signature — see #15)
      run.currentStep = "escalation";
      const escApi = { service: "runner", method: "POST", path: `/runs/${run.id}/decide` };
      step(run, "escalation", "waiting", ACTORS.agent, ACTORS.cpo,
        `Escalated to ${ACTORS.cpo.id}: approve buying at the seller's last price $${usd(neg.lastSellerCents)}/unit, or reject the order`,
        { api: escApi, data: { kind: "deal", proposedCents: neg.lastSellerCents, buyerBudgetCents: order.buyerBudgetCents, reason: neg.reason, signed: false, label: "officer decision recorded by the runner (not KERI-signed)" } });
      run.state = "waiting";
      const r = await waitForDeal(run);
      run.state = "running";
      if (r.kind === "cancelled") return finish(run, "cancelled", "Run cancelled; no order placed");
      if (r.kind === "timeout") return finish(run, "timeout", `No officer decision within ${Math.round(waitTimeoutMs / 60000)} min; no order placed`);
      if (r.decision === "reject") {
        step(run, "escalation", "done", ACTORS.cpo, ACTORS.agent, `Rejected by ${ACTORS.cpo.id}: no order`, { api: escApi, data: { decision: "reject" } });
        return finish(run, "no_deal", `${order.id}: officer rejected — no order placed`);
      }
      priceCents = neg.lastSellerCents;
      step(run, "escalation", "done", ACTORS.cpo, ACTORS.agent, `Approved by ${ACTORS.cpo.id}: buy at $${usd(priceCents)}/unit`, { api: escApi, data: { decision: "approve", priceCents } });
    }

    // 7. treasury: seller treasury (profit/NPV) + buyer treasury (on-chain mandate route)
    run.currentStep = "treasury";
    const tr = treasuryChecks({ book, order, priceCents, evidence, mandate: pf.mandate, maxUnits, decimals, demoScale });
    const trApi = { service: "swarm", method: "compute", path: "treasury (orders.json inputs + get_mandate)" };
    for (let i = 0; i < tr.checks.length && paceMs > 0; i++) {
      step(run, "treasury", "running", ACTORS.seller, ACTORS.agent, `Checking: ${tr.checks.slice(0, i + 1).map((c) => c.agent).join(", ")}…`, { api: trApi, data: { checks: tr.checks.slice(0, i + 1) } });
      await pace();
    }
    if (!tr.ok) return fail("treasury", ACTORS.seller, ACTORS.agent, `Treasury refused: ${tr.checks.filter((c) => !c.ok).map((c) => c.text).join("; ")}`, { api: trApi, data: { checks: tr.checks } }, "no_deal");
    step(run, "treasury", "done", ACTORS.seller, ACTORS.agent, tr.checks.map((c) => c.text).join(" · "), { api: trApi, data: { checks: tr.checks, priceCents, quantity: order.quantity } });

    // 9–16. the Phase B steps: issue the vLEI invoice → … → pay on NEAR (buyer already verified above)
    return executeTail(run, tr.units, { item: book.product.item, quantity: order.quantity }, { buyer: vbr.bd });
  }

  function waitForDeal(run) {
    return new Promise((resolveWait) => {
      let done = false;
      const timer = setTimeout(() => resolve({ kind: "timeout" }), waitTimeoutMs);
      timer.unref?.();
      function resolve(v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        run.waiter = null;
        resolveWait(v);
      }
      run.waiter = { resolve, kind: "deal" };
    });
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
    const fail = (name, actor, target, text, extra, result = "error", finishText = text) => {
      step(run, name, "failed", actor, target, text, extra);
      finish(run, result, finishText, { failedStep: name });
    };

    // 0. preflight — a real check, folded into `request` when it passes; a failure is its own red step.
    run.currentStep = "preflight";
    const t0 = Date.now();
    const pf = await deps.preflight();
    const pfMs = Date.now() - t0;
    const pfApi = { service: "runner", method: "GET", path: "/preflight", httpStatus: null, ms: pfMs };
    if (!pf.ok) {
      const bad = pf.checks.filter((c) => !c.ok);
      return fail("preflight", ACTORS.runner, ACTORS.runner,
        `Preflight failed: ${bad.map((c) => `${c.name} (${c.detail})`).join("; ")} — nothing requested, nothing issued`,
        { api: pfApi, data: { checks: pf.checks } });
    }

    // 1. request (buyer → seller), unsigned
    run.currentStep = "request";
    let planned;
    try {
      planned = deps.nextInvoiceNumber(deps.loadEvidence());
    } catch (e) {
      return fail("request", ACTORS.agent, ACTORS.seller, `Could not determine the next invoice number: ${e.message}`, { api: pfApi, data: { preflight: { ok: true, ms: pfMs, checks: pf.checks } } });
    }
    const realUnits = (units * BigInt(demoScale)) / 10n ** BigInt(decimals);
    const realTotal = `${Number(realUnits).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
    const what = parsed.item ? `${parsed.quantity ? `${parsed.quantity.toLocaleString("en-US")} ` : ""}${parsed.item}` : "an order";
    const revoked = pf.mandate?.revoked === true;
    step(run, "request", "done", ACTORS.agent, ACTORS.seller,
      `Request: ${what}, real total ${realTotal} → ${amountText} on NEAR (unsigned request)${revoked ? " — note: the agent mandate is revoked, the contract will refuse the payment" : ""}`,
      {
        api: { ...pfApi, path: "/preflight + /next-invoice" },
        data: {
          signed: false, label: "unsigned request",
          item: parsed.item ?? null, quantity: parsed.quantity ?? null, realTotal, amount: fmt(units), amountUnits: units.toString(), currency: "USDC",
          description: lineItemDescription({ item: parsed.item, quantity: parsed.quantity, units, decimals, demoScale }),
          nextInvoiceNumber: planned.invoiceNumber, nextInvoiceSources: planned.highest,
          preflight: { ok: true, ms: pfMs, checks: pf.checks }, mandate: mandateView(pf.mandate),
        },
      });

    return executeTail(run, units, parsed);
  }

  /** Seller verifies the buyer agent (existing strict exporter, live KELs). Returns {ok, bd, evidence}; on failure the run is finished. */
  async function verifyBuyer(run, fail, nothing) {
    run.currentStep = "verify_buyer";
    const vbCmd = deps.verifyBuyerCmd ?? "node.exe export-signatory-evidence.js --strict --out <runner work file>";
    step(run, "verify_buyer", "running", ACTORS.seller, ACTORS.agent, `Verifying ${agentAlias}: live KEL delegation from its OOR officer, OOR issuer, Legal Entity`, { api: { service: "vlei", cmd: vbCmd } });
    const vb = await deps.runVerifyBuyer(run.id);
    const vbApi = { service: "vlei", cmd: vb.cmd ?? vbCmd, exitCode: vb.exitCode, ms: vb.ms, ...(vb.timedOut ? { timedOut: true } : {}) };
    const vbRaw = proofTail(`${vb.stdout ?? ""}\n${vb.stderr ?? ""}`);
    const buyer = vb.evidence ? agentChain(vb.evidence, agentAlias) : null;
    if (vb.exitCode !== 0 || !buyer?.ok) {
      const why = vb.timedOut ? "exporter timed out" : vb.spawnError ? vb.spawnError : buyer && !buyer.ok ? buyer.reason : !vb.evidence ? `exporter exit code ${vb.exitCode}, no output` : `exporter strict checks failed (exit ${vb.exitCode})`;
      fail("verify_buyer", ACTORS.seller, ACTORS.agent, `Seller refused: buyer not verified — ${why}. ${nothing}`,
        { api: vbApi, data: { ...(buyer?.data ?? {}), raw: vbRaw } }, "seller_refused", `seller refused: buyer not verified — ${why}`);
      return { ok: false };
    }
    const bd = buyer.data;
    step(run, "verify_buyer", "done", ACTORS.seller, ACTORS.agent,
      `${agentAlias} verified: delegated (live KEL) from ${bd.officer}, who holds OOR ${bd.officerOorSaid} issued by the QVI; Legal Entity ${bd.legalEntity} (LEI ${bd.lei}). LE → QVI is not checked by the exporter.`,
      { api: vbApi, data: { ...bd, raw: vbRaw } });
    return { ok: true, bd, evidence: vb.evidence };
  }

  /** Phase B steps from verify_buyer to the end (shared by modes "issue" and "order"). */
  async function executeTail(run, units, parsed = {}, opts = {}) {
    const amountText = `${fmt(units)} USDC`;
    const fail = (name, actor, target, text, extra, result = "error", finishText = text) => {
      step(run, name, "failed", actor, target, text, extra);
      finish(run, result, finishText, { failedStep: name });
    };
    let planned;

    // 2. verify_buyer (seller checks the buyer BEFORE issuing) — skipped when mode "order" already did it before
    //    the negotiation (change #4c: opts.buyer = that step's verified buyer data)
    let bd = opts.buyer ?? null;
    if (!bd) {
      const v = await verifyBuyer(run, fail, "No invoice issued.");
      if (!v.ok) return;
      bd = v.bd;
    }

    // 3. issue (existing vLEI script)
    run.currentStep = "issue";
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

    // 4. offer (IPEX grant from the archived grant file; the admit happened inside the issue script)
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

    // 5. verify_seller (buyer checks the seller and the new invoice) — real strict export to the UI evidence
    run.currentStep = "verify_seller";
    const exportCmd = deps.exportCmd ?? "node.exe export-signatory-evidence.js --strict --out ../UI/data/signatory-evidence.json";
    step(run, "verify_seller", "running", ACTORS.agent, ACTORS.seller, "Exporting the vLEI evidence (strict) and verifying the seller agent and the invoice issuance", { api: { service: "vlei", cmd: exportCmd } });
    const ex = await deps.runExport();
    const exApi = { service: "vlei", cmd: exportCmd, exitCode: ex.exitCode, ms: ex.ms, ...(ex.timedOut ? { timedOut: true } : {}) };
    const exRaw = proofTail(`${ex.stdout}\n${ex.stderr}`);
    let evidence;
    try {
      evidence = deps.loadEvidence();
    } catch {
      evidence = null;
    }
    const inv = evidence && evidenceInvoices(evidence).find((i) => i.said === issued.said);
    const exportInfo = { exitCode: ex.exitCode, ms: ex.ms, allChecksPassed: /All checks passed\./.test(ex.stdout), generatedAt: evidence?.generatedAt ?? null, invoices: evidence ? evidenceInvoices(evidence).length : null };
    if (ex.exitCode !== 0 || !exportInfo.allChecksPassed || !inv) {
      const why = ex.timedOut ? "export timed out" : ex.spawnError ? ex.spawnError : ex.exitCode !== 0 ? `export exit code ${ex.exitCode}` : !inv ? "new invoice not in the export" : '"All checks passed." not printed';
      return fail("verify_seller", ACTORS.agent, ACTORS.seller, `Seller not verified: strict export failed (${why})`, { api: exApi, data: { export: exportInfo, raw: exRaw } });
    }
    const seller = agentChain(evidence, sellerAgent);
    const from = inv.issuerDelegatedFrom || {};
    const sd = seller.data;
    const issuerOk = inv.issuerAid === sd.agentAid && from.officerAid === sd.officerAid && from.officerOorSaid === sd.officerOorSaid;
    const sellerData = { ...sd, issuerMatches: issuerOk, issuanceVerified: inv.issuanceVerified === true, issuanceAnchor: inv.issuance?.anchor ?? null, export: exportInfo, raw: exRaw };
    if (!seller.ok || !issuerOk || inv.issuanceVerified !== true) {
      const why = !seller.ok ? seller.reason : !issuerOk ? "invoice issuer is not the delegated seller agent" : "invoice issuance not anchored in the seller KEL";
      return fail("verify_seller", ACTORS.agent, ACTORS.seller, `Seller not verified: ${why}`, { api: exApi, data: sellerData });
    }
    step(run, "verify_seller", "done", ACTORS.agent, ACTORS.seller,
      `${sellerAgent} verified: delegated (live KEL) from ${sd.officer}, who holds OOR ${sd.officerOorSaid}; it issued ${issued.invoiceNumber} and the issuance is anchored in its KEL (strict export: ${exportInfo.invoices} invoices, all checks passed)`,
      { api: exApi, data: sellerData });

    // 6. accept
    run.currentStep = "accept";
    const evApi = { service: "evidence", method: "read", path: cfg.paths?.evidence ?? "evidence" };
    const ipex = inv.ipex || {};
    const accData = { admitSuccess: ipex.admitSuccess === true, credentialHeld: ipex.credentialHeld === true, admitGrantSaid: ipex.admitGrantSaid, grantSaid: ipex.grantSaid, holderMatches: inv.holderAid === bd.agentAid };
    if (!(accData.admitSuccess && accData.credentialHeld && accData.holderMatches)) {
      return fail("accept", ACTORS.agent, ACTORS.seller, `IPEX admit ${ipex.admitSuccess} / credential held ${ipex.credentialHeld} / holder is ${agentAlias}: ${accData.holderMatches}`, { api: evApi, data: accData });
    }
    // change #3: AP2 — Jupiter signs the checkout (bridge), the buyer agent verifies it and signs the payment mandate (signer)
    if (deps.ap2Checkout && deps.ap2Mandate) {
      const { body: co, http: coHttp } = unwrap(await deps.ap2Checkout(issued.said));
      const coApi = httpApi("bridge", "POST", "/checkout", coHttp);
      if (!co.ok) {
        return fail("accept", ACTORS.seller, ACTORS.agent, `AP2 checkout not signed: ${co.reason || co.error}`, { api: coApi, data: { raw: proofJson(co) } });
      }
      const { body: md, http: mdHttp } = unwrap(await deps.ap2Mandate({ said: issued.said, checkout: co.checkout, merchantAuthorization: co.merchant_authorization }));
      const mdApi = httpApi("signer", "POST", "/mandate", mdHttp);
      if (!md.ok) {
        return fail("accept", ACTORS.agent, ACTORS.seller, `AP2 payment mandate refused (${md.code || "error"}): ${md.error}`, { api: mdApi, data: { raw: proofJson(md) } });
      }
      accData.ap2 = { checkoutHash: co.checkoutHash, merchantKid: co.kid, buyerKid: md.kid, mandateHash: md.mandateHash, receiptHash: md.receiptHash, expiresAt: co.checkout?.expires_at ?? null };
      step(run, "accept", "done", ACTORS.agent, ACTORS.seller,
        `Admitted IPEX grant ${ipex.grantSaid} and holds credential ${issued.said} · AP2 quote signed by Jupiter ✓ (kid ${co.kid.slice(0, 8)}…) · payment mandate signed by ${agentAlias} ✓ (kid ${md.kid.slice(0, 8)}…)`,
        { api: mdApi, data: accData });
    } else {
      step(run, "accept", "done", ACTORS.agent, ACTORS.seller, `Admitted IPEX grant ${ipex.grantSaid} and holds credential ${issued.said}`, { api: evApi, data: accData });
    }

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
    if (run.waiter.kind === "deal") {
      // change #4: officer decision on a failed negotiation (off-chain; the on-chain decision below is unchanged)
      run.waiter.resolve({ kind: "decided", decision });
      return { ok: true, decision };
    }
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

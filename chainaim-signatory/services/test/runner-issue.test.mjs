// Phase B (S-7B): vLEI adapter (pure parts + temp folders), preflight rules, engine steps 0–10 with fakes,
// stop-on-failure, amount rules, proof blocks, HTTP endpoints. No keys, no KERIA, no NEAR writes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig, ROOT } from "../../scripts/lib/common.mjs";
import { createRunner, STEPS_B } from "../runner/engine.mjs";
import { startRunnerServer } from "../runner/index.mjs";
import {
  lineItemDescription, nextInvoiceNumber, parseIssueOutput, preflight, proofJson, proofTail, readGrantInfo, redact, stripAnsi,
  unitsToJsonNumber, writeInvoiceConfig,
} from "../runner/vlei.mjs";
import { parseRequest } from "../runner/logic.mjs";
import { formatUnits } from "../../scripts/lib/common.mjs";
const formatUnitsT = (u) => formatUnits(u, 6);

const cfg = loadConfig();
const VLEI = resolve(ROOT, "..", "legentvLEI");
const INV3 = "EBQy-FlPtaa6_kh-BZI5Cn-ndtJ2It5Q3JNDMH3oYY1z"; // 0.084  ($84,000)
const INV4 = "EHusycc5UI7q2qRnfHhY-5fc0M9xkxB0nixx9Vs7m1qr"; // 0.1575 ($157,500)
const full = JSON.parse(readFileSync(cfg.paths.evidence, "utf8"));
const only = (saids) => {
  const ev = JSON.parse(JSON.stringify(full));
  ev.invoices = ev.invoices.filter((i) => saids.includes(i.said));
  ev.invoice = ev.invoices[0];
  return ev;
};
const KEY_WORDS = /bran|passcode|secret|salt|privkey|private[_ -]?key|seed phrase|mnemonic/i;

// ------------------------------------------------------------------ adapter

test("redact / proofTail drop key-like lines and ANSI codes", () => {
  const out = "\x1b[0;32m✓ ok\x1b[0m\nBRAN=abc123\nusing passcode from file\nline 4\n";
  assert.equal(stripAnsi("\x1b[0;31mred\x1b[0m"), "red");
  const r = redact(out);
  assert.equal(r.dropped, 2);
  assert.doesNotMatch(r.text, /abc123|passcode/);
  const t = proofTail(out, 10);
  assert.match(t, /✓ ok\nline 4/);
  assert.match(t, /\[2 key-like line\(s\) removed\]/);
  assert.doesNotMatch(proofJson({ a: 1, bran: "x", nested: { private_key: "y" } }), /"x"|"y"/);
});

test("parseIssueOutput reads the script's success line (with colours)", () => {
  const line = "\x1b[0;32m✓ INV-2026-0009 (EJkdJ9yH8nb7CPcufqIqtxQu6c4-7fQtax5nGZfqY_NK) issued, granted, admitted and held by tommyBuyerAgent\x1b[0m\n";
  assert.deepEqual(parseIssueOutput(`→ [1/4] Issuing\n${line}  Next: node export…`), { invoiceNumber: "INV-2026-0009", said: "EJkdJ9yH8nb7CPcufqIqtxQu6c4-7fQtax5nGZfqY_NK" });
  assert.equal(parseIssueOutput("✗ INV-2026-0009 issued and granted, but admit/hold is not confirmed"), null);
});

test("unitsToJsonNumber: exact JSON numbers only", () => {
  assert.equal(unitsToJsonNumber(120000n, 6), 0.12);
  assert.equal(unitsToJsonNumber(84000n, 6), 0.084);
  assert.equal(unitsToJsonNumber(157500n, 6), 0.1575);
  assert.equal(unitsToJsonNumber(100n, 6), 0.0001);
  assert.equal(JSON.stringify({ x: unitsToJsonNumber(100n, 6) }), '{"x":0.0001}');
});

test("next invoice number on the REAL legentvLEI folder is INV-2026-0009 (read-only)", { skip: !existsSync(VLEI) }, () => {
  const n = nextInvoiceNumber({ vleiDir: VLEI, evidence: full, sellerAgent: "jupiterSellerAgent" });
  assert.equal(n.invoiceNumber, "INV-2026-0009");
  assert.equal(n.highest.generatedRuns, "INV-2026-0008");
});

function tempVlei() {
  const dir = mkdtempSync(join(tmpdir(), "vlei-"));
  mkdirSync(join(dir, "appconfig", "generated-runs"), { recursive: true });
  mkdirSync(join(dir, "task-data"));
  copyFileSync(join(VLEI, "appconfig", "invoiceConfig-near-2.json"), join(dir, "appconfig", "invoiceConfig-near-2.json"));
  return dir;
}

test("nextInvoiceNumber: max over evidence, appconfig, generated-runs, task-data", { skip: !existsSync(VLEI) }, () => {
  const dir = tempVlei();
  writeFileSync(join(dir, "task-data", "jupiterSellerAgent-self-invoice-credential-info.EX.json"), JSON.stringify({ invoiceNumber: "INV-2026-0011" }));
  writeFileSync(join(dir, "task-data", "otherAgent-self-invoice-credential-info.json"), JSON.stringify({ invoiceNumber: "INV-2026-0099" }));
  writeFileSync(join(dir, "appconfig", "generated-runs", "x.json"), JSON.stringify({ invoice: { sampleInvoice: { invoiceNumber: "INV-2026-0010" } } }));
  writeFileSync(join(dir, "appconfig", "broken.json"), "{not json");
  const n = nextInvoiceNumber({ vleiDir: dir, evidence: only([INV3]), sellerAgent: "jupiterSellerAgent" });
  assert.equal(n.invoiceNumber, "INV-2026-0012");
  assert.deepEqual(n.highest, { evidence: "INV-2026-0003", appconfig: "INV-2026-0004", generatedRuns: "INV-2026-0010", taskData: "INV-2026-0011" });
});

test("writeInvoiceConfig: template + only number/amount/dates/item/ref; never overwrites", { skip: !existsSync(VLEI) }, () => {
  const dir = tempVlei();
  const w = writeInvoiceConfig({ vleiDir: dir, template: "appconfig/invoiceConfig-near-2.json", invoiceNumber: "INV-2026-0009", units: 84000n, decimals: 6, demoScale: 1000000, item: "cotton t-shirts", quantity: 8000, now: new Date("2026-11-13T15:00:00Z") });
  assert.equal(w.description, "Cotton t-shirts, 8,000 pcs (demo scale 1:1,000,000; real 84,000.00 USD)");
  assert.equal(w.relPath, "./appconfig/generated-runs/invoiceConfig-run-INV-2026-0009.json");
  const tpl = JSON.parse(readFileSync(join(dir, "appconfig", "invoiceConfig-near-2.json"), "utf8")).invoice;
  const c = JSON.parse(readFileSync(w.path, "utf8")).invoice;
  const s = c.sampleInvoice;
  assert.equal(s.invoiceNumber, "INV-2026-0009");
  assert.equal(s.totalAmount, 0.084);
  assert.deepEqual(s.lineItems, [{ description: "Cotton t-shirts, 8,000 pcs (demo scale 1:1,000,000; real 84,000.00 USD)", quantity: 1, unitPrice: 0.084, amount: 0.084 }]);
  assert.equal(s.invoiceDate, "2026-11-13T00:00:00Z");
  assert.equal(s.dueDate, "2026-12-13T00:00:00Z");
  assert.equal(s.ref_uri, "urn:chainaim:order:INV-2026-0009");
  for (const k of ["sellerLEI", "buyerLEI", "currency", "paymentMethod", "paymentChainID", "paymentWalletAddress", "paymentTerms"]) assert.deepEqual(s[k], tpl.sampleInvoice[k], k);
  for (const k of ["schemaName", "schemaPath", "registryName", "oorSchemaSaid", "issuer", "holder"]) assert.deepEqual(c[k], tpl[k], k);
  assert.match(readFileSync(w.path, "utf8"), /"totalAmount": 0\.084,/);
  assert.throws(() => writeInvoiceConfig({ vleiDir: dir, template: "appconfig/invoiceConfig-near-2.json", invoiceNumber: "INV-2026-0009", units: 84000n, decimals: 6, demoScale: 1000000 }), /EEXIST/);
  assert.throws(() => writeInvoiceConfig({ vleiDir: dir, template: "appconfig/invoiceConfig-near-2.json", invoiceNumber: "INV-2026-0010", units: 10n, decimals: 6, demoScale: 1000000 }), /< 0\.0001/);
});

test("lineItemDescription: item + quantity + real total; 'Order' without an item", () => {
  const P = { decimals: 6, demoScale: 1000000 };
  assert.equal(lineItemDescription({ item: "hoodies", quantity: 15000, units: 157500n, ...P }), "Hoodies, 15,000 pcs (demo scale 1:1,000,000; real 157,500.00 USD)");
  assert.equal(lineItemDescription({ item: "denim jeans", units: 50000n, ...P }), "Denim jeans (demo scale 1:1,000,000; real 50,000.00 USD)");
  assert.equal(lineItemDescription({ units: 84000n, ...P }), "Order (demo scale 1:1,000,000; real 84,000.00 USD)");
  assert.equal(lineItemDescription({ item: 'x"; rm -rf /', quantity: 1, units: 100n, ...P }), "X rm -rf, 1 pcs (demo scale 1:1,000,000; real 100.00 USD)");
});

// §S-7B "Built-in scenarios" table — one test per row. `onChain` = the table's On-chain column (USDC);
// `stop` = honest pre-issue stop (nothing is called: no config written, no vLEI script, no NEAR call).
const SCENARIOS = [
  { n: 1, label: "Within limit", text: "Need 8,000 cotton t-shirts, total $84,000", onChain: "0.084", item: "cotton t-shirts", qty: 8000, desc: "Cotton t-shirts, 8,000 pcs (demo scale 1:1,000,000; real 84,000.00 USD)" },
  { n: 2, label: "Small order", text: "Order 2,500 denim jeans, total $50,000", onChain: "0.05", item: "denim jeans", qty: 2500, desc: "Denim jeans, 2,500 pcs (demo scale 1:1,000,000; real 50,000.00 USD)" },
  { n: 3, label: "Exactly at limit", text: "Need 10,000 polo shirts, total $100,000", onChain: "0.1", item: "polo shirts", qty: 10000, desc: "Polo shirts, 10,000 pcs (demo scale 1:1,000,000; real 100,000.00 USD)" },
  { n: 4, label: "Escalate → approve", text: "Need 15,000 hoodies, total $157,500", onChain: "0.1575", item: "hoodies", qty: 15000, desc: "Hoodies, 15,000 pcs (demo scale 1:1,000,000; real 157,500.00 USD)" },
  { n: 5, label: "Escalate → reject", text: "Order 12,000 jackets, total $120,000", onChain: "0.12", item: "jackets", qty: 12000, desc: "Jackets, 12,000 pcs (demo scale 1:1,000,000; real 120,000.00 USD)" },
  { n: 6, label: "Near CPO maximum", text: "Need 20,000 knit sweaters, total $240,000", onChain: "0.24", item: "knit sweaters", qty: 20000, desc: "Knit sweaters, 20,000 pcs (demo scale 1:1,000,000; real 240,000.00 USD)" },
  { n: 7, label: "Above CPO authority", text: "Order 30,000 winter coats, total $300,000", onChain: "0.3", item: "winter coats", qty: 30000, stop: "bad_amount", why: /above the maximum 0.25/ },
  { n: 8, label: "Agent turned off", text: "(click Turn off agent first) Need 5,000 t-shirts, total $42,000", onChain: "0.042", item: "t-shirts", qty: 5000, desc: "T-shirts, 5,000 pcs (demo scale 1:1,000,000; real 42,000.00 USD)" },
  { n: 9, label: "Too small", text: "Sample order of 1 t-shirt, total $50", onChain: "0.00005", item: "t-shirt", qty: 1, stop: "bad_amount", why: /below the minimum 0.0001/ },
  { n: 10, label: "No amount", text: "Need cotton t-shirts for next month", onChain: null, item: undefined, qty: undefined, stop: "no_amount", why: /No amount given/ },
];

for (const s of SCENARIOS) {
  test(`scenario #${s.n} ${s.label}: "${s.text}" → ${s.stop ?? s.onChain + " USDC"}`, async () => {
    const P = { decimals: 6, demoScale: 1000000 };
    const parsed = parseRequest(s.text, P);
    assert.equal(parsed.amount, s.onChain ?? undefined, "on-chain amount");
    assert.equal(parsed.item, s.item, "item");
    assert.equal(parsed.quantity, s.qty, "quantity");
    const { deps, calls } = fakeB();
    const runner = createRunner({ cfg, deps, pollMs: 1 });
    if (s.stop) {
      const run = await runner.start({ text: s.text, mode: "issue" });
      assert.equal(run.result, s.stop);
      assert.match(run.events.at(-1).data.text, s.why);
      assert.equal(run.events.filter((e) => e.type === "step").length, 0, "no step ran");
      assert.deepEqual(calls, [], "no invoice config, no vLEI script, no NEAR call");
      assert.equal(runner.active, null);
    } else {
      const a = runner.issueAmount(parsed);
      assert.equal(formatUnitsT(a.units), s.onChain);
      assert.equal(lineItemDescription({ item: parsed.item, quantity: parsed.quantity, units: a.units, ...P }), s.desc);
      // the config writer receives item + quantity; numbers stay quantity 1, unitPrice = amount
      if (existsSync(VLEI)) {
        const dir = tempVlei();
        const w = writeInvoiceConfig({ vleiDir: dir, template: "appconfig/invoiceConfig-near-2.json", invoiceNumber: "INV-2026-0100", units: a.units, item: parsed.item, quantity: parsed.quantity, ...P });
        const li = JSON.parse(readFileSync(w.path, "utf8")).invoice.sampleInvoice;
        assert.deepEqual(li.lineItems, [{ description: s.desc, quantity: 1, unitPrice: Number(s.onChain), amount: Number(s.onChain) }]);
        assert.equal(li.totalAmount, Number(s.onChain));
      }
    }
  });
}

test("readGrantInfo: archived copy by SAID, public fields only", { skip: !existsSync(VLEI) }, () => {
  const dir = tempVlei();
  const said = "E" + "x".repeat(43);
  writeFileSync(join(dir, "task-data", `jupiterSellerAgent-ipex-grant-info.${said}.json`),
    JSON.stringify({ credentialSAID: said, invoiceNumber: "INV-2026-0009", sender: "jupiterSellerAgent", receiver: "tommyBuyerAgent", timestamp: "t", grantResult: { said: "EGRANT", operation: "op" }, credential: { big: 1 } }));
  const g = readGrantInfo({ vleiDir: dir, sellerAgent: "jupiterSellerAgent", said });
  assert.equal(g.grantSaid, "EGRANT");
  assert.equal(g.credential, undefined);
  assert.equal(readGrantInfo({ vleiDir: dir, sellerAgent: "jupiterSellerAgent", said: "Eother" }), null);
});

// ------------------------------------------------------------------ preflight

function pfDeps(over = {}) {
  return {
    probe: async (url) => over.probe?.(url) ?? { up: true, keysLoaded: true, httpStatus: 200 },
    rpcStatus: async () => over.chain ?? "testnet",
    run: async (cmd, args) => over.run?.(cmd, args) ?? { exitCode: 0, stdout: cmd === "docker" && args[0] === "inspect" ? "running healthy\n" : "jq-1.7\n", stderr: "", ms: 3 },
    getMandate: async () => over.mandate ?? { limit_units: "100000", revoked: false, approver: "chainaim-tommy-cpo.testnet" },
    loadEvidence: () => full,
  };
}
const pf = (over) => preflight({ cfg, vleiDir: VLEI, exportNode: join(VLEI, "export-signatory-evidence.js"), signerUrl: "http://s", bridgeUrl: "http://b", agentAccount: "chainaim-tommy-buyer-agent.testnet", deps: pfDeps(over) });

test("preflight: all ok; each check has an api block", { skip: !existsSync(VLEI) }, async () => {
  const r = await pf();
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => !c.ok)));
  assert.deepEqual(r.checks.map((c) => c.name), ["signer", "bridge", "near_rpc", "docker_tsx_shell", "keria", "jq", "vlei_issue_script", "vlei_exporter", "export_node", "evidence", "agent_mandate"]);
  for (const c of r.checks) assert.ok(c.api && c.api.service, c.name);
});

test("preflight: B5 bridge down / no keys / keria stopped / docker missing fail; revoked mandate is only a note", { skip: !existsSync(VLEI) }, async () => {
  let r = await pf({ probe: (u) => (u === "http://b" ? { up: false } : { up: true, keysLoaded: true }) });
  assert.equal(r.ok, false);
  assert.equal(r.checks.find((c) => c.name === "bridge").detail, "not reachable");
  r = await pf({ probe: () => ({ up: true, keysLoaded: false }) });
  assert.match(r.checks.find((c) => c.name === "signer").detail, /--no-send/);
  r = await pf({ run: (cmd, args) => (args[0] === "inspect" ? { exitCode: 0, stdout: "exited \n", ms: 1 } : { exitCode: 0, stdout: "", ms: 1 }) });
  assert.equal(r.checks.find((c) => c.name === "keria").ok, false);
  r = await pf({ run: () => ({ exitCode: null, stdout: "", stderr: "", spawnError: "spawn docker ENOENT", ms: 1 }) });
  assert.equal(r.checks.find((c) => c.name === "docker_tsx_shell").ok, false);
  r = await pf({ mandate: { limit_units: "100000", revoked: true, approver: "x" } });
  assert.equal(r.ok, true);
  assert.match(r.checks.find((c) => c.name === "agent_mandate").detail, /REVOKED/);
});

// ------------------------------------------------------------------ engine Phase B

const GOOD_ISSUE = (inv, said) => ({ exitCode: 0, stdout: `→ [1/4] Issuing\n  new invoice: ${said}\n\x1b[0;32m✓ ${inv} (${said}) issued, granted, admitted and held by tommyBuyerAgent\x1b[0m\n`, stderr: "", ms: 90000 });

/** target: the evidence invoice that plays the newly issued one. */
function fakeB({ target = INV3, invNo = target === INV3 ? "INV-2026-0003" : "INV-2026-0004", revoked = false, over = {} } = {}) {
  const chain = {};
  const calls = [];
  let exported = false;
  const deps = {
    loadEvidence: () => (exported ? only([INV3, INV4]) : only([INV3, INV4].filter((s) => s !== target))),
    getInvoice: async (s) => chain[s] ?? null,
    getMandate: async () => ({ limit_units: "100000", revoked, approver: "chainaim-tommy-cpo.testnet" }),
    preflight: async () => {
      calls.push(["preflight"]);
      return over.preflight ?? { ok: true, checks: [{ name: "bridge", ok: true, detail: "up", api: { service: "bridge" } }], mandate: { limit_units: "100000", revoked, approver: "chainaim-tommy-cpo.testnet" } };
    },
    nextInvoiceNumber: () => ({ invoiceNumber: invNo, highest: { evidence: "INV-2026-0008" } }),
    writeInvoiceConfig: (n, units, meta = {}) => {
      calls.push(["config", n, units.toString(), meta.item ?? null, meta.quantity ?? null]);
      return { path: `/x/invoiceConfig-run-${n}.json`, relPath: `./appconfig/generated-runs/invoiceConfig-run-${n}.json`, description: "desc" };
    },
    runIssue: async (rel) => {
      calls.push(["issue", rel]);
      return over.issue ?? GOOD_ISSUE(invNo, target);
    },
    readGrantInfo: (said) => (said === target ? { grantSaid: "EGRANT-" + said.slice(0, 6), path: "/td/grant.json", timestamp: "t" } : null),
    exportCmd: '"/mnt/c/Program Files/nodejs/node.exe" export-signatory-evidence.js --strict --out ../UI/data/signatory-evidence.json',
    runExport: async () => {
      calls.push(["export"]);
      if (over.export) return over.export;
      exported = true;
      return { exitCode: 0, stdout: "agent jupiterSellerAgent … KEL-verified: true\nAll checks passed.\nWritten: ../UI/data/signatory-evidence.json\n", stderr: "", ms: 20000 };
    },
    bridgeRegister: async (said) => {
      calls.push(["register", said]);
      chain[said] = { status: "registered" };
      return { ok: true, sent: true, txHash: "TXREG", txUrl: "u/TXREG", checks: [{ rule: "said", ok: true }], _http: { status: 200, ms: 4000, url: "http://127.0.0.1:8772" } };
    },
    signerPay: async (said) => {
      calls.push(["pay", said]);
      if (revoked) return { ok: true, txHash: "TXPAY", txUrl: "u/TXPAY", outcome: { event: "payment_refused", reason: "mandate revoked" }, usedUnits: "0", refundedUnits: "84000", _http: { status: 200, ms: 5000, url: "http://127.0.0.1:8771" } };
      if (said === INV3) {
        chain[said] = { status: "paid" };
        return { ok: true, txHash: "TXPAY", txUrl: "u/TXPAY", outcome: { event: "paid", via: "within_limit", amount_units: "84000" }, _http: { status: 200, ms: 5000, url: "http://127.0.0.1:8771" } };
      }
      chain[said] = { status: "pending" };
      return { ok: true, txHash: "TXPAY", txUrl: "u/TXPAY", outcome: { event: "payment_pending", limit_units: "100000", approver: "chainaim-tommy-cpo.testnet", amount_units: "157500" }, _http: { status: 200, ms: 5000, url: "http://127.0.0.1:8771" } };
    },
    signerDecide: async (kind, said) => {
      calls.push([kind, said]);
      chain[said] = { status: kind === "approve" ? "paid" : "rejected" };
      return { ok: true, txHash: "TXDEC", txUrl: "u/TXDEC", _http: { status: 200, ms: 4000, url: "http://127.0.0.1:8771" } };
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
  };
  return { deps, calls, chain };
}

async function until(run, pred, ms = 3000) {
  const t0 = Date.now();
  while (!pred(run)) {
    if (Date.now() - t0 > ms) throw new Error(`timeout; events: ${run.events.map((e) => e.data.step ? `${e.data.step}:${e.data.status}` : e.data.state).join(",")}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const finished = (r) => r.state === "finished";
const waiting = (r) => r.state === "waiting" && r.waiter;
const finals = (run) => run.events.filter((e) => e.type === "step" && e.data.status !== "running").map((e) => `${e.data.index}:${e.data.step}:${e.data.status}`);
const allText = (run) => JSON.stringify(run.events);

test("B1: $84,000 → issue → verify both → register → pay → paid; steps 0–10 indexes, api on every step", async () => {
  const { deps, calls } = fakeB();
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ text: "Need 8,000 t-shirts, about $84,000", mode: "issue" });
  await until(run, finished);
  assert.equal(run.result, "paid", allText(run).slice(0, 2000));
  assert.deepEqual(finals(run), ["0:preflight:done", "1:issue:done", "2:offer:done", "3:export:done", "4:verify_seller:done", "5:verify_buyer:done", "6:accept:done", "7:register:done", "8:pay:done", "9:outcome:done"]);
  const started = run.events[0].data;
  assert.equal(started.mode, "issue");
  assert.deepEqual(started.steps, STEPS_B);
  assert.equal(started.planned.invoiceNumber, "INV-2026-0003");
  assert.equal(started.planned.amount, "0.084");
  assert.equal(started.planned.description, "T-shirts, 8,000 pcs (demo scale 1:1,000,000; real 84,000.00 USD)");
  for (const e of run.events.filter((x) => x.type === "step")) assert.ok(e.data.api?.service, `${e.data.step}:${e.data.status} has api`);
  const issue = run.events.find((e) => e.data.step === "issue" && e.data.status === "done").data;
  assert.equal(issue.api.exitCode, 0);
  assert.match(issue.api.cmd, /^bash issue-additional-invoice\.sh --invoice-config \.\/appconfig\/generated-runs\/invoiceConfig-run-INV-2026-0003\.json$/);
  assert.match(issue.data.raw, /issued, granted, admitted and held/);
  assert.doesNotMatch(issue.data.raw, /\x1b\[/);
  const vs = run.events.find((e) => e.data.step === "verify_seller").data;
  assert.equal(vs.data.officer, "Jupiter_Chief_Sales_Officer");
  assert.equal(vs.data.issuanceVerified, true);
  assert.equal(run.events.find((e) => e.data.step === "verify_buyer").data.data.officer, "Tommy_Chief_Procurement_Officer");
  const reg = run.events.find((e) => e.data.step === "register" && e.data.status === "done").data;
  assert.deepEqual(reg.api, { service: "bridge", method: "POST", path: "http://127.0.0.1:8772/register", httpStatus: 200, ms: 4000 });
  assert.equal(run.said, INV3);
  assert.deepEqual(calls.map((c) => c[0]), ["preflight", "config", "issue", "export", "register", "pay"]);
  assert.deepEqual(calls[1], ["config", "INV-2026-0003", "84000", "t-shirts", 8000]);
  assert.doesNotMatch(allText(run), KEY_WORDS);
  assert.equal(runner.active, null);
});

test("B2/B3: $157,500 → pending (waiting) → approve → paid; reject → rejected", async () => {
  for (const decision of ["approve", "reject"]) {
    const { deps } = fakeB({ target: INV4 });
    const runner = createRunner({ cfg, deps, pollMs: 1 });
    const run = await runner.start({ text: "order worth $157,500", mode: "issue" });
    await until(run, waiting);
    assert.equal(run.events.find((e) => e.data.step === "outcome").data.index, 9);
    await runner.decide(run.id, decision);
    await until(run, finished);
    assert.equal(run.result, decision === "approve" ? "paid" : "rejected");
    const dec = run.events.find((e) => e.data.step === "decision").data;
    assert.equal(dec.index, 10);
    assert.equal(dec.api.path, `http://127.0.0.1:8771/${decision}`);
    assert.equal(dec.txUrl, "u/TXDEC");
  }
});

test("B4: revoked agent → invoice still issued and verified, payment refused + refund", async () => {
  const { deps, calls } = fakeB({ revoked: true });
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ text: "$84,000", mode: "issue" });
  await until(run, finished);
  assert.equal(run.result, "refused");
  assert.match(run.events.find((e) => e.data.step === "preflight" && e.data.status === "done").data.text, /revoked/);
  assert.ok(calls.some((c) => c[0] === "issue") && calls.some((c) => c[0] === "pay"));
  assert.match(run.events.find((e) => e.data.step === "outcome").data.text, /mandate revoked — 0.084 USDC returned/);
});

test("B5: preflight fails → nothing issued, run error at preflight", async () => {
  const { deps, calls } = fakeB({ over: { preflight: { ok: false, checks: [{ name: "bridge", ok: false, detail: "not reachable", api: { service: "bridge" } }], mandate: null } } });
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const run = await runner.start({ text: "$84,000", mode: "issue" });
  await until(run, finished);
  assert.equal(run.result, "error");
  assert.equal(run.events.at(-1).data.failedStep, "preflight");
  assert.match(run.events.at(-1).data.text, /bridge \(not reachable\).*nothing issued/);
  assert.deepEqual(calls.map((c) => c[0]), ["preflight"]);
});

test("B6: amounts refused before anything runs (min, max, none, inexact)", async () => {
  const cases = [
    ["pay 0.00001 USDC", "bad_amount", /below the minimum 0.0001/],
    ["$10", "bad_amount", /below the minimum/],
    ["$300,000", "bad_amount", /above the maximum 0.25/],
    ["0.1234567 USDC", "bad_amount", /more than 6 decimals/],
    ["Need 8,000 t-shirts", "no_amount", /No amount given/],
  ];
  for (const [text, result, re] of cases) {
    const { deps, calls } = fakeB();
    const runner = createRunner({ cfg, deps, pollMs: 1 });
    const run = await runner.start({ text, mode: "issue" });
    assert.equal(run.result, result, text);
    assert.match(run.events.at(-1).data.text, re, text);
    assert.equal(calls.length, 0, `${text}: nothing called`);
  }
});

test("stop-on-failure: issue exit 1 → no export; export fail → no register; seller not verified → no money", async () => {
  let f = fakeB({ over: { issue: { exitCode: 1, stdout: "", stderr: "ERROR: invoice INV-2026-0003 was already issued\nBRAN line must not leak\n", ms: 50 } } });
  let runner = createRunner({ cfg, deps: f.deps, pollMs: 1 });
  let run = await runner.start({ text: "$84,000", mode: "issue" });
  await until(run, finished);
  assert.equal(run.events.at(-1).data.failedStep, "issue");
  const iss = run.events.find((e) => e.data.step === "issue" && e.data.status === "failed").data;
  assert.equal(iss.api.exitCode, 1);
  assert.match(iss.data.raw, /already issued/);
  assert.doesNotMatch(iss.data.raw, /BRAN/);
  assert.deepEqual(f.calls.map((c) => c[0]), ["preflight", "config", "issue"]);

  f = fakeB({ over: { issue: { exitCode: null, timedOut: true, stdout: "→ [2/4] IPEX grant", stderr: "", ms: 360000 } } });
  runner = createRunner({ cfg, deps: f.deps, pollMs: 1 });
  run = await runner.start({ text: "$84,000", mode: "issue" });
  await until(run, finished);
  assert.match(run.events.at(-1).data.text, /timed out/);

  f = fakeB({ over: { export: { exitCode: 1, stdout: "1 check failure(s):\n  - …", stderr: "", ms: 120000 } } });
  runner = createRunner({ cfg, deps: f.deps, pollMs: 1 });
  run = await runner.start({ text: "$84,000", mode: "issue" });
  await until(run, finished);
  assert.equal(run.events.at(-1).data.failedStep, "export");
  assert.ok(!f.calls.some((c) => c[0] === "register"));

  f = fakeB();
  const base = f.deps.loadEvidence;
  f.deps.loadEvidence = () => {
    const ev = base();
    for (const i of ev.invoices) if (i.said === INV3) i.issuanceVerified = false;
    return ev;
  };
  runner = createRunner({ cfg, deps: f.deps, pollMs: 1 });
  run = await runner.start({ text: "$84,000", mode: "issue" });
  await until(run, finished);
  assert.equal(run.events.at(-1).data.failedStep, "verify_seller");
  assert.ok(!f.calls.some((c) => c[0] === "register" || c[0] === "pay"), "no money moves after a failed verification");
});

test("issue mode input rules; Phase A still works next to it", async () => {
  const { deps } = fakeB();
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  await assert.rejects(runner.start({ said: INV3, mode: "issue" }), (e) => e.status === 400);
  await assert.rejects(runner.start({ text: "$84,000", mode: "other" }), (e) => e.status === 400);
  const a = await runner.start({ said: INV4 }); // Phase A on a pre-issued invoice
  await until(a, waiting);
  assert.equal(a.mode, "invoice");
  assert.equal(a.events.find((e) => e.data.step === "outcome").data.index, 5);
  assert.ok(a.events.filter((e) => e.type === "step").every((e) => e.data.api), "Phase A steps carry api blocks too");
  await assert.rejects(runner.start({ text: "$84,000", mode: "issue" }), /already active/);
  runner.cancel(a.id);
  await until(a, finished);
});

// ------------------------------------------------------------------ HTTP

test("HTTP: /preflight, /next-invoice, POST /run mode issue; 501 when issue mode is not configured", async () => {
  const { deps } = fakeB();
  const runner = createRunner({ cfg, deps, pollMs: 1 });
  const srvDeps = { ...deps, nextInvoiceNumber: () => ({ invoiceNumber: "INV-2026-0009", highest: { generatedRuns: "INV-2026-0008" } }) };
  const server = startRunnerServer({ cfg, runner, deps: srvDeps, port: 0, allowOrigin: "http://127.0.0.1:8765", signerUrl: "http://127.0.0.1:1", bridgeUrl: "http://127.0.0.1:1" });
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const plain = startRunnerServer({ cfg, runner: createRunner({ cfg, deps, pollMs: 1 }), port: 0, allowOrigin: "x", signerUrl: "http://127.0.0.1:1", bridgeUrl: "http://127.0.0.1:1" });
  await new Promise((r) => plain.once("listening", r));
  try {
    const p = await (await fetch(`${base}/preflight`)).json();
    assert.equal(p.ok, true);
    const n = await (await fetch(`${base}/next-invoice?text=${encodeURIComponent("about $84,000")}`)).json();
    assert.equal(n.invoiceNumber, "INV-2026-0009");
    assert.equal(n.amount.amountUnits, "84000");
    assert.equal(n.readOnly, true);
    const bad = await (await fetch(`${base}/next-invoice?text=${encodeURIComponent("$10")}`)).json();
    assert.equal(bad.amount.ok, false);
    assert.equal(bad.amount.result, "bad_amount");
    const h = await (await fetch(`${base}/health`)).json();
    assert.deepEqual(h.modes, ["invoice", "issue"]);
    const r = await (await fetch(`${base}/run`, { method: "POST", body: JSON.stringify({ text: "$84,000", mode: "issue" }) })).json();
    assert.equal(r.mode, "issue");
    await until(runner.get(r.runId), finished);
    const pb = `http://127.0.0.1:${plain.address().port}`;
    assert.equal((await fetch(`${pb}/preflight`)).status, 501);
    assert.equal((await fetch(`${pb}/run`, { method: "POST", body: JSON.stringify({ text: "$84,000", mode: "issue" }) })).status, 501);
    assert.deepEqual((await (await fetch(`${pb}/health`)).json()).modes, ["invoice"]);
  } finally {
    server.close();
    plain.close();
    server.closeAllConnections?.();
    plain.closeAllConnections?.();
  }
});

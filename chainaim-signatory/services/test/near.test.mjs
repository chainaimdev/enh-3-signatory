// Outcome parsing on RPC-shaped fixtures (send_tx FINAL results), validators, and the HTTP origin policy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { failureText, isAccountId, isSaid, lastEvent, summarize } from "../shared/near.mjs";
import { startServer } from "../shared/http.mjs";

const C = "chainaim-signatory.testnet";
const T = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const ev = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: "signatory", version: "1.0.0", event, data: [data] })}`;
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64");
const outcome = (executor, logs, status = { SuccessValue: "" }) => ({ id: "r", outcome: { executor_id: executor, logs, status } });
const tx = (receipts, status) => ({
  status,
  transaction: { hash: "HASH1" },
  transaction_outcome: { id: "HASH1", outcome: { executor_id: "agent.testnet", logs: [], status: { SuccessReceiptId: "x" } } },
  receipts_outcome: receipts,
});

test("scene 1: paid event from the callback receipt, used = full amount", () => {
  const r = summarize(
    tx(
      [
        outcome(T, ['EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[]}']),
        outcome(C, []),
        outcome(T, []),
        outcome(C, [ev("paid", { said: "E1", amount_units: "84000", via: "within_limit" })]),
        outcome(T, []),
      ],
      { SuccessValue: b64("84000") },
    ),
  );
  assert.equal(r.ok, true);
  assert.equal(r.txHash, "HASH1");
  assert.equal(r.value, "84000");
  assert.equal(r.events.length, 1, "only signatory-standard events are kept");
  assert.deepEqual(lastEvent(r.events, ["paid", "payment_pending", "payment_refused"]), {
    event: "paid",
    said: "E1",
    amount_units: "84000",
    via: "within_limit",
  });
});

test("scene 4: payment_refused with reason, used 0 (full refund)", () => {
  const r = summarize(
    tx([outcome(C, [ev("payment_refused", { said: "E1", reason: "mandate revoked" })]), outcome(T, [])], { SuccessValue: b64("0") }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.value, "0");
  assert.equal(lastEvent(r.events, ["paid", "payment_pending", "payment_refused"]).reason, "mandate revoked");
});

test("contract panic is returned verbatim", () => {
  const failure = {
    ActionError: {
      index: 0,
      kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: only the payer's approver can approve or reject" } },
    },
  };
  const r = summarize(tx([outcome(C, [], { Failure: failure })], { Failure: failure }));
  assert.equal(r.ok, false);
  assert.equal(r.error, "Smart contract panicked: only the payer's approver can approve or reject");
  assert.equal(r.failures[0].executor, C);
});

test("approve whose transfer failed: value false + plain log", () => {
  const r = summarize(
    tx([outcome(C, []), outcome(T, [], { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "x" } } } } }),
      outcome(C, ["signatory: approve transfer failed for E1; status restored to pending, tokens kept"])], { SuccessValue: b64(false) }),
  );
  assert.equal(r.ok, true);
  assert.equal(r.value, false);
  assert.match(r.logs.find((l) => l.executor === C).log, /restored to pending/);
});

test("failureText for non-panic errors", () => {
  assert.match(failureText({ ActionError: { kind: { AccountDoesNotExist: { account_id: "x" } } } }), /AccountDoesNotExist/);
  assert.match(failureText({ InvalidTxError: { NotEnoughBalance: {} } }), /^InvalidTxError/);
});

test("validators", () => {
  assert.ok(isSaid("EBQy-FlPtaa6_kh-BZI5Cn-ndtJ2It5Q3JNDMH3oYY1z"));
  assert.ok(!isSaid("bad said"));
  assert.ok(!isSaid(""));
  assert.ok(isAccountId("chainaim-tommy-buyer-agent.testnet"));
  assert.ok(!isAccountId("Bad.testnet"));
  assert.ok(!isAccountId("a"));
});

test("P8: foreign Origin refused, allowed Origin gets CORS, no Origin allowed", async () => {
  const allow = "http://127.0.0.1:8765";
  const server = startServer({ service: "test", port: 0, allowOrigin: allow, routes: { "GET /health": async () => [200, { ok: true }] } });
  await new Promise((r) => server.once("listening", r));
  const url = `http://127.0.0.1:${server.address().port}/health`;
  try {
    const bad = await fetch(url, { headers: { origin: "http://evil.example" } });
    assert.equal(bad.status, 403);
    assert.equal((await bad.json()).ok, false);
    const good = await fetch(url, { headers: { origin: allow } });
    assert.equal(good.status, 200);
    assert.equal(good.headers.get("access-control-allow-origin"), allow);
    const none = await fetch(url);
    assert.equal(none.status, 200);
    assert.equal(none.headers.get("access-control-allow-origin"), null);
    const nul = await fetch(url, { headers: { origin: "null" } });
    assert.equal(nul.status, 403);
    const pre = await fetch(url, { method: "OPTIONS", headers: { origin: allow } });
    assert.equal(pre.status, 204);
    const missing = await fetch(url.replace("/health", "/nope"));
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
});

// Bridge rules against the real evidence export (no keys, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadConfig } from "../../scripts/lib/common.mjs";
import { FIXTURE_EVIDENCE } from "./fixture.mjs";
import { amountUnits, checkInvoice, computeSaid } from "../bridge/rules.mjs";

const cfg = loadConfig();
const evidence = JSON.parse(readFileSync(FIXTURE_EVIDENCE, "utf8"));
const INV3 = "EBQy-FlPtaa6_kh-BZI5Cn-ndtJ2It5Q3JNDMH3oYY1z";
const INV4 = "EHusycc5UI7q2qRnfHhY-5fc0M9xkxB0nixx9Vs7m1qr";
const opts = (said, extra = {}) => ({
  said,
  payee: cfg.accounts.payee,
  network: "testnet",
  sellerAgent: cfg.sellerAgent,
  decimals: cfg.tokenDecimals,
  ...extra,
});
const clone = () => JSON.parse(JSON.stringify(evidence));
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.rule);

test("SAIDs of both issued invoices recompute exactly", () => {
  for (const inv of evidence.invoices) assert.equal(computeSaid(JSON.parse(inv.acdcRaw)), inv.said);
});

test("INV-2026-0003 passes every rule and registers 84000 units", () => {
  const r = checkInvoice(evidence, opts(INV3));
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(failed(r), []);
  assert.deepEqual(r.checks.map((c) => c.rule), ["found", "said", "strict", "grant", "admit", "held", "issuer", "chain", "payee", "amount"]);
  // change #2: only (said, payee, amount) leave the rules, to build the commitment; LEIs and due date never do
  assert.deepEqual(r.reveal, { said: INV3, payee: "chainaim-jupiter-payee.testnet", amountUnits: "84000" });
  assert.equal(r.info.issuanceVerified, true);
});

test("INV-2026-0004 passes and registers 157500 units", () => {
  const r = checkInvoice(evidence, opts(INV4));
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.reveal.amountUnits, "157500");
});

test("scene 3: tampered payee → SAID mismatch, refused, labelled demo", () => {
  const r = checkInvoice(evidence, opts(INV3, { tamperField: "paymentWalletAddress" }));
  assert.equal(r.ok, false);
  assert.ok(failed(r).includes("said"));
  assert.match(r.reason, /^said: recomputed E/);
  assert.equal(r.demo.tamper, true);
  assert.equal(r.reveal, undefined);
});

test("tampered amount → SAID mismatch", () => {
  const r = checkInvoice(evidence, opts(INV4, { tamperField: "totalAmount" }));
  assert.equal(r.ok, false);
  assert.ok(failed(r).includes("said"));
});

test("tamperField must be an invoice attribute", () => {
  assert.throws(() => checkInvoice(evidence, opts(INV3, { tamperField: "nope" })), /tamperField/);
  assert.throws(() => checkInvoice(evidence, opts(INV3, { tamperField: "d" })), /tamperField/);
});

test("P6: admitSuccess:false copy is refused", () => {
  const ev = clone();
  ev.invoices.find((i) => i.said === INV3).ipex.admitSuccess = false;
  const r = checkInvoice(ev, opts(INV3));
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ["admit"]);
});

test("credentialHeld false / grant mismatch / strict false are refused", () => {
  let ev = clone();
  ev.invoices[0].ipex.credentialHeld = false;
  assert.deepEqual(failed(checkInvoice(ev, opts(INV3))), ["held"]);
  ev = clone();
  ev.invoices[0].ipex.grantCredentialSaid = INV4;
  assert.deepEqual(failed(checkInvoice(ev, opts(INV3))), ["grant"]);
  ev = clone();
  ev.checks.passed = false;
  assert.deepEqual(failed(checkInvoice(ev, opts(INV3))), ["strict"]);
});

test("issuer rule: undelegated agent or wrong OOR is refused", () => {
  let ev = clone();
  ev.companies.flatMap((c) => c.agents).find((a) => a.alias === cfg.sellerAgent).delegationVerified = false;
  assert.deepEqual(failed(checkInvoice(ev, opts(INV3))), ["issuer"]);
  ev = clone();
  ev.invoices[0].issuerDelegatedFrom.officerOorSaid = "Ewrong";
  assert.deepEqual(failed(checkInvoice(ev, opts(INV3))), ["issuer"]);
  assert.deepEqual(failed(checkInvoice(evidence, opts(INV3, { sellerAgent: "tommyBuyerAgent" }))), ["issuer"]);
});

test("payee and chain must match", () => {
  assert.deepEqual(failed(checkInvoice(evidence, opts(INV3, { payee: "someone.testnet" }))), ["payee"]);
  assert.deepEqual(failed(checkInvoice(evidence, opts(INV3, { network: "mainnet" }))), ["chain"]);
});

test("unknown SAID is refused", () => {
  const r = checkInvoice(evidence, opts("Eunknown"));
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ["found"]);
});

test("amountUnits: text digits, no floats, max 6 decimals", () => {
  assert.equal(amountUnits('{"totalAmount":0.084,"x":1}', 6).units, 84000n);
  assert.equal(amountUnits('{"totalAmount":0.1575}', 6).units, 157500n);
  assert.equal(amountUnits('{"totalAmount":"12.5"}', 6).units, 12500000n);
  assert.equal(amountUnits('{"totalAmount":3}', 6).units, 3000000n);
  assert.match(amountUnits('{"totalAmount":0.0000001}', 6).error, /fractional/);
  assert.match(amountUnits('{"totalAmount":0}', 6).error, /> 0/);
  assert.match(amountUnits('{"totalAmount":1e-3}', 6).error, /not found/);
  assert.match(amountUnits('{"totalAmount":-1}', 6).error, /negative/);
});

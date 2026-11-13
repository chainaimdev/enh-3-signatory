// Change #2: invoice commitment shared by the bridge and the signer (no keys, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buyerAgentAccount, commitmentHex, isHex64, newSalt, readCommitRecord, writeCommitRecord } from "../shared/commit.mjs";

const INV3 = "EBQy-FlPtaa6_kh-BZI5Cn-ndtJ2It5Q3JNDMH3oYY1z";
const BASE = {
  said: INV3,
  payee: "chainaim-jupiter-payee.testnet",
  amountUnits: "84000",
  buyerAgent: "chainaim-tommy-buyer-agent.testnet",
  salt: "00112233445566778899aabbccddeeff",
};
// Same vector as contract/src/tests.rs INV3_COMMIT_VECTOR: Rust and JavaScript must agree.
const VECTOR = "4873ca7444354cddb4809c6e5782c8db7447c22390a8b264955d1e009bc75634";

test("commitment equals the contract's test vector", () => {
  assert.equal(commitmentHex(BASE), VECTOR);
  assert.equal(commitmentHex({ ...BASE, checkoutHash: "" }), VECTOR);
});

test("every bound field changes the commitment", () => {
  for (const change of [
    { payee: "someone.testnet" },
    { amountUnits: "84001" },
    { buyerAgent: "other-agent.testnet" },
    { salt: "ff".repeat(16) },
    { checkoutHash: "ab".repeat(32) },
    { said: "Eother" },
  ]) {
    assert.notEqual(commitmentHex({ ...BASE, ...change }), VECTOR, JSON.stringify(change));
  }
});

test("bad inputs are refused (unambiguous preimage)", () => {
  assert.throws(() => commitmentHex({ ...BASE, said: "E|x" }), /said/);
  assert.throws(() => commitmentHex({ ...BASE, payee: "a|b.testnet" }), /payee/);
  assert.throws(() => commitmentHex({ ...BASE, amountUnits: "0" }), /amountUnits/);
  assert.throws(() => commitmentHex({ ...BASE, amountUnits: "1.5" }), /amountUnits/);
  assert.throws(() => commitmentHex({ ...BASE, salt: "short" }), /salt/);
  assert.throws(() => commitmentHex({ ...BASE, salt: BASE.salt.toUpperCase() }), /salt/);
  assert.throws(() => commitmentHex({ ...BASE, checkoutHash: "xyz" }), /checkoutHash/);
});

test("newSalt is 32 random lowercase hex characters", () => {
  const a = newSalt();
  const b = newSalt();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.equal(isHex64(VECTOR), true);
  assert.equal(isHex64("ABC"), false);
});

test("records: write once, read back, verified, never overwritten with a different commit", () => {
  const dir = mkdtempSync(join(tmpdir(), "commits-"));
  try {
    assert.equal(readCommitRecord(dir, INV3), null);
    const rec = { ...BASE, checkoutHash: "", commit: commitmentHex(BASE), contractId: "c.testnet", createdAt: "2026-11-14T00:00:00Z" };
    writeCommitRecord(dir, rec);
    assert.deepEqual(readCommitRecord(dir, INV3), rec);
    // same record again: accepted (idempotent)
    writeCommitRecord(dir, rec);
    // a different commit for the same SAID: refused
    const other = { ...rec, salt: "ee".repeat(16) };
    other.commit = commitmentHex(other);
    assert.throws(() => writeCommitRecord(dir, other), /different commit record/);
    // a tampered file is detected on read
    const p = join(dir, `${INV3}.json`);
    const t = JSON.parse(readFileSync(p, "utf8"));
    t.amountUnits = "1";
    writeFileSync(p, JSON.stringify(t));
    assert.throws(() => readCommitRecord(dir, INV3), /inconsistent/);
    if (process.platform !== "win32") assert.equal(statSync(p).mode & 0o077, 0, "record readable by the owner only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buyerAgentAccount picks the single buyer_agent alias", () => {
  assert.equal(buyerAgentAccount({ aliases: { a: { role: "buyer_agent", account: "x.testnet" }, b: { role: "cpo", account: "y.testnet" } } }), "x.testnet");
  assert.throws(() => buyerAgentAccount({ aliases: {} }), /exactly one/);
});

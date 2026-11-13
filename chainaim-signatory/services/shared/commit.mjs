// Invoice commitment (change #2, 2026-11-14) — the same string and hash as contract/src/lib.rs `commitment_hex`:
//   commit = hex(sha256("signatory-commit-v1|<said>|<payee>|<amount_units>|<buyer_agent>|<salt>|<checkout_hash>"))
// Only `commit` goes on-chain at registration. The record below (with the salt) stays off-chain in a
// git-ignored folder (config `commitsPath`, default private/commits) until the signer reveals it at payment.
// The salt is not a key, but it must stay private until payment: without it the commitment cannot be
// matched to a guessed amount or payee.
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const COMMIT_DOMAIN = "signatory-commit-v1";
const HEX64 = /^[0-9a-f]{64}$/;
const SALT_RE = /^[0-9a-f]{32,128}$/;
const SAID_FILE_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** hex(sha256(preimage)); every part is validated so the preimage is unambiguous ('|' cannot appear). */
export function commitmentHex({ said, payee, amountUnits, buyerAgent, salt, checkoutHash = "" }) {
  if (!SAID_FILE_RE.test(said)) throw new Error("commit: said must be base64url, 1..128 characters");
  if (!/^[0-9]+$/.test(String(amountUnits)) || BigInt(amountUnits) <= 0n) throw new Error("commit: amountUnits must be a positive integer string");
  for (const [k, v] of [["payee", payee], ["buyerAgent", buyerAgent]]) {
    if (typeof v !== "string" || !/^[a-z0-9._-]{2,64}$/.test(v)) throw new Error(`commit: ${k} must be a NEAR account id`);
  }
  if (!SALT_RE.test(salt)) throw new Error("commit: salt must be 32..128 lowercase hex characters");
  if (checkoutHash !== "" && !HEX64.test(checkoutHash)) throw new Error("commit: checkoutHash must be empty or 64 lowercase hex characters");
  const pre = `${COMMIT_DOMAIN}|${said}|${payee}|${BigInt(amountUnits).toString()}|${buyerAgent}|${salt}|${checkoutHash}`;
  return createHash("sha256").update(pre, "utf8").digest("hex");
}

/** 16 random bytes as lowercase hex (32 characters). */
export function newSalt() {
  return randomBytes(16).toString("hex");
}

export function isHex64(s) {
  return typeof s === "string" && HEX64.test(s);
}

function recordPath(dir, said) {
  if (!SAID_FILE_RE.test(said)) throw new Error("commit record: said must be base64url, 1..128 characters");
  return join(dir, `${said}.json`);
}

/** The record for `said`, or null when there is none. Throws on an unreadable or inconsistent file. */
export function readCommitRecord(dir, said) {
  const p = recordPath(dir, said);
  if (!existsSync(p)) return null;
  const rec = JSON.parse(readFileSync(p, "utf8"));
  const again = commitmentHex(rec);
  if (rec.said !== said || again !== rec.commit) throw new Error(`commit record ${p} is inconsistent (said or commit does not match its fields)`);
  return rec;
}

/** Writes a new record (never overwrites a different one). Owner-only file mode where the OS supports it. */
export function writeCommitRecord(dir, rec) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const existing = readCommitRecord(dir, rec.said);
  if (existing) {
    if (existing.commit !== rec.commit) throw new Error(`a different commit record already exists for ${rec.said}`);
    return existing;
  }
  writeFileSync(recordPath(dir, rec.said), JSON.stringify(rec, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  return rec;
}

/** The single buyer-agent account in accounts.json (role buyer_agent). */
export function buyerAgentAccount(accounts) {
  const list = Object.values(accounts.aliases || {}).filter((e) => e.role === "buyer_agent");
  if (list.length !== 1) throw new Error("accounts.json must have exactly one alias with role buyer_agent");
  return list[0].account;
}

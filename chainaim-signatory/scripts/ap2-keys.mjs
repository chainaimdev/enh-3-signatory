#!/usr/bin/env node
// Change #3: creates one ES256 (EC P-256) AP2 signing key — MANUAL, run once per party by the owner.
//   node scripts/ap2-keys.mjs --party merchant      (Jupiter: signs the checkout = merchant_authorization)
//   node scripts/ap2-keys.mjs --party buyer         (tommyBuyerAgent: signs the payment mandate)
//   [--config <path>] [--force]
// Writes the private key (PKCS#8 PEM, file mode 600) to config ap2.<party>KeyPath (default private/ap2-keys/, git-ignored)
// and the public JWK (kid = RFC 7638 thumbprint id, as packages/ap2) to ap2.<party>PublicJwkPath (config/ap2-keys/, public).
// Refuses to overwrite an existing private key unless --force. Prints only the kid and the two file paths — never a key.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./lib/common.mjs";
import { publicJwkOf } from "../services/shared/ap2.mjs";

const { values: flags } = parseArgs({
  options: { party: { type: "string" }, config: { type: "string" }, force: { type: "boolean", default: false } },
});
const cfg = loadConfig(flags.config);
const party = flags.party;
if (party !== "merchant" && party !== "buyer") {
  console.error("usage: node scripts/ap2-keys.mjs --party merchant|buyer [--force]");
  process.exit(64);
}
const keyPath = party === "merchant" ? cfg.paths.ap2MerchantKey : cfg.paths.ap2BuyerKey;
const pubPath = party === "merchant" ? cfg.paths.ap2MerchantPublicJwk : cfg.paths.ap2BuyerPublicJwk;
if (!keyPath || !pubPath) {
  console.error("config/signatory.json: ap2 key paths missing");
  process.exit(64);
}
if (existsSync(keyPath) && !flags.force) {
  console.error(`FAIL: ${keyPath} exists; not overwritten (use --force to replace it, which invalidates signatures made with it)`);
  process.exit(1);
}
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicJwkOf(privateKey);
mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
mkdirSync(dirname(pubPath), { recursive: true });
writeFileSync(keyPath, privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
writeFileSync(pubPath, JSON.stringify(jwk, null, 2) + "\n");
console.log(`PASS: ${party} ES256 key created`);
console.log(`  kid:        ${jwk.kid}`);
console.log(`  private key: ${keyPath}  (git-ignored; never paste or share)`);
console.log(`  public JWK:  ${pubPath}`);

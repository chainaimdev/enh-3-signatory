// S-5 bridge rules (pure, no network): SAID recompute + R-IPEX on the vLEI evidence export.
// SAID = Blake3-256 of acdcRaw with top-level `d` replaced by 44 '#' (field order kept, compact JSON),
// base64url of [0x00 || digest] with the first char replaced by the CESR code 'E'.
import { blake3 } from "@noble/hashes/blake3.js";

export const SAID_PLACEHOLDER = "#".repeat(44);

export function computeSaid(rawObj) {
  const copy = JSON.parse(JSON.stringify(rawObj)); // keeps insertion order
  copy.d = SAID_PLACEHOLDER;
  const digest = blake3(new TextEncoder().encode(JSON.stringify(copy)));
  const padded = new Uint8Array(33);
  padded.set(digest, 1);
  return "E" + Buffer.from(padded).toString("base64url").slice(1);
}

/** totalAmount digits taken from the raw JSON text (never through a JS float) → integer units. */
export function amountUnits(rawText, decimals) {
  const m = /"totalAmount"\s*:\s*("?)(-?[0-9]+)(?:\.([0-9]+))?\1(?=\s*[,}])/.exec(rawText);
  if (!m) return { error: "totalAmount not found or not a plain decimal" };
  if (m[2].startsWith("-")) return { error: "totalAmount is negative" };
  const frac = m[3] || "";
  if (frac.length > decimals) return { error: `totalAmount has ${frac.length} fractional digits (max ${decimals})` };
  const units = BigInt(m[2] + frac.padEnd(decimals, "0"));
  if (units <= 0n) return { error: "totalAmount must be > 0" };
  return { units, text: frac ? `${m[2]}.${frac}` : m[2] };
}

export function evidenceInvoices(evidence) {
  if (Array.isArray(evidence.invoices) && evidence.invoices.length) return evidence.invoices;
  return evidence.invoice ? [evidence.invoice] : [];
}

/**
 * Alters a copy of the ACDC attribute `field` (labelled demo, scene 3). Returns the new raw text.
 * strings get "-TAMPERED" appended, numbers get +1.
 */
export function tamper(rawText, field) {
  const obj = JSON.parse(rawText);
  if (!obj.a || field === "d" || !(field in obj.a)) throw new Error(`tamperField must be an attribute of the invoice (a.*), got ${field}`);
  const v = obj.a[field];
  if (typeof v === "string") obj.a[field] = `${v}-TAMPERED`;
  else if (typeof v === "number") obj.a[field] = v + 1;
  else throw new Error(`tamperField ${field} is not a string or number`);
  return JSON.stringify(obj);
}

/**
 * Runs every rule and reports all of them.
 * opts: { said, tamperField?, payee, network, sellerAgent, decimals }
 * Returns { ok, said, reason?, checks[], info{}, reveal?, demo? }
 * reveal = { said, payee, amountUnits }: the fields the commitment binds (change #2). LEIs and due date are
 * checked here (they are inside the hashed ACDC) but never leave the bridge.
 */
export function checkInvoice(evidence, opts) {
  const { said, tamperField, payee, network, sellerAgent, decimals } = opts;
  const checks = [];
  const add = (rule, ok, detail) => checks.push({ rule, ok: !!ok, detail });
  const result = (extra = {}) => {
    const failed = checks.find((c) => !c.ok);
    return { ok: !failed, said, ...(failed ? { reason: `${failed.rule}: ${failed.detail}` } : {}), checks, ...extra };
  };

  const invoice = evidenceInvoices(evidence).find((i) => i.said === said);
  add("found", invoice, invoice ? "invoice in evidence" : "no invoice with this SAID in the evidence export");
  if (!invoice) return result();
  if (typeof invoice.acdcRaw !== "string") {
    add("acdc", false, "acdcRaw missing");
    return result();
  }

  let rawText = invoice.acdcRaw;
  let demo;
  if (tamperField) {
    rawText = tamper(rawText, tamperField);
    demo = { tamper: true, tamperedField: tamperField, label: "DEMO: altered copy of the issued invoice (scene 3)" };
  }
  const raw = JSON.parse(rawText);
  const a = raw.a || {};

  // 1. SAID
  const computed = computeSaid(raw);
  add("said", computed === said && raw.d === said, computed === said ? "Blake3 SAID recomputed and equal" : `recomputed ${computed} ≠ ${said}`);

  // 2. R-IPEX
  const ipex = invoice.ipex || {};
  add("strict", evidence.checks?.strict === true && evidence.checks?.passed === true,
    `export strict=${evidence.checks?.strict} passed=${evidence.checks?.passed}`);
  add("grant", ipex.grantCredentialSaid === said, ipex.grantCredentialSaid === said ? "IPEX grant carries this SAID" : `grant credential ${ipex.grantCredentialSaid}`);
  add("admit", ipex.admitSuccess === true, `admitSuccess=${ipex.admitSuccess}`);
  add("held", ipex.credentialHeld === true, `credentialHeld=${ipex.credentialHeld}`);

  // 3. issuer = seller agent, delegated from an OOR officer
  const agents = (evidence.companies || []).flatMap((c) => c.agents || []);
  const officers = (evidence.companies || []).flatMap((c) => c.officers || []);
  const agent = agents.find((x) => x.alias === sellerAgent);
  const from = invoice.issuerDelegatedFrom || {};
  const officer = officers.find((o) => o.aid === from.officerAid);
  const issuerProblems = [];
  if (!agent) issuerProblems.push(`seller agent ${sellerAgent} not in evidence`);
  else {
    if (raw.i !== agent.aid) issuerProblems.push("ACDC issuer ≠ seller agent AID");
    if (invoice.issuerAid !== agent.aid) issuerProblems.push("issuerAid ≠ seller agent AID");
    if (agent.delegationVerified !== true) issuerProblems.push("agent delegation not verified");
    if (agent.delegator !== from.officerAid) issuerProblems.push("agent delegator ≠ issuerDelegatedFrom.officerAid");
  }
  if (!officer) issuerProblems.push("delegating officer not in evidence");
  else if (officer.oorCredential?.said !== from.officerOorSaid) issuerProblems.push("officer OOR credential ≠ issuerDelegatedFrom.officerOorSaid");
  add("issuer", issuerProblems.length === 0,
    issuerProblems.length ? issuerProblems.join("; ") : `${sellerAgent}, delegated from ${officer.alias} (OOR ${from.officerOorSaid})`);

  // 4. chain, payee, amount (all from the hashed bytes)
  const wantChain = `near:${network}`;
  add("chain", a.paymentChainID === wantChain, `paymentChainID ${a.paymentChainID}`);
  add("payee", a.paymentWalletAddress === payee, a.paymentWalletAddress === payee ? `payee ${payee}` : `paymentWalletAddress ${a.paymentWalletAddress} ≠ accounts.json payee ${payee}`);
  const amt = amountUnits(rawText, decimals);
  add("amount", !amt.error, amt.error || `${amt.text} → ${amt.units} units`);

  const info = {
    invoiceNumber: a.invoiceNumber,
    issuanceVerified: invoice.issuanceVerified === true, // reported, not a rule (vLEI G-36)
  };
  const out = result({ info, ...(demo ? { demo } : {}) });
  if (out.ok) {
    out.reveal = { said, payee: a.paymentWalletAddress, amountUnits: amt.units.toString() };
  }
  return out;
}

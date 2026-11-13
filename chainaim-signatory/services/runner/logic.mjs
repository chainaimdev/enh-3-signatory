// S-7 runner, pure logic (no network): invoice list with runnable flag, deterministic request parsing,
// matching a request to an issued unpaid invoice. Never invents an invoice or an amount.
import { formatUnits } from "../../scripts/lib/common.mjs";
import { amountUnits, evidenceInvoices } from "../bridge/rules.mjs";

export const BLOCKING_STATUSES = ["paid", "pending", "rejected"];

/** Decimal string → integer units (string math). Returns null if not exact at `decimals`. */
export function toUnits(text, decimals) {
  const clean = String(text).replace(/,/g, "");
  const m = /^([0-9]+)(?:\.([0-9]+))?$/.exec(clean);
  if (!m) return null;
  const frac = m[2] || "";
  if (frac.length > decimals) return null;
  return BigInt(m[1] + frac.padEnd(decimals, "0"));
}

/**
 * Issued invoices from the evidence + live status.
 * onChain: { [said]: get_invoice result | null }
 */
export function listInvoices(evidence, onChain, { decimals, demoScale, realCurrency = "USD" }) {
  return evidenceInvoices(evidence).map((inv) => {
    const raw = JSON.parse(inv.acdcRaw);
    const a = raw.a || {};
    const amt = amountUnits(inv.acdcRaw, decimals);
    const chain = onChain[inv.said] ?? null;
    const status = chain ? chain.status : "unregistered";
    const runnable = !amt.error && !BLOCKING_STATUSES.includes(status);
    const units = amt.error ? null : amt.units;
    return {
      said: inv.said,
      invoiceNumber: a.invoiceNumber,
      amount: units === null ? null : formatUnits(units, decimals),
      amountUnits: units === null ? null : units.toString(),
      currency: a.currency,
      realAmount: units === null ? null : `${(units * BigInt(demoScale) / 10n ** BigInt(decimals)).toLocaleString("en-US")} ${realCurrency}`,
      dueDate: a.dueDate,
      payee: a.paymentWalletAddress,
      status,
      runnable,
      ...(runnable ? {} : { reason: amt.error ? `amount: ${amt.error}` : `invoice is ${status}` }),
    };
  });
}

/**
 * Deterministic request parsing.
 *  - invoice number: INV-YYYY-NNNN
 *  - token amount:   "<n> USDC"
 *  - real amount:    "$<n>" or "<n> USD" (converted with demoScale: real / demoScale = USDC)
 *  - quantity:       "<n> <word>" that is not a currency (reported only; demo invoices are quantity 1)
 */
export function parseRequest(text, { decimals, demoScale }) {
  const parsed = { text };
  const inv = /\bINV-\d{4}-\d{4}\b/i.exec(text);
  if (inv) parsed.invoiceNumber = inv[0].toUpperCase();

  const NUM = "([0-9]{1,3}(?:,[0-9]{3})+(?:\\.[0-9]+)?|[0-9]+(?:\\.[0-9]+)?)";
  const usdc = new RegExp(`${NUM}\\s*USDC\\b`, "i").exec(text);
  const usd = new RegExp(`\\$\\s*${NUM}|${NUM}\\s*USD\\b(?!C)`, "i").exec(text);
  if (usdc) {
    const u = toUnits(usdc[1], decimals);
    if (u === null) parsed.amountError = `"${usdc[0]}" has more than ${decimals} decimals`;
    else Object.assign(parsed, { amountUnits: u.toString(), amountSource: usdc[0].trim(), amountKind: "token" });
  } else if (usd) {
    const realText = usd[1] ?? usd[2];
    const scaled = toUnits(realText, decimals);
    const ds = BigInt(demoScale);
    if (scaled === null || scaled % ds !== 0n) {
      parsed.amountError = `"${usd[0].trim()}" does not convert exactly at demo scale 1:${demoScale}`;
    } else {
      Object.assign(parsed, { amountUnits: (scaled / ds).toString(), amountSource: usd[0].trim(), amountKind: "real", demoScale });
    }
  }
  // quantity + item phrase: "<n> <word> [<word> …]" up to 5 words, stopping at punctuation or a joining word
  const NOT_ITEMS = /^(usdc?|days?|weeks?|months?|years?|hours?|minutes?|mins?|percent|pct)$/i;
  const STOP = "(?:total|for|at|worth|about|deliver|delivered|delivery|by|in|with|of|and|to|per|each|usd|usdc|please)";
  const qtyRe = new RegExp(`(?<![$.,\\d])\\b([0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)\\s+([a-z][a-z'-]*(?:\\s+(?!${STOP}\\b)[a-z][a-z'-]*){0,4})`, "gi");
  for (const q of text.replace(/\bINV-\d{4}-\d{4}\b/gi, " ").matchAll(qtyRe)) {
    const first = q[2].split(/\s+/)[0];
    if (NOT_ITEMS.test(first) || new RegExp(`^${STOP}$`, "i").test(first)) continue;
    if ((usd && usd[0].includes(q[1])) || (usdc && usdc[0].includes(q[1]))) continue;
    parsed.quantity = Number(q[1].replace(/,/g, ""));
    parsed.item = q[2].toLowerCase();
    break;
  }
  if (parsed.amountUnits) parsed.amount = formatUnits(parsed.amountUnits, decimals);
  return parsed;
}

/** Picks the first runnable invoice (evidence order) that the request names. Honest refusal otherwise. */
export function matchInvoice(invoices, parsed) {
  const runnable = invoices.filter((i) => i.runnable);
  const options = runnable.map((i) => `${i.invoiceNumber} ${i.amount} ${i.currency}`).join(", ") || "none";
  if (parsed.invoiceNumber) {
    const inv = invoices.find((i) => i.invoiceNumber === parsed.invoiceNumber);
    if (!inv) return { error: `No issued invoice ${parsed.invoiceNumber} — issue one first. Runnable: ${options}` };
    if (!inv.runnable) return { error: `${inv.invoiceNumber} is ${inv.status}, it cannot be paid again. Runnable: ${options}` };
    if (parsed.amountUnits && parsed.amountUnits !== inv.amountUnits) {
      return { error: `${inv.invoiceNumber} is ${inv.amount} ${inv.currency}, not ${parsed.amount}` };
    }
    return { invoice: inv };
  }
  if (parsed.amountError) return { error: `${parsed.amountError}. Runnable: ${options}` };
  if (!parsed.amountUnits) {
    return { error: `The request names no amount or invoice number, so no issued invoice can be matched. Runnable: ${options}` };
  }
  const inv = runnable.find((i) => i.amountUnits === parsed.amountUnits);
  if (!inv) return { error: `No issued unpaid invoice for ${parsed.amount} USDC — issue one first. Runnable: ${options}` };
  return { invoice: inv };
}

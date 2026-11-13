// S-7B Phase B: vLEI side of the runner. Calls the EXISTING vLEI tools, never edits them:
//   issue  = bash issue-additional-invoice.sh --invoice-config <generated file>   (Ubuntu bash, cwd legentvLEI)
//   export = <Windows node.exe> export-signatory-evidence.js --strict --out <evidence> (G-42: Windows node from WSL)
// Also: next free invoice number, generated config, preflight checks, output redaction.
// Nothing here reads a BRAN or key file; output lines that look key-related are dropped before they leave.
import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { formatUnits } from "../../scripts/lib/common.mjs";
import { evidenceInvoices } from "../bridge/rules.mjs";

// ------------------------------------------------------------------ proof helpers

const KEY_LIKE = /(bran|passcode|pass_code|secret|salt|privkey|private[_ -]?key|seed[_ -]?phrase|mnemonic)/i;

export function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}

/** Drops every line that mentions a key-like word; returns {text, dropped}. */
export function redact(text) {
  const lines = stripAnsi(text).split(/\r?\n/);
  const kept = lines.filter((l) => !KEY_LIKE.test(l));
  return { text: kept.join("\n"), dropped: lines.length - kept.length };
}

/** Last `n` lines of redacted text, at most `maxChars`. */
export function proofTail(text, n = 40, maxChars = 6000) {
  const r = redact(text);
  let t = r.text.split("\n").filter((l, i, a) => !(i === a.length - 1 && l === "")).slice(-n).join("\n");
  if (t.length > maxChars) t = "…" + t.slice(-maxChars);
  return r.dropped ? `${t}\n[${r.dropped} key-like line(s) removed]` : t;
}

/** Pretty JSON, redacted line by line, truncated. */
export function proofJson(obj, maxChars = 6000) {
  const r = redact(JSON.stringify(obj, null, 2));
  let t = r.text;
  if (t.length > maxChars) t = t.slice(0, maxChars) + "\n…";
  return r.dropped ? `${t}\n[${r.dropped} key-like line(s) removed]` : t;
}

// ------------------------------------------------------------------ processes

/** Runs a process without a shell. Never throws. Keeps the last 256 KiB of each stream. */
export function runProcess(cmd, args, { cwd, timeoutMs = 60000, env } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: env ?? process.env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ exitCode: null, signal: null, timedOut: false, stdout: "", stderr: e.message, ms: Date.now() - t0, spawnError: e.message });
    }
    const keep = (s, d) => (s + d).slice(-262144);
    child.stdout.on("data", (d) => (stdout = keep(stdout, d.toString("utf8"))));
    child.stderr.on("data", (d) => (stderr = keep(stderr, d.toString("utf8"))));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, stdout, stderr: stderr + e.message, ms: Date.now() - t0, spawnError: e.message });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code, signal, timedOut, stdout, stderr, ms: Date.now() - t0 });
    });
  });
}

// ------------------------------------------------------------------ invoice numbers

const NUM_RE = /^INV-(\d{4})-(\d{4})$/;

function numbersInJsonFiles(dir, pick) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const n = pick(JSON.parse(readFileSync(join(dir, f), "utf8")));
      if (typeof n === "string") out.push(n);
    } catch {
      /* unreadable file: ignored */
    }
  }
  return out;
}

/**
 * Next free invoice number = highest INV-<year>-NNNN seen + 1, over:
 *   evidence invoices · appconfig/*.json · appconfig/generated-runs/*.json · task-data seller credential files
 *   (the same files issue-additional-invoice.sh checks for duplicates).
 */
export function nextInvoiceNumber({ vleiDir, evidence, sellerAgent, year = "2026" }) {
  const sources = {
    evidence: evidenceInvoices(evidence || {}).map((i) => {
      try {
        return JSON.parse(i.acdcRaw).a.invoiceNumber;
      } catch {
        return null;
      }
    }),
    appconfig: numbersInJsonFiles(join(vleiDir, "appconfig"), (j) => j?.invoice?.sampleInvoice?.invoiceNumber),
    generatedRuns: numbersInJsonFiles(join(vleiDir, "appconfig", "generated-runs"), (j) => j?.invoice?.sampleInvoice?.invoiceNumber),
    taskData: [],
  };
  const td = join(vleiDir, "task-data");
  if (existsSync(td)) {
    const prefix = `${sellerAgent}-self-invoice-credential-info`;
    for (const f of readdirSync(td)) {
      if (!f.startsWith(prefix) || !f.endsWith(".json")) continue;
      try {
        const n = JSON.parse(readFileSync(join(td, f), "utf8")).invoiceNumber;
        if (typeof n === "string") sources.taskData.push(n);
      } catch {
        /* ignored */
      }
    }
  }
  const highest = {};
  let max = 0;
  for (const [k, list] of Object.entries(sources)) {
    let m = 0;
    for (const n of list) {
      const x = NUM_RE.exec(n || "");
      if (x && x[1] === year) m = Math.max(m, Number(x[2]));
    }
    highest[k] = m ? `INV-${year}-${String(m).padStart(4, "0")}` : null;
    max = Math.max(max, m);
  }
  return { invoiceNumber: `INV-${year}-${String(max + 1).padStart(4, "0")}`, highest };
}

// ------------------------------------------------------------------ invoice config

/** units → JSON number whose shortest text equals the decimal string (e.g. 120000 → 0.12). */
export function unitsToJsonNumber(units, decimals) {
  const text = formatUnits(units, decimals);
  const n = Number(text);
  if (String(n) !== text) throw new Error(`amount ${text} has no exact JSON number form`);
  return n;
}

/**
 * Line-item description from the request (item + quantity + real total), e.g.
 * "Cotton t-shirts, 8,000 pcs (demo scale 1:1,000,000; real 84,000.00 USD)". Numbers in the invoice stay
 * quantity 1 / unitPrice = amount (vLEI float rule); the piece count lives only in this text.
 * Without an item in the request: "Order (demo scale …; real … USD)".
 */
export function lineItemDescription({ item, quantity, units, decimals, demoScale }) {
  const real = (BigInt(units) * BigInt(demoScale)) / 10n ** BigInt(decimals);
  const realText = Number(real).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const clean = typeof item === "string" ? item.replace(/[^a-z' -]/gi, "").replace(/\s+/g, " ").trim().slice(0, 60) : "";
  const base = clean ? clean[0].toUpperCase() + clean.slice(1) : "Order";
  const qty = clean && Number.isInteger(quantity) && quantity > 0 ? `, ${quantity.toLocaleString("en-US")} pcs` : "";
  return `${base}${qty} (demo scale 1:${Number(demoScale).toLocaleString("en-US")}; real ${realText} USD)`;
}

/**
 * Writes appconfig/generated-runs/invoiceConfig-run-<INV>.json from the template (same parties, payee, chain).
 * Refuses to overwrite. Returns {path, relPath, config, description}.
 */
export function writeInvoiceConfig({ vleiDir, template, invoiceNumber, units, decimals, demoScale, item, quantity, now = new Date() }) {
  const tpl = JSON.parse(readFileSync(join(vleiDir, template), "utf8"));
  const s = tpl.invoice?.sampleInvoice;
  if (!s) throw new Error(`template ${template} has no invoice.sampleInvoice`);
  const amount = unitsToJsonNumber(units, decimals);
  if (amount < 0.0001) throw new Error(`amount ${amount} < 0.0001 (vLEI float guard)`);
  const day = (d) => `${d.toISOString().slice(0, 10)}T00:00:00Z`;
  const description = lineItemDescription({ item, quantity, units, decimals, demoScale });
  s.invoiceNumber = invoiceNumber;
  s.invoiceDate = day(now);
  s.dueDate = day(new Date(now.getTime() + 30 * 86400000));
  s.totalAmount = amount;
  s.lineItems = [
    {
      description,
      quantity: 1,
      unitPrice: amount,
      amount,
    },
  ];
  s.ref_uri = `urn:chainaim:order:${invoiceNumber}`;
  const dir = join(vleiDir, "appconfig", "generated-runs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `invoiceConfig-run-${invoiceNumber}.json`);
  writeFileSync(path, JSON.stringify(tpl, null, 2) + "\n", { flag: "wx" });
  return { path, relPath: "./" + relative(vleiDir, path).split("\\").join("/"), config: tpl, description };
}

// ------------------------------------------------------------------ outputs

const ISSUED_RE = /✓\s+(INV-\d{4}-\d{4})\s+\((E[A-Za-z0-9_-]{43})\)\s+issued, granted, admitted and held/;

/** Parses the success line of issue-additional-invoice.sh. */
export function parseIssueOutput(stdout) {
  const m = ISSUED_RE.exec(stripAnsi(stdout));
  return m ? { invoiceNumber: m[1], said: m[2] } : null;
}

/** The IPEX grant of `said`, from the archived grant file (only public fields). */
export function readGrantInfo({ vleiDir, sellerAgent, said }) {
  const td = join(vleiDir, "task-data");
  const candidates = [`${sellerAgent}-ipex-grant-info.${said}.json`, `${sellerAgent}-ipex-grant-info.json`];
  for (const f of candidates) {
    const p = join(td, f);
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (j.credentialSAID !== said) continue;
    return {
      path: p,
      grantSaid: j.grantResult?.said ?? null,
      credentialSAID: j.credentialSAID,
      invoiceNumber: j.invoiceNumber,
      sender: j.sender,
      receiver: j.receiver,
      timestamp: j.timestamp,
    };
  }
  return null;
}

// ------------------------------------------------------------------ identity chain (S-7C)

/**
 * What the existing exporter proves about one agent, read from its JSON output (V-READ of
 * export-signatory-evidence.js, 13 Nov):
 *   agent → officer : live KELs from the OOBI URLs; agent inception is `dip` with di = officer AID and the
 *                     officer's KEL anchors a seal for the agent (event structure; signatures not re-verified)
 *   officer OOR     : task-data OOR credential record: issuee = officer AID, issuer = QVI AID
 *   officer → LE    : the officer is listed under that LE in the 4D config; LE AID from task-data
 *   LE → QVI        : NOT checked by the exporter (no LE credential check) — reported, never claimed
 * Returns {ok, reason?, data}.
 */
export function agentChain(evidence, alias) {
  const companies = evidence?.companies || [];
  const company = companies.find((c) => (c.agents || []).some((a) => a.alias === alias));
  const agent = company?.agents.find((a) => a.alias === alias);
  const officer = company?.officers.find((o) => o.aid === agent?.delegator);
  const oor = officer?.oorCredential;
  const qviAid = evidence?.source?.qviAid ?? null;
  const links = [
    {
      link: "agent → OOR officer",
      verified: agent?.delegationVerified === true,
      how: "live KELs via OOBI: agent inception is dip with di = officer AID, officer KEL anchors a seal for the agent (event structure; KEL signatures not re-verified by the exporter)",
    },
    {
      link: "officer holds OOR issued by the QVI",
      verified: !!(oor?.said && oor.issueeAid === officer?.aid && qviAid && oor.issuerAid === qviAid),
      how: "task-data OOR credential record: issuee = officer AID, issuer = QVI AID (record, not a credential-signature/TEL check)",
    },
    {
      link: "officer → Legal Entity",
      verified: !!company?.leAid,
      how: "officer listed under this LE in the 4D config; LE AID from task-data",
    },
    { link: "Legal Entity → QVI", verified: false, checked: false, how: "not checked: the existing exporter has no LE credential check" },
  ];
  const data = {
    agent: alias,
    agentAid: agent?.aid ?? null,
    delegationVerified: agent?.delegationVerified === true,
    officer: officer?.alias ?? null,
    officerAid: officer?.aid ?? null,
    officerOorSaid: oor?.said ?? null,
    legalEntity: company?.name ?? null,
    lei: company?.lei ?? null,
    leAid: company?.leAid ?? null,
    qviAid,
    links,
  };
  const required = links.filter((l) => l.checked !== false);
  const bad = required.filter((l) => !l.verified);
  if (!agent) return { ok: false, reason: `${alias} not in the export`, data };
  if (bad.length) return { ok: false, reason: bad.map((l) => `${l.link} not verified`).join("; "), data };
  return { ok: true, data };
}

// ------------------------------------------------------------------ preflight

/**
 * Step 0. deps: {probe(url) → {up, keysLoaded}, rpcStatus() → chain_id, run(cmd,args,opts), getMandate(acct),
 *               loadEvidence()}. Returns {ok, checks:[{name, ok, detail, api}], mandate}.
 * A revoked agent mandate is NOT a failure (the run must show the contract's refusal), it is a note.
 */
export async function preflight({ cfg, vleiDir, exportNode, signerUrl, bridgeUrl, agentAccount, keriaContainer = "keria", shellContainer = "tsx_shell", deps }) {
  const checks = [];
  const add = (name, ok, detail, api) => checks.push({ name, ok: !!ok, detail, api });
  const timed = async (fn) => {
    const t0 = Date.now();
    const r = await fn();
    return [r, Date.now() - t0];
  };

  for (const [name, url] of [["signer", signerUrl], ["bridge", bridgeUrl]]) {
    const [p, ms] = await timed(() => deps.probe(url));
    add(name, p.up && p.keysLoaded === true, p.up ? (p.keysLoaded === true ? "up, key loaded" : "up but started without keys (--no-send)") : "not reachable",
      { service: name, method: "GET", path: `${url}/health`, httpStatus: p.httpStatus ?? null, ms });
  }
  {
    const t0 = Date.now();
    try {
      const chain = await deps.rpcStatus();
      add("near_rpc", chain === (cfg.network || "testnet"), `chain_id ${chain}`, { service: "near-rpc", method: "POST", path: `${cfg.rpcUrl} status`, ms: Date.now() - t0 });
    } catch (e) {
      add("near_rpc", false, e.message, { service: "near-rpc", method: "POST", path: `${cfg.rpcUrl} status`, ms: Date.now() - t0 });
    }
  }
  {
    const r = await deps.run("docker", ["exec", shellContainer, "true"], { timeoutMs: 20000 });
    add("docker_tsx_shell", r.exitCode === 0, r.exitCode === 0 ? `${shellContainer} answers` : proofTail(r.stderr || r.stdout || r.spawnError || "failed", 3),
      { service: "docker", cmd: `docker exec ${shellContainer} true`, exitCode: r.exitCode, ms: r.ms });
  }
  {
    const fmt = "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}";
    const r = await deps.run("docker", ["inspect", "-f", fmt, keriaContainer], { timeoutMs: 20000 });
    const state = stripAnsi(r.stdout).trim();
    const ok = r.exitCode === 0 && /^running( healthy)?$/.test(state);
    add("keria", ok, r.exitCode === 0 ? `container ${keriaContainer}: ${state || "?"}` : proofTail(r.stderr || r.spawnError || "failed", 3),
      { service: "docker", cmd: `docker inspect -f '${fmt}' ${keriaContainer}`, exitCode: r.exitCode, ms: r.ms });
  }
  {
    const r = await deps.run("jq", ["--version"], { timeoutMs: 10000 });
    add("jq", r.exitCode === 0, r.exitCode === 0 ? stripAnsi(r.stdout).trim() : "jq not found (sudo apt install -y jq)", { service: "shell", cmd: "jq --version", exitCode: r.exitCode, ms: r.ms });
  }
  for (const [name, p] of [
    ["vlei_issue_script", join(vleiDir, "issue-additional-invoice.sh")],
    ["vlei_exporter", join(vleiDir, "export-signatory-evidence.js")],
    ["export_node", exportNode],
  ]) {
    add(name, existsSync(p), existsSync(p) ? p : `missing: ${p}`, { service: "fs", method: "stat", path: p });
  }
  {
    const t0 = Date.now();
    try {
      const ev = deps.loadEvidence();
      add("evidence", true, `${evidenceInvoices(ev).length} invoice(s), generatedAt ${ev.generatedAt}`, { service: "fs", method: "read", path: cfg.paths.evidence, ms: Date.now() - t0 });
    } catch (e) {
      add("evidence", false, e.message, { service: "fs", method: "read", path: cfg.paths.evidence, ms: Date.now() - t0 });
    }
  }
  let mandate = null;
  {
    const t0 = Date.now();
    try {
      mandate = await deps.getMandate(agentAccount);
      const note = !mandate ? "agent has no mandate" : mandate.revoked ? "agent mandate is REVOKED — the run continues and the contract will refuse the payment" : `limit ${formatUnits(mandate.limit_units, cfg.tokenDecimals)} USDC, not revoked`;
      add("agent_mandate", !!mandate, note, { service: "near-rpc", method: "view", path: `${cfg.contractId}.get_mandate`, ms: Date.now() - t0 });
    } catch (e) {
      add("agent_mandate", false, e.message, { service: "near-rpc", method: "view", path: `${cfg.contractId}.get_mandate`, ms: Date.now() - t0 });
    }
  }
  return { ok: checks.every((c) => c.ok), checks, mandate };
}

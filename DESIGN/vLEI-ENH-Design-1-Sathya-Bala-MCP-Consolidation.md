# vLEI Enhancement Design 1 — MCP Consolidation & API-Key Layer

**Author:** Sathya Bala
**Date:** 2026-05-24
**Status:** Draft v2 (supersedes v1 — §4 corrected per user direction: REST endpoints stay flexible, MCP tools stay flat)
**Companion to:** `vLEI-ENH-Design-1-Sathya-Bala.md`, `vLEI-ENH-Design-1-Sathya-Bala-Hybrid.md`, `vLEI-ENH-Design-1-Sathya-Bala-EndpointBucketing.md`

---

## §0 — Design principles (locked)

1. **REST endpoints grow as needed.** Today 15, tomorrow N. No constraint to consolidate them.
2. **`vlei-llms.txt` is the single source of truth for what exists.** Every REST endpoint is listed there with path, description, body schema, response shape. New endpoint = new row in `vlei-llms.txt`.
3. **MCP tools stay small (2-3 tools total), flat as N grows.** The MCP server uses `vlei-llms.txt` to discover and route — it does not need a new tool when a new REST endpoint is added.
4. **API key authentication on every REST call.** `Authorization: Bearer <key>` header. Matches massive.com's wire format (verified from `mcp_massive/src/mcp_massive/server.py`).
5. **Same backing endpoints serve both** the React web app (direct REST + Bearer) **and** LLM agents (MCP tools → REST + Bearer). One auth path. One source of truth.

---

## §1 — Massive.com's pattern (verified from source)

Read directly from `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\FINAGENTS2\mcp_massive\src\mcp_massive\server.py` and `README.md`.

### 1.1 Three tools cover ~250 endpoints

| Tool | Purpose | Side effects |
|---|---|---|
| `search_endpoints(query, scope, max_results, detail, market)` | Natural-language search over an index built from `llms.txt` | None — pure read |
| `call_api(path, params, store_as, apply, api_key)` | Execute any allowlisted REST path | Optional in-memory SQLite store |
| `query_data(sql, apply, max_cell_chars)` | SQL over stored tables | None |

The key insight: **the tool count is constant.** Massive can ship a new REST endpoint tomorrow; the MCP server picks it up by re-reading `llms.txt`. No new tool needed.

### 1.2 Auth (verified, server.py line ~377)
```python
headers = {
    "Authorization": f"Bearer {effective_key}",
    "User-Agent": f"{base_ua} {version_number}".strip(),
}
```
- Key from `MASSIVE_API_KEY` env var.
- Optional per-call `api_key` parameter overrides.
- Keys never in URL query strings. `_extract_pagination_hint` defensively strips `apiKey`/`apikey` query params (server.py line ~157).

### 1.3 Discovery via `llms.txt`
- `MASSIVE_LLMS_TXT_URL` env var (default `https://massive.com/docs/rest/llms.txt`).
- `build_index(llms_txt_url=...)` fetches and parses on first tool call.
- `idx.is_path_allowed(path)` rejects any path not in the parsed file.

### 1.4 Security perimeter (verified)
- Path traversal blocked (`..`, `\`, fully decoded).
- Query string in path rejected (`?`, `#`).
- Query param keys must match `^[a-zA-Z_][a-zA-Z0-9_.]*$`.
- 50 MB response cap unless `store_as` set.
- SQL goes through `sqlglot` AST + SQLite authorizer + function denylist.

---

## §2 — vLEI endpoint inventory (verified from server.js)

These 15 REST endpoints exist today in `legentvLEI/api-server/server.js`. **Note: this list will grow** — that's by design. The MCP tool count below does not change with it.

| # | Method | Path | Body | Side effect |
|---|---|---|---|---|
| 1 | GET | `/health` | — | None |
| 2 | GET | `/api/status` | — | Reads task-data files |
| 3 | GET | `/api/ipex-status` | — | Reads task-data files |
| 4 | POST | `/api/buyer/verify/seller` | — | Runs DEEP script |
| 5 | POST | `/api/seller/verify/buyer` | — | Runs DEEP script |
| 6 | POST | `/api/buyer/verify/ext/seller` | — | Runs DEEP-EXT script |
| 7 | POST | `/api/seller/verify/ext/buyer` | — | Runs DEEP-EXT script |
| 8 | POST | `/api/buyer/verify/sellerInvoice` | — | Runs DEEP-EXT-CREDENTIAL script |
| 9–13 | POST | `/api/verify/*` | — | Legacy, deprecated |
| 14 | POST | `/api/seller/ipex/issue-and-grant` | invoiceId, totalAmount, currency, … | State-changing: issues ACDC, IPEX-grants |
| 15 | POST | `/api/buyer/ipex/admit` | senderAgent, invoiceId | State-changing: admits IPEX grant |

DynDic3ent1 callers (verified prior turn): hit #6, #7, #14, #15. The other 11 are reachable for diagnostics and future expansion.

---

## §3 — Architecture

```
  ┌──────────────────────┐         ┌──────────────────────┐
  │  React UI / Web App  │         │   LLM agent (Claude) │
  │  (DynDic3ent1)       │         │   (any MCP client)   │
  └──────────┬───────────┘         └──────────┬───────────┘
             │ HTTPS                          │ stdio / SSE / streamable-http
             │ Bearer <key>                   │ (2 generic tools)
             │                                ▼
             │                      ┌──────────────────────┐
             │                      │  vLEI MCP server     │
             │                      │  2 tools, flat       │
             │                      │  reads vlei-llms.txt │
             │                      └──────────┬───────────┘
             │                                 │ HTTPS
             │                                 │ Bearer <key>
             ▼                                 ▼
  ┌──────────────────────────────────────────────────────┐
  │  legentvLEI/api-server (port 4000)                   │
  │  N REST endpoints (15 today, grows freely)           │
  │  Auth: Bearer <key>, AUTH_MODE=api_key               │
  └──────────────────────────────────────────────────────┘
                          ▲
                          │ catalog
              ┌───────────┴────────────┐
              │  vlei-llms.txt          │
              │  one row per REST endpoint │
              │  grows with the API     │
              └─────────────────────────┘
```

The api-server is the single source of truth. `vlei-llms.txt` is the catalog. The MCP server is a thin layer that reads the catalog and exposes 2 generic tools.

---

## §4 — vLEI MCP tool design (2 tools, flat surface)

### 4.1 The 2 tools

| Tool | Purpose | Reads from | Calls |
|---|---|---|---|
| `vlei_search_endpoints` | Natural-language search over the endpoint catalog. Returns paths, descriptions, body schemas. | `vlei-llms.txt` | Nothing |
| `vlei_call_endpoint` | Execute any allowlisted REST endpoint. Validates body against the catalog's schema before forwarding. | `vlei-llms.txt` (for allowlist + schema validation) | The vLEI api-server at port 4000 with Bearer auth |

**N REST endpoints → 2 MCP tools.** N grows. The 2 doesn't.

This is exactly massive's pattern. The only difference: we skip their third tool (`query_data`) because vLEI isn't a data-fetching API and we don't need an in-memory SQL store. If a future use case wants one, add it. Until then, 2 tools.

### 4.2 `vlei_search_endpoints` — schema and behavior

```json
{
  "name": "vlei_search_endpoints",
  "description": "Search the vLEI API endpoint catalog by natural language. Returns endpoint titles, paths, descriptions, and (with detail='more' or 'verbose') body schemas. Use this FIRST to discover what's available before calling vlei_call_endpoint. Catalog is sourced from vlei-llms.txt.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "query":       {"type": "string", "description": "Natural language search (e.g. 'verify seller delegation', 'admit an invoice credential', 'check workflow status')"},
      "detail":      {"type": "string", "enum": ["default", "more", "verbose"], "default": "default", "description": "default = title+path+desc. more = adds body schema and required fields. verbose = adds sample response shape."},
      "max_results": {"type": "integer", "minimum": 1, "maximum": 25, "default": 5}
    },
    "required": ["query"]
  }
}
```

Behavior:
- Parse `vlei-llms.txt` once at startup, index by title + description tokens.
- Simple substring + token match is enough for 15-100 entries. BM25 + alias table (massive's pattern in `constants.py`) becomes worthwhile only at hundreds of entries.
- Return ranked list with title, method, path, description; add `bodySchema` if `detail >= "more"`; add `responseSample` if `detail = "verbose"`.

### 4.3 `vlei_call_endpoint` — schema and behavior

```json
{
  "name": "vlei_call_endpoint",
  "description": "Execute any allowlisted vLEI REST endpoint. The path must appear in vlei-llms.txt. Body is validated against the catalog's JSON schema before the upstream call. Side-effecting endpoints (IPEX issue/admit) require confirm_state_change=true to be set explicitly.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "path":   {"type": "string", "description": "Exact REST path from vlei_search_endpoints results (e.g. /api/buyer/verify/ext/seller)"},
      "method": {"type": "string", "enum": ["GET", "POST"], "default": "POST"},
      "body":   {"type": "object", "description": "Request body. Validated against the catalog's schema for this path before forwarding.", "default": {}},
      "params": {"type": "object", "description": "Optional query parameters. Keys must match ^[a-zA-Z_][a-zA-Z0-9_.]*$ (massive's regex).", "default": {}},
      "confirm_state_change": {"type": "boolean", "default": false, "description": "Required to be true when the endpoint is marked as state-changing in vlei-llms.txt (e.g. IPEX issue/admit). Prevents accidental ledger writes."}
    },
    "required": ["path"]
  }
}
```

Behavior (sketch):
1. Strip the path; reject `..`, `\`, `?`, `#`, query-strings-in-path (massive's perimeter rules).
2. Look up the path in the parsed `vlei-llms.txt` allowlist. Unknown path → return `Error [NOT_FOUND]: Path not in catalog. Use vlei_search_endpoints to discover valid paths.`
3. If the catalog flags this endpoint as `stateChanging: true` and `confirm_state_change` is `false` → return `Error [STATE_CHANGE_GUARD]: This endpoint modifies KERI ledger state. Set confirm_state_change=true and call again.`
4. Validate `body` against the catalog's schema. Reject with field-level error message if invalid.
5. Build the HTTPS request with `Authorization: Bearer <VLEI_API_KEY>` header, forward to `localhost:4000`.
6. Map upstream HTTP codes to massive-style category prefixes: `Error [AUTH]:` for 401/403, `Error [RATE_LIMIT]:` for 429, `Error [SERVER]:` for 5xx, `Error [HTTP]:` for other 4xx.

### 4.4 Why 2 tools is enough — even for state-changing endpoints

My v1 design had `vlei_issue_credential` and `vlei_admit_credential` as typed 1:1 wrappers, reasoning that state-changing endpoints needed extra care. That was over-engineered. The actual safety comes from:

1. **Schema in the catalog.** Every endpoint in `vlei-llms.txt` carries its required body schema. `vlei_call_endpoint` validates client-side before forwarding. Wrong body shape → rejected before the api-server even sees the request.
2. **`confirm_state_change` guard.** State-changing endpoints in the catalog set `stateChanging: true`. The MCP tool refuses to call them unless the LLM has explicitly set `confirm_state_change=true`. This forces the LLM to think about the side effect.
3. **api-server still validates.** Even if MCP layer is bypassed, the api-server itself checks required fields (verified — `server.js` line ~351 returns 400 if `invoiceId` or `totalAmount` missing).
4. **The catalog description tells the LLM what to do.** When `vlei_search_endpoints("admit credential")` returns `/api/buyer/ipex/admit`, the description includes "Use after receiving an INVOICE or DD_INVOICE A2A message. Set confirm_state_change=true." The LLM reads this before calling.

Defense in depth, with the catalog doing most of the work. No need to grow the MCP surface with each new state-changing endpoint.

### 4.5 What this means for new endpoints
Tomorrow someone adds `POST /api/buyer/ipex/revoke` to the api-server. Steps to make it available to LLMs:

1. Add the route handler to `server.js` (normal REST work).
2. Add a row to `vlei-llms.txt` with the path, description, body schema, and `stateChanging: true`.
3. Restart the MCP server (or hot-reload the catalog file).

Zero MCP code changes. The new endpoint is immediately searchable and callable.

---

## §5 — `vlei-llms.txt` catalog format

The catalog is the load-bearing artifact of this design. It needs enough structure for:
- Searchable description (powers `vlei_search_endpoints`)
- Allowlist (powers `vlei_call_endpoint`'s path check)
- Body schema (powers client-side validation)
- State-change flag (powers the `confirm_state_change` guard)

### 5.1 Location
- **Authoritative source:** `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\FINAGENTS1\vLEIEnh1\legentvLEI\api-server\vlei-llms.txt` — ships with the api-server.
- **Served at:** `GET /llms.txt` on port 4000 (publicly accessible, no auth — it's a documentation file).
- **MCP server reads from:** the served URL by default; override via `VLEI_LLMS_TXT_URL` env var (matching massive's `MASSIVE_LLMS_TXT_URL` convention).

### 5.2 Format (Markdown with structured headers)

```markdown
# vLEI Verification & IPEX API — endpoint catalog

> Source-of-truth list for the vLEI MCP server. Every endpoint below is allowlisted; anything not here is not callable.

## Verify Seller (DEEP-EXT)

**Path:** POST /api/buyer/verify/ext/seller
**Description:** Buyer runs an extended DEEP-EXT verification of the seller's KERI delegation chain, walking external witnesses. Returns step-by-step verification result.
**Caller side:** buyer
**Target side:** seller
**Verification depth:** DEEP-EXT
**State changing:** false
**Body schema:**
```json
{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}
```
**Response sample:**
```json
{
  "success": true,
  "verificationType": "EXTERNAL",
  "verificationScript": "DEEP-EXT",
  "caller": "buyer",
  "target": "seller",
  "verification": {
    "step1_info_loaded": true,
    "step2_di_verified": true,
    "step3_seal_found": true,
    "step4_digest_verified": true,
    "step5_public_key_available": true
  }
}
```

## Issue and Grant Invoice Credential

**Path:** POST /api/seller/ipex/issue-and-grant
**Description:** Seller issues a self-attested invoice ACDC and IPEX-grants it to the buyer. Side effect: creates a credential on the seller's KERI registry. Use after a deal is closed and a PURCHASE_ORDER has been received.
**State changing:** true
**Body schema:**
```json
{
  "type": "object",
  "properties": {
    "invoiceId":     {"type": "string"},
    "invoiceDate":   {"type": "string", "format": "date-time"},
    "dueDate":       {"type": "string", "format": "date-time"},
    "totalAmount":   {"type": "number"},
    "currency":      {"type": "string", "default": "INR"},
    "pricePerUnit":  {"type": "number"},
    "quantity":      {"type": "number"},
    "paymentTerms":  {"type": "string"},
    "negotiationId": {"type": "string"},
    "type":          {"type": "string", "enum": ["INVOICE", "DD_INVOICE"], "default": "INVOICE"}
  },
  "required": ["invoiceId", "totalAmount", "type"]
}
```
**Response sample:**
```json
{
  "success": true,
  "credentialSAID": "E_abc...xyz",
  "grantSAID": "E_def...uvw",
  "invoiceId": "INV-12345"
}
```

[... one section per REST endpoint ...]
```

Massive's actual `llms.txt` format may differ — we haven't fetched it yet. The structure above is what `vlei_search_endpoints` and `vlei_call_endpoint` need; if massive's format gives us byte-compat for free we'll align (open item §11-E).

### 5.3 Maintenance discipline
- Every PR that adds or modifies a REST endpoint must also update `vlei-llms.txt`. Enforce via CI: a test that parses `vlei-llms.txt` and confirms every Express route in `server.js` has a matching catalog entry.
- Removing an endpoint = remove from `server.js` AND `vlei-llms.txt`. Otherwise the MCP server will still advertise it.
- `stateChanging: true` on every endpoint that writes to KERI registries or task-data files. Treat as a required field.

---

## §6 — API key authentication

Unchanged from v1. Restating because it's load-bearing.

### 6.1 Wire format
- `Authorization: Bearer <api-key>` header on every request to port 4000.
- No keys in URL query strings.

### 6.2 Key tiers
| Tier | What it's good for | Endpoints it can hit |
|---|---|---|
| **operator** | Onboarding, deleting counterparties | All |
| **agent** | Buyer or seller agent during A2A flow | Verification + IPEX + status |
| **viewer** | Read-only dashboards, audit replay | Status + read-only |

### 6.3 Server-side middleware
```javascript
const AUTH_MODE = (process.env.AUTH_MODE || 'none').toLowerCase();
const KEYS = {
  operator: process.env.VLEI_API_KEY_OPERATOR,
  agent:    process.env.VLEI_API_KEY_AGENT,
  viewer:   process.env.VLEI_API_KEY_VIEWER,
};

function requireRole(minRole) {
  const roleOrder = { viewer: 0, agent: 1, operator: 2 };
  return (req, res, next) => {
    if (AUTH_MODE === 'none') return next();
    const hdr = req.headers.authorization || '';
    const m = hdr.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ error: 'Missing Bearer token' });
    const presented = m[1];
    let presentedRole = null;
    for (const [role, key] of Object.entries(KEYS)) {
      if (key && presented === key) { presentedRole = role; break; }
    }
    if (!presentedRole) return res.status(401).json({ error: 'Invalid API key' });
    if (roleOrder[presentedRole] < roleOrder[minRole]) {
      return res.status(403).json({ error: `Endpoint requires role >= ${minRole}` });
    }
    req.authRole = presentedRole;
    next();
  };
}
```

### 6.4 Catalog reflects the required role
Each entry in `vlei-llms.txt` adds a `**Minimum role:**` field (`viewer`, `agent`, or `operator`). The MCP server presents this to the LLM through `vlei_search_endpoints(detail="more")` so the LLM knows ahead of time whether its configured key is sufficient.

### 6.5 What we explicitly do NOT do
- No keys in client-side JavaScript.
- No keys in URLs.
- No tokens fetched by the LLM. The MCP server has the key in its env; the LLM never sees it.

---

## §7 — Side-by-side usage

### 7.1 Web app flow (DynDic3ent1 → api-server)
```javascript
const resp = await fetch("http://localhost:4000/api/buyer/verify/ext/seller", {
  method:  "POST",
  headers: {
    "Content-Type":  "application/json",
    "Authorization": `Bearer ${process.env.VLEI_API_KEY_AGENT}`,
  },
});
```

### 7.2 LLM agent flow (Claude → MCP server → api-server)
```
User: "Verify the seller before we negotiate."

LLM: [calls vlei_search_endpoints(query="verify seller", detail="more")]
MCP server: parses vlei-llms.txt, returns matches:
  1. Verify Seller (DEEP)            POST /api/buyer/verify/seller
  2. Verify Seller (DEEP-EXT)        POST /api/buyer/verify/ext/seller    [most detailed]
  3. Verify Seller Invoice (DEEP-EXT-CREDENTIAL)  POST /api/buyer/verify/sellerInvoice

LLM: "I'll use the DEEP-EXT version for full delegation walk."
LLM: [calls vlei_call_endpoint(path="/api/buyer/verify/ext/seller", body={})]
MCP server: validates path is in catalog ✓, body schema ✓ (empty body OK).
            stateChanging=false, no confirm guard needed.
            HTTPS POST localhost:4000 with Bearer <key>
api-server: runs DEEP-EXT script, returns verification result
MCP server: returns CSV/JSON of the steps

LLM: "Seller verified. All 5 cryptographic steps passed."

User: "OK, issue the invoice for NEG-12345, total ₹50000."

LLM: [calls vlei_search_endpoints(query="issue invoice credential")]
MCP server: returns "Issue and Grant Invoice Credential" with stateChanging=true, body schema, required fields invoiceId/totalAmount/type.

LLM: [calls vlei_call_endpoint(
        path="/api/seller/ipex/issue-and-grant",
        body={invoiceId:"INV-...", totalAmount:50000, type:"INVOICE", ...},
        confirm_state_change=true
      )]
MCP server: validates path ✓, schema ✓, stateChanging+confirm ✓.
            HTTPS POST localhost:4000 with Bearer <key>
api-server: runs IPEX issue+grant scripts, returns {credentialSAID, grantSAID}

LLM: "Done. Credential SAID is E_abc...xyz. Granted to buyer."
```

The LLM never memorized a path. It searched, read the description+schema, then called with a generic tool. New endpoints work the same way — no MCP code change.

---

## §8 — Mapping matrix (current 15 endpoints)

| # | Endpoint | Min role | State changing | Catalog entry | Tool to call it |
|---|---|---|---|---|---|
| 1 | GET /health | (none) | false | optional — diagnostic only | direct probe, not via MCP |
| 2 | GET /api/status | viewer | false | yes | `vlei_call_endpoint(path="/api/status", method="GET")` |
| 3 | GET /api/ipex-status | viewer | false | yes | `vlei_call_endpoint(path="/api/ipex-status", method="GET")` |
| 4 | POST /api/buyer/verify/seller | agent | false | yes | `vlei_call_endpoint(path="/api/buyer/verify/seller")` |
| 5 | POST /api/seller/verify/buyer | agent | false | yes | `vlei_call_endpoint(path="/api/seller/verify/buyer")` |
| 6 | POST /api/buyer/verify/ext/seller | agent | false | yes | `vlei_call_endpoint(path="/api/buyer/verify/ext/seller")` |
| 7 | POST /api/seller/verify/ext/buyer | agent | false | yes | `vlei_call_endpoint(path="/api/seller/verify/ext/buyer")` |
| 8 | POST /api/buyer/verify/sellerInvoice | agent | false | yes | `vlei_call_endpoint(path="/api/buyer/verify/sellerInvoice")` |
| 9–13 | POST /api/verify/* (legacy) | agent | false | **no** — deprecated paths excluded from catalog | not callable via MCP |
| 14 | POST /api/seller/ipex/issue-and-grant | agent | **true** | yes | `vlei_call_endpoint(path="/api/seller/ipex/issue-and-grant", body={...}, confirm_state_change=true)` |
| 15 | POST /api/buyer/ipex/admit | agent | **true** | yes | `vlei_call_endpoint(path="/api/buyer/ipex/admit", body={...}, confirm_state_change=true)` |

15 endpoints, 2 MCP tools. When endpoint 16 lands (e.g. `POST /api/seller/ipex/revoke`), the catalog gets a new entry; the tool count stays at 2.

---

## §9 — Migration plan

### Phase 1 — API key auth on the existing api-server
1. Add `requireRole` middleware to `legentvLEI/api-server/server.js`.
2. Add `AUTH_MODE`, `VLEI_API_KEY_OPERATOR`, `VLEI_API_KEY_AGENT`, `VLEI_API_KEY_VIEWER` to `legentvLEI/.env`.
3. Apply middleware to routes per §8 column "Min role".
4. Update DynDic3ent1 fetch calls to include `Authorization: Bearer <key>`. One-line change per call site (4 sites in code today).
5. Smoke test all 15 endpoints with and without keys.

### Phase 2 — Author `vlei-llms.txt`
1. Create `legentvLEI/api-server/vlei-llms.txt` with one section per non-deprecated endpoint (10 entries: #1–#8, #14, #15).
2. Add `GET /llms.txt` route to `server.js` that serves the file as `text/markdown`. No auth — it's the public catalog.
3. Add a CI test: parse `vlei-llms.txt`, parse `server.js` routes, confirm every non-deprecated route has a catalog entry. Fails build if drift.

### Phase 3 — vLEI MCP server (new project)
1. Scaffold `C:\SATHYA\CHAINAIM3003\mcp-servers\FINAGENTS\FINAGENTS1\vLEIEnh1\mcp-vlei\` — Python or TypeScript, modeled on `mcp_massive`.
2. Implement 2 tools (§4.2, §4.3). Total ~200 lines.
3. Reuse massive's security primitives: path traversal check, query-param key regex, response size cap.
4. Add `VLEI_API_KEY`, `VLEI_API_BASE_URL`, `VLEI_LLMS_TXT_URL`, `MCP_TRANSPORT` env vars.
5. Test with `npx @modelcontextprotocol/inspector`.

### Phase 4 — Register with MCP clients
- Claude Desktop / Claude Code via `claude mcp add` pattern (matches massive's README).
- DynDic3ent1 agents can continue calling REST directly; no need to switch to MCP.

### Phase 5 — Layer KRAM signing on top (future)
The hybrid doc's KRAM signing is orthogonal to API keys. Once Phase 1–3 ship, every request can carry both a Bearer token (caller identity) and a `Signature-Input` header (message integrity). The api-server verifies both.

---

## §10 — What gets harder in v2 (the trade-off)

Going from 5 typed tools to 2 generic tools makes the catalog do more work:

| Concern | v1 (5 typed tools) | v2 (2 generic tools) |
|---|---|---|
| LLM picks the right endpoint | Tool name maps directly | LLM has to read the catalog first |
| Body schema enforcement | TypeScript types on the tool input | JSON schema in `vlei-llms.txt` + client-side validation in MCP server |
| State-change safety | Tool name implies the action | `stateChanging: true` flag + `confirm_state_change` guard |
| Adding new endpoint | New MCP tool, new tool registration, new client docs | One new section in `vlei-llms.txt`. Done. |
| Tool surface size | Grows with endpoints | Constant at 2 |

The v2 design is correct for our goal: REST grows freely, MCP stays flat. The work moves into keeping `vlei-llms.txt` accurate. The CI test in Phase 2 enforces that.

---

## §11 — What I haven't verified (Rule 3 flags)

- **`https://massive.com/docs/rest/llms.txt` actual format.** I read the consuming code in `server.py` and `README.md`, not the published file. The §5.2 format is my best inference of what their parser expects. To get byte-level compat, save their llms.txt to filesystem and tell me the path.
- **`mcp_massive/index.py`.** Haven't read. The `EndpointIndex.search(query, top_k, market=...)` and `is_path_allowed(path)` contracts are inferred from `server.py`'s usage.
- **`mcp_massive/functions.py`.** Haven't read. We don't need their function pipeline for vLEI (no analytics step), so this gap doesn't affect Design 1.
- **api-server line numbers in §2.** Approximate; the endpoints exist as listed.

---

## §12 — Decisions asked of you

**A.** Confirm 2-tool design: `vlei_search_endpoints` + `vlei_call_endpoint`. Yes / no / add a third (e.g. a `vlei_status` convenience).

**B.** Confirm `vlei-llms.txt` ships in `legentvLEI/api-server/` and is served at `GET /llms.txt`. Yes / different location.

**C.** Confirm `stateChanging` + `confirm_state_change` guard is enough safety on the LLM side, given the api-server itself validates required fields. Yes / want stricter (e.g. per-endpoint approval list).

**D.** Authorize me to scaffold the actual MCP server code (~200 lines, Python or TypeScript) next turn at `vLEIEnh1\mcp-vlei\`. Pick: Python (matches massive's stack) or TypeScript (matches DynDic3ent1's stack).

**E.** Want me to fetch the real `https://massive.com/docs/rest/llms.txt` when Chrome reconnects, and retro-align our catalog format to it? Yes / our format is fine.

A–C lock the design. D and E are follow-ons.

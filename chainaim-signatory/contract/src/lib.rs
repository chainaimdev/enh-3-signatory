//! chainaim-signatory — mandate contract (ARCHITECTURE-signatory-2026-11-13.md §S-2, D-03).
//!
//! Privacy (v2, change #2 of 2026-11-14): `register_invoice` stores only a commitment
//! `commit = hex(sha256("signatory-commit-v1|<said>|<payee>|<amount_units>|<buyer_agent>|<salt>|<checkout_hash>"))`.
//! Amount, payee, LEIs and due date are not on-chain before payment; LEIs and due date never are.
//!
//! Money flow (D-03): the buyer agent pays with NEP-141
//! `ft_transfer_call(receiver_id = this contract, amount,
//!                   msg = {"invoice":"<said>","payee":"<account>","salt":"<hex>",
//!                          "checkout_hash":"<hex or empty>","receipt_hash":"<hex or empty>"})`.
//! In `ft_on_transfer` the contract recomputes the commitment from the sender, the amount and the
//! revealed fields (mismatch → refused and refunded), stores the revealed amount and payee, then:
//!   * amount within the agent's limit  → forwards it to the payee (`ft_transfer`), status `paid`;
//!   * amount above the agent's limit   → holds it, status `pending` until the approver decides;
//!   * any rule broken                  → returns the full amount (token refunds the agent) and
//!                                        logs `payment_refused` with the reason (no panic, so the
//!                                        reason survives in the tx logs).
//! `approve` forwards a pending payment to the payee, `reject` refunds it to the payer.
//! Every forward/refund is `ft_transfer` (1 yoctoNEAR) + a private callback; on failure the
//! callback restores the previous status (tokens are never silently lost: in the direct-pay path
//! they go back to the agent through the token's `ft_resolve_transfer`, in approve/reject they
//! stay in the contract and the invoice is `pending` again).

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::Serialize;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseOrValue,
};

pub const EVENT_STANDARD: &str = "signatory";
pub const EVENT_VERSION: &str = "2.0.0";
/// Domain prefix of the invoice commitment (bump on any format change; the bridge uses the same).
pub const COMMIT_DOMAIN: &str = "signatory-commit-v1";

/// Gas for the token's `ft_transfer` (standard NEP-141 needs well under this).
pub const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
/// Gas for our own resolve callbacks.
pub const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(15);
/// Maximum number of events returned by one `get_events` call.
pub const MAX_EVENTS_PAGE: u32 = 100;
/// Upper bounds on registrar-supplied strings (storage guard).
const MAX_SAID_LEN: usize = 128;
const MAX_FIELD_LEN: usize = 256;
/// Salt: 32..=128 lowercase hex characters (16..=64 random bytes).
const MIN_SALT_HEX: usize = 32;
const MAX_SALT_HEX: usize = 128;
/// sha256 in lowercase hex.
const HASH_HEX_LEN: usize = 64;

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    Mandates,
    Invoices,
    Events,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Mandate {
    pub company: String,
    pub role: String,
    pub limit_units: U128,
    pub approver: AccountId,
    pub revoked: bool,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvoiceStatus {
    /// Registered by the bridge, not paid yet.
    Registered,
    /// Paid above the agent's limit; tokens held by the contract until approve/reject.
    Pending,
    /// Forwarded to the payee.
    Paid,
    /// Pending payment rejected by the approver and refunded to the payer.
    Rejected,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Invoice {
    /// Commitment to (said, payee, amount, buyer agent, salt, checkout hash); see the module doc.
    pub commit: String,
    /// Revealed at payment; `None` while `registered`.
    pub amount_units: Option<U128>,
    /// Revealed at payment; `None` while `registered`.
    pub payee: Option<AccountId>,
    /// Hash of the off-chain receipt bundle, sent with the payment (`None` if not given).
    pub receipt_hash: Option<String>,
    pub status: InvoiceStatus,
    pub payer: Option<AccountId>,
    /// Block timestamp (ns) when the invoice became `paid`.
    pub paid_at: Option<U64>,
}

/// One stored NEP-297 event (the `events` index).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EventRecord {
    pub event: String,
    pub block_height: U64,
    pub timestamp_ns: U64,
    /// The full NEP-297 JSON exactly as logged (without the `EVENT_JSON:` prefix).
    pub json: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct EventView {
    pub index: u32,
    pub event: String,
    pub block_height: U64,
    pub timestamp_ns: U64,
    pub json: String,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct InvoiceView {
    pub said: String,
    #[serde(flatten)]
    pub invoice: Invoice,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct ConfigView {
    pub owner: AccountId,
    pub registrar: AccountId,
    pub token: AccountId,
    pub events_count: u32,
}

/// Which settlement a callback is resolving (approve → payee, reject → payer).
#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Settlement {
    Approve,
    Reject,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
struct FtTransferArgs<'a> {
    receiver_id: &'a AccountId,
    amount: U128,
    memo: Option<String>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner: AccountId,
    registrar: AccountId,
    token: AccountId,
    mandates: LookupMap<AccountId, Mandate>,
    invoices: LookupMap<String, Invoice>,
    events: Vector<EventRecord>,
}

#[near]
impl Contract {
    #[init]
    pub fn new(owner: AccountId, registrar: AccountId, token: AccountId) -> Self {
        Self {
            owner,
            registrar,
            token,
            mandates: LookupMap::new(StorageKey::Mandates),
            invoices: LookupMap::new(StorageKey::Invoices),
            events: Vector::new(StorageKey::Events),
        }
    }

    // ------------------------------------------------------------------ owner

    /// Creates or replaces an account's mandate (owner only). Replacing clears `revoked`.
    pub fn set_mandate(
        &mut self,
        account: AccountId,
        company: String,
        role: String,
        limit_units: U128,
        approver: AccountId,
    ) {
        require!(
            env::predecessor_account_id() == self.owner,
            "only the owner can set a mandate"
        );
        require!(company.len() <= MAX_FIELD_LEN, "company too long");
        require!(role.len() <= MAX_FIELD_LEN, "role too long");
        self.mandates.insert(
            account,
            Mandate {
                company,
                role,
                limit_units,
                approver,
                revoked: false,
            },
        );
    }

    // -------------------------------------------------------------- registrar

    /// Registers a vLEI-checked invoice (registrar = bridge only).
    /// Only the commitment is stored: no amount, payee, LEI or due date on-chain.
    pub fn register_invoice(&mut self, said: String, commit: String) {
        require!(
            env::predecessor_account_id() == self.registrar,
            "only the registrar can register an invoice"
        );
        require!(!said.is_empty(), "said must not be empty");
        require!(said.len() <= MAX_SAID_LEN, "said too long");
        require!(
            is_lower_hex(&commit, HASH_HEX_LEN, HASH_HEX_LEN),
            "commit must be 64 lowercase hex characters"
        );
        require!(
            !self.invoices.contains_key(&said),
            "invoice already registered"
        );
        let data = json!({ "said": said, "commit": commit });
        self.invoices.insert(
            said,
            Invoice {
                commit,
                amount_units: None,
                payee: None,
                receipt_hash: None,
                status: InvoiceStatus::Registered,
                payer: None,
                paid_at: None,
            },
        );
        self.emit("invoice_registered", data);
    }

    // ------------------------------------------------------------ NEP-141 hook

    /// NEP-141 receiver. Only the configured token may call it. Returns the amount to refund.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.token,
            "only the configured token can call ft_on_transfer"
        );
        let reveal = match parse_reveal_msg(&msg) {
            Some(r) => r,
            None => return self.refuse(None, &sender_id, amount, BAD_MSG_REASON),
        };
        let said = reveal.said.clone();
        let invoice = match self.invoices.get(&said) {
            Some(inv) => inv.clone(),
            None => return self.refuse(Some(&said), &sender_id, amount, "invoice not registered"),
        };
        if invoice.status != InvoiceStatus::Registered {
            let reason = format!("invoice not payable (status {})", status_str(invoice.status));
            return self.refuse(Some(&said), &sender_id, amount, &reason);
        }
        let mandate = match self.mandates.get(&sender_id) {
            Some(m) => m.clone(),
            None => return self.refuse(Some(&said), &sender_id, amount, "sender has no mandate"),
        };
        if mandate.revoked {
            return self.refuse(Some(&said), &sender_id, amount, "mandate revoked");
        }
        let expected = commitment_hex(
            &said,
            &reveal.payee,
            amount,
            &sender_id,
            &reveal.salt,
            &reveal.checkout_hash,
        );
        if expected != invoice.commit {
            return self.refuse(Some(&said), &sender_id, amount, COMMIT_MISMATCH_REASON);
        }
        // Reveal accepted: from here on the amount and payee are known (the transfer shows them anyway).
        {
            let inv = self.invoices.get_mut(&said).unwrap();
            inv.amount_units = Some(amount);
            inv.payee = Some(reveal.payee.clone());
            inv.receipt_hash = reveal.receipt_hash.clone();
        }

        if amount.0 <= mandate.limit_units.0 {
            // Within limit: mark paid now (blocks double payment), forward, confirm in callback.
            let inv = self.invoices.get_mut(&said).unwrap();
            inv.status = InvoiceStatus::Paid;
            inv.payer = Some(sender_id.clone());
            inv.paid_at = Some(U64(env::block_timestamp()));
            let payee = reveal.payee.clone();
            let p = self
                .ft_transfer(&payee, amount, &said)
                .then(
                    Self::ext(env::current_account_id())
                        .with_static_gas(GAS_FOR_CALLBACK)
                        .on_pay_forward(said, sender_id),
                );
            PromiseOrValue::Promise(p)
        } else {
            // Above limit: hold the tokens, wait for the approver.
            let inv = self.invoices.get_mut(&said).unwrap();
            inv.status = InvoiceStatus::Pending;
            inv.payer = Some(sender_id.clone());
            self.emit(
                "payment_pending",
                json!({
                    "said": said,
                    "payer": sender_id,
                    "amount_units": amount,
                    "limit_units": mandate.limit_units,
                    "approver": mandate.approver,
                    "receipt_hash": reveal.receipt_hash,
                }),
            );
            PromiseOrValue::Value(U128(0))
        }
    }

    // ------------------------------------------------------------- approver

    /// Approves a pending payment: forwards it to the payee. Caller = the payer's approver,
    /// whose own mandate must exist, not be revoked, and cover the amount.
    pub fn approve(&mut self, said: String) -> Promise {
        let caller = env::predecessor_account_id();
        let p = self.pending_for_approver(&said, &caller);
        let approver_mandate = self
            .mandates
            .get(&caller)
            .unwrap_or_else(|| env::panic_str("approver has no mandate"));
        require!(!approver_mandate.revoked, "approver mandate revoked");
        require!(
            p.amount.0 <= approver_mandate.limit_units.0,
            format!(
                "amount {} exceeds approver limit {}",
                p.amount.0, approver_mandate.limit_units.0
            )
        );
        let inv = self.invoices.get_mut(&said).unwrap();
        inv.status = InvoiceStatus::Paid;
        inv.paid_at = Some(U64(env::block_timestamp()));
        self.ft_transfer(&p.payee, p.amount, &said).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_CALLBACK)
                .on_settle(said, Settlement::Approve, caller),
        )
    }

    /// Rejects a pending payment: refunds it to the payer. Caller = the payer's approver.
    pub fn reject(&mut self, said: String) -> Promise {
        let caller = env::predecessor_account_id();
        let p = self.pending_for_approver(&said, &caller);
        let inv = self.invoices.get_mut(&said).unwrap();
        inv.status = InvoiceStatus::Rejected;
        self.ft_transfer(&p.payer, p.amount, &said).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_CALLBACK)
                .on_settle(said, Settlement::Reject, caller),
        )
    }

    /// Revokes an account's mandate. Caller = that mandate's approver or the owner.
    pub fn revoke(&mut self, account: AccountId) {
        let caller = env::predecessor_account_id();
        let owner = self.owner.clone();
        let mandate = self
            .mandates
            .get_mut(&account)
            .unwrap_or_else(|| env::panic_str("account has no mandate"));
        require!(
            caller == mandate.approver || caller == owner,
            "only the approver or the owner can revoke"
        );
        require!(!mandate.revoked, "mandate already revoked");
        mandate.revoked = true;
        self.emit("agent_revoked", json!({ "account": account, "by": caller }));
    }

    // ------------------------------------------------------------ callbacks

    /// Resolves the direct (within-limit) forward. Return value = amount the token refunds.
    #[private]
    pub fn on_pay_forward(&mut self, said: String, payer: AccountId) -> U128 {
        let ok = near_sdk::is_promise_success();
        let inv = self
            .invoices
            .get_mut(&said)
            .unwrap_or_else(|| env::panic_str("invoice not found"));
        let amount = inv
            .amount_units
            .unwrap_or_else(|| env::panic_str("invoice amount not revealed"));
        let payee = inv.payee.clone();
        let receipt_hash = inv.receipt_hash.clone();
        if ok {
            self.emit(
                "paid",
                json!({
                    "said": said,
                    "payer": payer,
                    "payee": payee,
                    "amount_units": amount,
                    "via": "within_limit",
                    "receipt_hash": receipt_hash,
                }),
            );
            U128(0)
        } else {
            // Back to `registered`: the reveal is cleared too, so the invoice can be paid again.
            inv.status = InvoiceStatus::Registered;
            inv.payer = None;
            inv.paid_at = None;
            inv.amount_units = None;
            inv.payee = None;
            inv.receipt_hash = None;
            self.emit(
                "payment_refused",
                json!({
                    "said": said,
                    "payer": payer,
                    "amount_units": amount,
                    "reason": "forward to payee failed; amount returned",
                }),
            );
            amount
        }
    }

    /// Resolves approve (forward to payee) / reject (refund to payer). Returns true on success.
    #[private]
    pub fn on_settle(&mut self, said: String, settlement: Settlement, approver: AccountId) -> bool {
        let ok = near_sdk::is_promise_success();
        let inv = self
            .invoices
            .get_mut(&said)
            .unwrap_or_else(|| env::panic_str("invoice not found"));
        let amount = inv.amount_units;
        let payee = inv.payee.clone();
        let payer = inv.payer.clone();
        let receipt_hash = inv.receipt_hash.clone();
        if !ok {
            inv.status = InvoiceStatus::Pending;
            inv.paid_at = None;
            env::log_str(&format!(
                "signatory: {} transfer failed for {}; status restored to pending, tokens kept",
                match settlement {
                    Settlement::Approve => "approve",
                    Settlement::Reject => "reject",
                },
                said
            ));
            return false;
        }
        match settlement {
            Settlement::Approve => {
                self.emit(
                    "payment_approved",
                    json!({ "said": said, "approver": approver, "payer": payer, "amount_units": amount }),
                );
                self.emit(
                    "paid",
                    json!({
                        "said": said,
                        "payer": payer,
                        "payee": payee,
                        "amount_units": amount,
                        "via": "approved",
                        "receipt_hash": receipt_hash,
                    }),
                );
            }
            Settlement::Reject => {
                self.emit(
                    "payment_rejected",
                    json!({
                        "said": said,
                        "approver": approver,
                        "payer": payer,
                        "amount_units": amount,
                        "refunded": true,
                    }),
                );
            }
        }
        true
    }

    // ---------------------------------------------------------------- views

    pub fn get_mandate(&self, account: AccountId) -> Option<Mandate> {
        self.mandates.get(&account).cloned()
    }

    pub fn get_invoice(&self, said: String) -> Option<InvoiceView> {
        self.invoices.get(&said).cloned().map(|invoice| InvoiceView { said, invoice })
    }

    /// Events from `from_index` on, at most `limit` (default and cap `MAX_EVENTS_PAGE`).
    pub fn get_events(&self, from_index: u32, limit: Option<u32>) -> Vec<EventView> {
        let limit = limit.unwrap_or(MAX_EVENTS_PAGE).min(MAX_EVENTS_PAGE);
        let end = from_index.saturating_add(limit).min(self.events.len());
        (from_index..end)
            .filter_map(|i| {
                self.events.get(i).map(|e| EventView {
                    index: i,
                    event: e.event.clone(),
                    block_height: e.block_height,
                    timestamp_ns: e.timestamp_ns,
                    json: e.json.clone(),
                })
            })
            .collect()
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            owner: self.owner.clone(),
            registrar: self.registrar.clone(),
            token: self.token.clone(),
            events_count: self.events.len(),
        }
    }
}

impl Contract {
    fn ft_transfer(&self, receiver_id: &AccountId, amount: U128, said: &str) -> Promise {
        let args = serde_json::to_vec(&FtTransferArgs {
            receiver_id,
            amount,
            memo: Some(format!("signatory:{said}")),
        })
        .unwrap_or_else(|_| env::panic_str("args serialization failed"));
        Promise::new(self.token.clone()).function_call(
            "ft_transfer",
            args,
            NearToken::from_yoctonear(1),
            GAS_FOR_FT_TRANSFER,
        )
    }

    /// Checks `said` is pending and `caller` is its payer's approver. Returns the payer and the
    /// amount and payee revealed with the payment.
    fn pending_for_approver(&self, said: &String, caller: &AccountId) -> PendingPayment {
        let invoice = self
            .invoices
            .get(said)
            .cloned()
            .unwrap_or_else(|| env::panic_str("invoice not registered"));
        require!(
            invoice.status == InvoiceStatus::Pending,
            format!("invoice not pending (status {})", status_str(invoice.status))
        );
        let payer = invoice
            .payer
            .clone()
            .unwrap_or_else(|| env::panic_str("pending invoice has no payer"));
        let agent_mandate = self
            .mandates
            .get(&payer)
            .unwrap_or_else(|| env::panic_str("payer has no mandate"));
        require!(
            *caller == agent_mandate.approver,
            "only the payer's approver can approve or reject"
        );
        let amount = invoice
            .amount_units
            .unwrap_or_else(|| env::panic_str("pending invoice has no revealed amount"));
        let payee = invoice
            .payee
            .clone()
            .unwrap_or_else(|| env::panic_str("pending invoice has no revealed payee"));
        PendingPayment { payer, amount, payee }
    }

    fn refuse(
        &mut self,
        said: Option<&str>,
        sender_id: &AccountId,
        amount: U128,
        reason: &str,
    ) -> PromiseOrValue<U128> {
        self.emit(
            "payment_refused",
            json!({
                "said": said,
                "payer": sender_id,
                "amount_units": amount,
                "reason": reason,
            }),
        );
        PromiseOrValue::Value(amount)
    }

    /// Logs a NEP-297 event and appends it to the `events` index.
    fn emit(&mut self, event: &str, data: Value) {
        let json = format!(
            r#"{{"standard":"{EVENT_STANDARD}","version":"{EVENT_VERSION}","event":"{event}","data":[{}]}}"#,
            data
        );
        env::log_str(&format!("EVENT_JSON:{json}"));
        self.events.push(EventRecord {
            event: event.to_string(),
            block_height: U64(env::block_height()),
            timestamp_ns: U64(env::block_timestamp()),
            json,
        });
    }
}

/// Refusal reason for a payment msg that does not parse.
pub const BAD_MSG_REASON: &str =
    "msg must be {\"invoice\",\"payee\",\"salt\"[,\"checkout_hash\",\"receipt_hash\"]}";
/// Refusal reason when the revealed fields, sender or amount do not match the commitment.
pub const COMMIT_MISMATCH_REASON: &str =
    "commitment mismatch (payee, amount, payer, salt or checkout hash differ from the registered invoice)";

/// Amount and payee revealed with a pending payment, plus its payer.
struct PendingPayment {
    payer: AccountId,
    amount: U128,
    payee: AccountId,
}

/// Fields revealed in the payment msg.
struct Reveal {
    said: String,
    payee: AccountId,
    salt: String,
    /// Lowercase hex sha256, or empty when there is no checkout yet.
    checkout_hash: String,
    receipt_hash: Option<String>,
}

fn parse_reveal_msg(msg: &str) -> Option<Reveal> {
    let v: Value = serde_json::from_str(msg).ok()?;
    let said = v.get("invoice")?.as_str()?;
    if said.is_empty() || said.len() > MAX_SAID_LEN {
        return None;
    }
    let payee: AccountId = v.get("payee")?.as_str()?.parse().ok()?;
    let salt = v.get("salt")?.as_str()?;
    if !is_lower_hex(salt, MIN_SALT_HEX, MAX_SALT_HEX) {
        return None;
    }
    let checkout_hash = match v.get("checkout_hash") {
        None | Some(Value::Null) => String::new(),
        Some(x) => {
            let s = x.as_str()?;
            if !s.is_empty() && !is_lower_hex(s, HASH_HEX_LEN, HASH_HEX_LEN) {
                return None;
            }
            s.to_string()
        }
    };
    let receipt_hash = match v.get("receipt_hash") {
        None | Some(Value::Null) => None,
        Some(x) => {
            let s = x.as_str()?;
            if s.is_empty() {
                None
            } else if is_lower_hex(s, HASH_HEX_LEN, HASH_HEX_LEN) {
                Some(s.to_string())
            } else {
                return None;
            }
        }
    };
    Some(Reveal {
        said: said.to_string(),
        payee,
        salt: salt.to_string(),
        checkout_hash,
        receipt_hash,
    })
}

/// The invoice commitment (same string and hash as the bridge computes):
/// hex(sha256("signatory-commit-v1|<said>|<payee>|<amount_units>|<buyer_agent>|<salt>|<checkout_hash>")).
pub fn commitment_hex(
    said: &str,
    payee: &AccountId,
    amount_units: U128,
    buyer_agent: &AccountId,
    salt: &str,
    checkout_hash: &str,
) -> String {
    let preimage = format!(
        "{COMMIT_DOMAIN}|{said}|{payee}|{}|{buyer_agent}|{salt}|{checkout_hash}",
        amount_units.0
    );
    to_hex(&env::sha256(preimage.as_bytes()))
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0x0f) as usize] as char);
    }
    s
}

fn is_lower_hex(s: &str, min_len: usize, max_len: usize) -> bool {
    s.len() >= min_len
        && s.len() <= max_len
        && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn status_str(s: InvoiceStatus) -> &'static str {
    match s {
        InvoiceStatus::Registered => "registered",
        InvoiceStatus::Pending => "pending",
        InvoiceStatus::Paid => "paid",
        InvoiceStatus::Rejected => "rejected",
    }
}

#[cfg(test)]
mod tests;

//! chainaim-signatory — mandate contract (ARCHITECTURE-signatory-2026-11-13.md §S-2, D-03).
//!
//! Money flow (D-03): the buyer agent pays with NEP-141
//! `ft_transfer_call(receiver_id = this contract, amount, msg = {"invoice":"<said>"})`.
//! In `ft_on_transfer` the contract:
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
pub const EVENT_VERSION: &str = "1.0.0";

/// Gas for the token's `ft_transfer` (standard NEP-141 needs well under this).
pub const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(15);
/// Gas for our own resolve callbacks.
pub const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(15);
/// Maximum number of events returned by one `get_events` call.
pub const MAX_EVENTS_PAGE: u32 = 100;
/// Upper bounds on registrar-supplied strings (storage guard).
const MAX_SAID_LEN: usize = 128;
const MAX_FIELD_LEN: usize = 256;

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
    pub amount_units: U128,
    pub payee: AccountId,
    pub seller_lei: String,
    pub buyer_lei: String,
    pub due: String,
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
    pub fn register_invoice(
        &mut self,
        said: String,
        amount_units: U128,
        payee: AccountId,
        seller_lei: String,
        buyer_lei: String,
        due: String,
    ) {
        require!(
            env::predecessor_account_id() == self.registrar,
            "only the registrar can register an invoice"
        );
        require!(!said.is_empty(), "said must not be empty");
        require!(said.len() <= MAX_SAID_LEN, "said too long");
        require!(
            seller_lei.len() <= MAX_FIELD_LEN
                && buyer_lei.len() <= MAX_FIELD_LEN
                && due.len() <= MAX_FIELD_LEN,
            "field too long"
        );
        require!(amount_units.0 > 0, "amount must be greater than 0");
        require!(
            !self.invoices.contains_key(&said),
            "invoice already registered"
        );
        let data = json!({
            "said": said,
            "amount_units": amount_units,
            "payee": payee,
            "seller_lei": seller_lei,
            "buyer_lei": buyer_lei,
            "due": due,
        });
        self.invoices.insert(
            said,
            Invoice {
                amount_units,
                payee,
                seller_lei,
                buyer_lei,
                due,
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
        let said = match parse_invoice_msg(&msg) {
            Some(s) => s,
            None => {
                return self.refuse(None, &sender_id, amount, "msg must be {\"invoice\":\"<said>\"}")
            }
        };
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
        if amount.0 != invoice.amount_units.0 {
            let reason = format!(
                "amount {} does not equal invoice amount {}",
                amount.0, invoice.amount_units.0
            );
            return self.refuse(Some(&said), &sender_id, amount, &reason);
        }

        if amount.0 <= mandate.limit_units.0 {
            // Within limit: mark paid now (blocks double payment), forward, confirm in callback.
            let inv = self.invoices.get_mut(&said).unwrap();
            inv.status = InvoiceStatus::Paid;
            inv.payer = Some(sender_id.clone());
            inv.paid_at = Some(U64(env::block_timestamp()));
            let payee = inv.payee.clone();
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
        let (invoice, _payer) = self.pending_for_approver(&said, &caller);
        let approver_mandate = self
            .mandates
            .get(&caller)
            .unwrap_or_else(|| env::panic_str("approver has no mandate"));
        require!(!approver_mandate.revoked, "approver mandate revoked");
        require!(
            invoice.amount_units.0 <= approver_mandate.limit_units.0,
            format!(
                "amount {} exceeds approver limit {}",
                invoice.amount_units.0, approver_mandate.limit_units.0
            )
        );
        let inv = self.invoices.get_mut(&said).unwrap();
        inv.status = InvoiceStatus::Paid;
        inv.paid_at = Some(U64(env::block_timestamp()));
        let payee = inv.payee.clone();
        self.ft_transfer(&payee, invoice.amount_units, &said).then(
            Self::ext(env::current_account_id())
                .with_static_gas(GAS_FOR_CALLBACK)
                .on_settle(said, Settlement::Approve, caller),
        )
    }

    /// Rejects a pending payment: refunds it to the payer. Caller = the payer's approver.
    pub fn reject(&mut self, said: String) -> Promise {
        let caller = env::predecessor_account_id();
        let (invoice, payer) = self.pending_for_approver(&said, &caller);
        let inv = self.invoices.get_mut(&said).unwrap();
        inv.status = InvoiceStatus::Rejected;
        self.ft_transfer(&payer, invoice.amount_units, &said).then(
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
        let amount = inv.amount_units;
        let payee = inv.payee.clone();
        if ok {
            self.emit(
                "paid",
                json!({
                    "said": said,
                    "payer": payer,
                    "payee": payee,
                    "amount_units": amount,
                    "via": "within_limit",
                }),
            );
            U128(0)
        } else {
            inv.status = InvoiceStatus::Registered;
            inv.payer = None;
            inv.paid_at = None;
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

    /// Checks `said` is pending and `caller` is its payer's approver. Returns (invoice, payer).
    fn pending_for_approver(&self, said: &String, caller: &AccountId) -> (Invoice, AccountId) {
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
        (invoice, payer)
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

fn parse_invoice_msg(msg: &str) -> Option<String> {
    let v: Value = serde_json::from_str(msg).ok()?;
    let said = v.get("invoice")?.as_str()?;
    if said.is_empty() || said.len() > MAX_SAID_LEN {
        return None;
    }
    Some(said.to_string())
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

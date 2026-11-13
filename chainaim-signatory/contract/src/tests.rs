//! Unit tests: every rule of §S-2 plus callback failure (state rolled back).
//! Amounts and SAIDs are the real invoices (6 decimals): INV-2026-0003 0.084 → 84000 units,
//! INV-2026-0004 0.1575 → 157500 units. Accounts follow §S-1 (no keys involved).

use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{get_created_receipts, get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};

const CONTRACT: &str = "chainaim-signatory.testnet";
const OWNER: &str = "chainaim-signatory.testnet";
const BRIDGE: &str = "chainaim-bridge.testnet";
const TOKEN: &str = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const AGENT: &str = "chainaim-tommy-buyer-agent.testnet";
const CPO: &str = "chainaim-tommy-cpo.testnet";
const PAYEE: &str = "chainaim-jupiter-payee.testnet";
const STRANGER: &str = "stranger.testnet";

const INV3: &str = "EBQy-FlPtaa6_kh-BZI5Cn-ndtJ2It5Q3JNDMH3oYY1z";
const INV3_UNITS: u128 = 84_000;
const INV4: &str = "EHusycc5UI7q2qRnfHhY-5fc0M9xkxB0nixx9Vs7m1qr";
const INV4_UNITS: u128 = 157_500;
const AGENT_LIMIT: u128 = 100_000;
const CPO_LIMIT: u128 = 250_000;
/// Test salt (16 bytes hex). Real salts are random per invoice (bridge).
const SALT: &str = "00112233445566778899aabbccddeeff";
/// sha256 of "signatory-commit-v1|<INV3>|<PAYEE>|84000|<AGENT>|<SALT>|", computed independently
/// with Node's crypto module, so the Rust and the bridge (JavaScript) commitments must agree.
const INV3_COMMIT_VECTOR: &str = "4873ca7444354cddb4809c6e5782c8db7447c22390a8b264955d1e009bc75634";

/// Commitment the bridge would register for (said, PAYEE, units, AGENT, SALT, no checkout).
fn commit(said: &str, units: u128) -> String {
    commitment_hex(said, &acc(PAYEE), U128(units), &acc(AGENT), SALT, "")
}

/// Registers `said` as the bridge would (caller = registrar).
fn register(c: &mut Contract, said: &str, units: u128) {
    set_caller(BRIDGE);
    c.register_invoice(said.into(), commit(said, units));
}

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

fn set_caller(predecessor: &str) {
    let ctx = VMContextBuilder::new()
        .current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(predecessor))
        .signer_account_id(acc(predecessor))
        .block_height(42)
        .block_timestamp(1_763_020_800_000_000_000)
        .build();
    testing_env!(ctx);
}

/// Environment of a callback: predecessor = the contract itself, one promise result.
fn set_callback(result: PromiseResult) {
    let ctx = VMContextBuilder::new()
        .current_account_id(acc(CONTRACT))
        .predecessor_account_id(acc(CONTRACT))
        .signer_account_id(acc(AGENT))
        .block_height(43)
        .block_timestamp(1_763_020_801_000_000_000)
        .build();
    testing_env!(
        ctx,
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

fn setup() -> Contract {
    set_caller(OWNER);
    let mut c = Contract::new(acc(OWNER), acc(BRIDGE), acc(TOKEN));
    c.set_mandate(
        acc(AGENT),
        "Tommy (buyer)".into(),
        "buyer_agent".into(),
        U128(AGENT_LIMIT),
        acc(CPO),
    );
    c.set_mandate(
        acc(CPO),
        "Tommy (buyer)".into(),
        "cpo".into(),
        U128(CPO_LIMIT),
        acc(OWNER),
    );
    register(&mut c, INV3, INV3_UNITS);
    register(&mut c, INV4, INV4_UNITS);
    c
}

/// The payment msg the signer sends: the reveal for (PAYEE, SALT, no checkout).
fn msg(said: &str) -> String {
    format!(r#"{{"invoice":"{said}","payee":"{PAYEE}","salt":"{SALT}"}}"#)
}

fn pay(c: &mut Contract, sender: &str, said: &str, amount: u128) -> PromiseOrValue<U128> {
    set_caller(TOKEN);
    c.ft_on_transfer(acc(sender), U128(amount), msg(said))
}

fn status(c: &Contract, said: &str) -> InvoiceStatus {
    c.get_invoice(said.into()).unwrap().invoice.status
}

/// Returns the refund value of an `ft_on_transfer` that did not create a promise.
fn refund_value(r: PromiseOrValue<U128>) -> u128 {
    match r {
        PromiseOrValue::Value(v) => v.0,
        PromiseOrValue::Promise(_) => panic!("expected a value, got a promise"),
    }
}

/// NEP-297 events logged in the current environment, parsed.
fn logged_events() -> Vec<Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str(j).unwrap())
        .collect()
}

fn last_event() -> Value {
    logged_events().pop().expect("no event logged")
}

/// (token receiver, method, args, deposit yocto) of every function call the contract scheduled.
fn function_calls() -> Vec<(AccountId, String, Value, u128)> {
    let mut out = vec![];
    for r in get_created_receipts() {
        for a in r.actions {
            if let MockAction::FunctionCallWeight {
                method_name,
                args,
                attached_deposit,
                ..
            } = a
            {
                let args: Value = serde_json::from_slice(&args).unwrap_or(Value::Null);
                out.push((
                    r.receiver_id.clone(),
                    String::from_utf8(method_name).unwrap(),
                    args,
                    attached_deposit.as_yoctonear(),
                ));
            }
        }
    }
    out
}

fn assert_ft_transfer_scheduled(receiver: &str, amount: u128) {
    let calls = function_calls();
    let ft = calls
        .iter()
        .find(|(_, m, _, _)| m == "ft_transfer")
        .expect("no ft_transfer scheduled");
    assert_eq!(ft.0, acc(TOKEN), "ft_transfer must go to the token");
    assert_eq!(ft.2["receiver_id"], receiver);
    assert_eq!(ft.2["amount"], amount.to_string());
    assert_eq!(ft.3, 1, "ft_transfer needs exactly 1 yoctoNEAR");
    assert!(
        calls.iter().any(|(r, _, _, _)| *r == acc(CONTRACT)),
        "a callback on the contract must be scheduled"
    );
}

// ----------------------------------------------------------------- init / admin

#[test]
fn new_stores_config() {
    let c = setup();
    let cfg = c.get_config();
    assert_eq!(cfg.owner, acc(OWNER));
    assert_eq!(cfg.registrar, acc(BRIDGE));
    assert_eq!(cfg.token, acc(TOKEN));
    assert_eq!(cfg.events_count, 2); // two invoice_registered
}

#[test]
fn set_mandate_stores_penny_test_limits() {
    let c = setup();
    let m = c.get_mandate(acc(AGENT)).unwrap();
    assert_eq!(m.limit_units, U128(AGENT_LIMIT));
    assert_eq!(m.approver, acc(CPO));
    assert!(!m.revoked);
    assert_eq!(c.get_mandate(acc(CPO)).unwrap().limit_units, U128(CPO_LIMIT));
    assert_eq!(c.get_mandate(acc(STRANGER)), None);
}

#[test]
#[should_panic(expected = "only the owner can set a mandate")]
fn set_mandate_only_owner() {
    let mut c = setup();
    set_caller(CPO);
    c.set_mandate(acc(AGENT), "x".into(), "y".into(), U128(1), acc(CPO));
}

#[test]
fn set_mandate_again_clears_revoked() {
    let mut c = setup();
    set_caller(CPO);
    c.revoke(acc(AGENT));
    set_caller(OWNER);
    c.set_mandate(acc(AGENT), "Tommy (buyer)".into(), "buyer_agent".into(), U128(AGENT_LIMIT), acc(CPO));
    assert!(!c.get_mandate(acc(AGENT)).unwrap().revoked);
}

// ------------------------------------------------------------------ register

#[test]
fn register_invoice_stores_only_the_commitment_and_emits() {
    let mut c = setup();
    let k = commit("ENEW", 5);
    set_caller(BRIDGE);
    c.register_invoice("ENEW".into(), k.clone());
    let v = c.get_invoice("ENEW".into()).unwrap();
    assert_eq!(v.said, "ENEW");
    assert_eq!(v.invoice.status, InvoiceStatus::Registered);
    assert_eq!(v.invoice.commit, k);
    assert_eq!(v.invoice.amount_units, None, "amount not on-chain before payment");
    assert_eq!(v.invoice.payee, None, "payee not on-chain before payment");
    assert_eq!(v.invoice.payer, None);
    let e = last_event();
    assert_eq!(e["standard"], "signatory");
    assert_eq!(e["version"], "2.0.0");
    assert_eq!(e["event"], "invoice_registered");
    assert_eq!(e["data"][0]["said"], "ENEW");
    assert_eq!(e["data"][0]["commit"], k.as_str());
    let keys: Vec<_> = e["data"][0].as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys.len(), 2, "event carries only said + commit, got {keys:?}");
}

#[test]
fn commitment_matches_the_javascript_vector() {
    assert_eq!(commit(INV3, INV3_UNITS), INV3_COMMIT_VECTOR);
}

#[test]
#[should_panic(expected = "only the registrar can register an invoice")]
fn register_only_registrar() {
    let mut c = setup();
    set_caller(OWNER);
    c.register_invoice("EX".into(), commit("EX", 1));
}

#[test]
#[should_panic(expected = "invoice already registered")]
fn register_said_unique() {
    let mut c = setup();
    set_caller(BRIDGE);
    c.register_invoice(INV3.into(), commit(INV3, 1));
}

#[test]
fn register_commit_must_be_64_lowercase_hex() {
    for bad in ["", "abc", &"A".repeat(64), &"g".repeat(64), &"0".repeat(63), &"0".repeat(65)] {
        let r = std::panic::catch_unwind(|| {
            let mut c = setup();
            set_caller(BRIDGE);
            c.register_invoice("EBAD".into(), bad.to_string());
        });
        assert!(r.is_err(), "commit {bad:?} must be refused");
    }
}

#[test]
#[should_panic(expected = "said must not be empty")]
fn register_said_non_empty() {
    let mut c = setup();
    set_caller(BRIDGE);
    c.register_invoice("".into(), commit("", 1));
}

// ------------------------------------------------- scene 1: within limit → paid

#[test]
fn scene1_within_limit_forwards_to_payee() {
    let mut c = setup();
    let r = pay(&mut c, AGENT, INV3, INV3_UNITS);
    assert!(matches!(r, PromiseOrValue::Promise(_)));
    drop(r); // schedules the promise in the mocked blockchain
    assert_ft_transfer_scheduled(PAYEE, INV3_UNITS);
    let inv = c.get_invoice(INV3.into()).unwrap().invoice;
    assert_eq!(inv.status, InvoiceStatus::Paid);
    assert_eq!(inv.payer, Some(acc(AGENT)));
    assert!(inv.paid_at.is_some());

    set_callback(PromiseResult::Successful(vec![]));
    let refund = c.on_pay_forward(INV3.into(), acc(AGENT));
    assert_eq!(refund, U128(0));
    assert_eq!(status(&c, INV3), InvoiceStatus::Paid);
    let e = last_event();
    assert_eq!(e["event"], "paid");
    assert_eq!(e["data"][0]["said"], INV3);
    assert_eq!(e["data"][0]["payee"], PAYEE);
    assert_eq!(e["data"][0]["amount_units"], "84000");
    assert_eq!(e["data"][0]["via"], "within_limit");
}

#[test]
fn scene1_forward_failure_rolls_back_and_refunds() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV3, INV3_UNITS));
    set_callback(PromiseResult::Failed);
    let refund = c.on_pay_forward(INV3.into(), acc(AGENT));
    assert_eq!(refund, U128(INV3_UNITS), "full amount goes back to the agent");
    let inv = c.get_invoice(INV3.into()).unwrap().invoice;
    assert_eq!(inv.status, InvoiceStatus::Registered);
    assert_eq!(inv.payer, None);
    assert_eq!(inv.paid_at, None);
    assert_eq!(inv.amount_units, None, "reveal cleared on rollback");
    assert_eq!(inv.payee, None, "reveal cleared on rollback");
    let e = last_event();
    assert_eq!(e["event"], "payment_refused");
    assert_eq!(e["data"][0]["reason"], "forward to payee failed; amount returned");
    // the invoice can be paid again after the rollback
    assert!(matches!(pay(&mut c, AGENT, INV3, INV3_UNITS), PromiseOrValue::Promise(_)));
}

#[test]
fn amount_equal_to_limit_is_within_limit() {
    let mut c = setup();
    register(&mut c, "ELIMIT", AGENT_LIMIT);
    assert!(matches!(pay(&mut c, AGENT, "ELIMIT", AGENT_LIMIT), PromiseOrValue::Promise(_)));
    assert_eq!(status(&c, "ELIMIT"), InvoiceStatus::Paid);
}

// ------------------------------------------ scene 2: above limit → pending

#[test]
fn scene2_above_limit_is_held_pending() {
    let mut c = setup();
    let r = pay(&mut c, AGENT, INV4, INV4_UNITS);
    assert_eq!(refund_value(r), 0, "tokens are kept by the contract");
    assert!(function_calls().is_empty(), "nothing forwarded yet");
    let inv = c.get_invoice(INV4.into()).unwrap().invoice;
    assert_eq!(inv.status, InvoiceStatus::Pending);
    assert_eq!(inv.payer, Some(acc(AGENT)));
    assert_eq!(inv.paid_at, None);
    let e = last_event();
    assert_eq!(e["event"], "payment_pending");
    assert_eq!(e["data"][0]["amount_units"], "157500");
    assert_eq!(e["data"][0]["limit_units"], "100000");
    assert_eq!(e["data"][0]["approver"], CPO);
}

#[test]
fn scene2_cpo_approves_then_paid() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    set_caller(CPO);
    drop(c.approve(INV4.into()));
    assert_ft_transfer_scheduled(PAYEE, INV4_UNITS);
    assert_eq!(status(&c, INV4), InvoiceStatus::Paid);

    set_callback(PromiseResult::Successful(vec![]));
    assert!(c.on_settle(INV4.into(), Settlement::Approve, acc(CPO)));
    let ev = logged_events();
    let names: Vec<_> = ev.iter().map(|e| e["event"].as_str().unwrap().to_string()).collect();
    assert_eq!(names, vec!["payment_approved", "paid"]);
    assert_eq!(ev[0]["data"][0]["approver"], CPO);
    assert_eq!(ev[1]["data"][0]["via"], "approved");
    assert_eq!(status(&c, INV4), InvoiceStatus::Paid);
}

#[test]
fn scene2_approve_transfer_failure_restores_pending() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    set_caller(CPO);
    drop(c.approve(INV4.into()));
    set_callback(PromiseResult::Failed);
    assert!(!c.on_settle(INV4.into(), Settlement::Approve, acc(CPO)));
    let inv = c.get_invoice(INV4.into()).unwrap().invoice;
    assert_eq!(inv.status, InvoiceStatus::Pending);
    assert_eq!(inv.paid_at, None);
    assert_eq!(inv.payer, Some(acc(AGENT)), "payer kept so the refund/approve can be retried");
    assert!(logged_events().is_empty(), "no paid/approved event on failure");
    // retry works
    set_caller(CPO);
    drop(c.approve(INV4.into()));
    assert_eq!(status(&c, INV4), InvoiceStatus::Paid);
}

#[test]
fn scene2_cpo_rejects_then_refunded() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    set_caller(CPO);
    drop(c.reject(INV4.into()));
    assert_ft_transfer_scheduled(AGENT, INV4_UNITS);
    assert_eq!(status(&c, INV4), InvoiceStatus::Rejected);
    set_callback(PromiseResult::Successful(vec![]));
    assert!(c.on_settle(INV4.into(), Settlement::Reject, acc(CPO)));
    let e = last_event();
    assert_eq!(e["event"], "payment_rejected");
    assert_eq!(e["data"][0]["payer"], AGENT);
    assert_eq!(e["data"][0]["refunded"], true);
}

#[test]
fn scene2_reject_transfer_failure_restores_pending() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    set_caller(CPO);
    drop(c.reject(INV4.into()));
    set_callback(PromiseResult::Failed);
    assert!(!c.on_settle(INV4.into(), Settlement::Reject, acc(CPO)));
    assert_eq!(status(&c, INV4), InvoiceStatus::Pending);
}

#[test]
#[should_panic(expected = "only the payer's approver can approve or reject")]
fn approve_only_by_payers_approver() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    set_caller(OWNER);
    drop(c.approve(INV4.into()));
}

#[test]
#[should_panic(expected = "only the payer's approver can approve or reject")]
fn agent_cannot_approve_itself() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    set_caller(AGENT);
    drop(c.approve(INV4.into()));
}

#[test]
#[should_panic(expected = "only the payer's approver can approve or reject")]
fn reject_only_by_payers_approver() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    set_caller(STRANGER);
    drop(c.reject(INV4.into()));
}

#[test]
#[should_panic(expected = "amount 157500 exceeds approver limit 150000")]
fn approve_refused_above_approver_limit() {
    let mut c = setup();
    set_caller(OWNER);
    c.set_mandate(acc(CPO), "Tommy (buyer)".into(), "cpo".into(), U128(150_000), acc(OWNER));
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    set_caller(CPO);
    drop(c.approve(INV4.into()));
}

#[test]
#[should_panic(expected = "approver mandate revoked")]
fn approve_refused_when_approver_revoked() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    set_caller(OWNER);
    c.revoke(acc(CPO));
    set_caller(CPO);
    drop(c.approve(INV4.into()));
}

#[test]
#[should_panic(expected = "approver has no mandate")]
fn approve_refused_when_approver_has_no_mandate() {
    let mut c = setup();
    set_caller(OWNER);
    c.set_mandate(acc(AGENT), "Tommy (buyer)".into(), "buyer_agent".into(), U128(AGENT_LIMIT), acc(STRANGER));
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    set_caller(STRANGER);
    drop(c.approve(INV4.into()));
}

#[test]
#[should_panic(expected = "invoice not pending (status registered)")]
fn approve_refused_when_not_pending() {
    let mut c = setup();
    set_caller(CPO);
    drop(c.approve(INV4.into()));
}

#[test]
#[should_panic(expected = "invoice not pending (status paid)")]
fn double_approve_refused() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    set_caller(CPO);
    drop(c.approve(INV4.into()));
    set_caller(CPO);
    drop(c.approve(INV4.into()));
}

#[test]
#[should_panic(expected = "invoice not registered")]
fn approve_unknown_invoice() {
    let mut c = setup();
    set_caller(CPO);
    drop(c.approve("EUNKNOWN".into()));
}

// ------------------------------------------------ scene 4: revoke → refused

#[test]
fn scene4_revoked_agent_payment_refused_and_returned() {
    let mut c = setup();
    set_caller(CPO);
    c.revoke(acc(AGENT));
    let e = last_event();
    assert_eq!(e["event"], "agent_revoked");
    assert_eq!(e["data"][0]["account"], AGENT);
    assert_eq!(e["data"][0]["by"], CPO);
    assert!(c.get_mandate(acc(AGENT)).unwrap().revoked);

    let r = pay(&mut c, AGENT, INV3, INV3_UNITS);
    assert_eq!(refund_value(r), INV3_UNITS, "full amount returned, not a panic");
    assert!(function_calls().is_empty());
    assert_eq!(status(&c, INV3), InvoiceStatus::Registered);
    let e = last_event();
    assert_eq!(e["event"], "payment_refused");
    assert_eq!(e["data"][0]["reason"], "mandate revoked");
    assert_eq!(e["data"][0]["said"], INV3);
    assert_eq!(e["data"][0]["payer"], AGENT);
    assert_eq!(e["data"][0]["amount_units"], "84000");
}

#[test]
fn owner_can_revoke() {
    let mut c = setup();
    set_caller(OWNER);
    c.revoke(acc(AGENT));
    assert!(c.get_mandate(acc(AGENT)).unwrap().revoked);
}

#[test]
#[should_panic(expected = "only the approver or the owner can revoke")]
fn stranger_cannot_revoke() {
    let mut c = setup();
    set_caller(STRANGER);
    c.revoke(acc(AGENT));
}

#[test]
#[should_panic(expected = "only the approver or the owner can revoke")]
fn agent_cannot_revoke_itself() {
    let mut c = setup();
    set_caller(AGENT);
    c.revoke(acc(AGENT));
}

#[test]
#[should_panic(expected = "mandate already revoked")]
fn revoke_twice_refused() {
    let mut c = setup();
    set_caller(CPO);
    c.revoke(acc(AGENT));
    set_caller(CPO);
    c.revoke(acc(AGENT));
}

#[test]
#[should_panic(expected = "account has no mandate")]
fn revoke_unknown_account() {
    let mut c = setup();
    set_caller(OWNER);
    c.revoke(acc(STRANGER));
}

// ---------------------------------------------- other refusals (returned)

fn assert_refused(r: PromiseOrValue<U128>, amount: u128, reason: &str) {
    assert_eq!(refund_value(r), amount, "refusal returns the full amount");
    assert!(function_calls().is_empty(), "refusal schedules nothing");
    let e = last_event();
    assert_eq!(e["event"], "payment_refused");
    assert_eq!(e["data"][0]["reason"], reason);
}

#[test]
fn refused_unknown_invoice() {
    let mut c = setup();
    let r = pay(&mut c, AGENT, "EUNKNOWN", 10);
    assert_refused(r, 10, "invoice not registered");
}

#[test]
fn refused_sender_without_mandate() {
    let mut c = setup();
    let r = pay(&mut c, STRANGER, INV3, INV3_UNITS);
    assert_refused(r, INV3_UNITS, "sender has no mandate");
    assert_eq!(status(&c, INV3), InvoiceStatus::Registered);
}

#[test]
fn refused_amount_mismatch() {
    let mut c = setup();
    let r = pay(&mut c, AGENT, INV3, INV3_UNITS - 1);
    assert_refused(r, INV3_UNITS - 1, COMMIT_MISMATCH_REASON);
    let r = pay(&mut c, AGENT, INV3, INV3_UNITS + 1);
    assert_refused(r, INV3_UNITS + 1, COMMIT_MISMATCH_REASON);
    assert_eq!(status(&c, INV3), InvoiceStatus::Registered);
    assert_eq!(c.get_invoice(INV3.into()).unwrap().invoice.amount_units, None);
}

fn pay_with(c: &mut Contract, sender: &str, amount: u128, m: String) -> PromiseOrValue<U128> {
    set_caller(TOKEN);
    c.ft_on_transfer(acc(sender), U128(amount), m)
}

#[test]
fn refused_wrong_payee_in_reveal() {
    let mut c = setup();
    let m = format!(r#"{{"invoice":"{INV3}","payee":"{STRANGER}","salt":"{SALT}"}}"#);
    assert_refused(pay_with(&mut c, AGENT, INV3_UNITS, m), INV3_UNITS, COMMIT_MISMATCH_REASON);
    assert_eq!(status(&c, INV3), InvoiceStatus::Registered);
}

#[test]
fn refused_wrong_salt_in_reveal() {
    let mut c = setup();
    let m = format!(r#"{{"invoice":"{INV3}","payee":"{PAYEE}","salt":"{}"}}"#, "ff".repeat(16));
    assert_refused(pay_with(&mut c, AGENT, INV3_UNITS, m), INV3_UNITS, COMMIT_MISMATCH_REASON);
}

#[test]
fn refused_other_agent_with_a_mandate() {
    // The commitment names the buyer agent: another account with a valid mandate cannot pay it.
    let mut c = setup();
    set_caller(OWNER);
    c.set_mandate(acc(STRANGER), "Tommy (buyer)".into(), "buyer_agent".into(), U128(AGENT_LIMIT), acc(CPO));
    let r = pay(&mut c, STRANGER, INV3, INV3_UNITS);
    assert_refused(r, INV3_UNITS, COMMIT_MISMATCH_REASON);
    assert_eq!(status(&c, INV3), InvoiceStatus::Registered);
}

#[test]
fn checkout_hash_is_bound_by_the_commitment() {
    let mut c = setup();
    let ch = "ab".repeat(32);
    let k = commitment_hex("ECHK", &acc(PAYEE), U128(5), &acc(AGENT), SALT, &ch);
    set_caller(BRIDGE);
    c.register_invoice("ECHK".into(), k);
    // without the checkout hash: refused
    let m = format!(r#"{{"invoice":"ECHK","payee":"{PAYEE}","salt":"{SALT}"}}"#);
    assert_refused(pay_with(&mut c, AGENT, 5, m), 5, COMMIT_MISMATCH_REASON);
    // with it, plus a receipt hash: accepted and the receipt hash is stored
    let rh = "cd".repeat(32);
    let m = format!(
        r#"{{"invoice":"ECHK","payee":"{PAYEE}","salt":"{SALT}","checkout_hash":"{ch}","receipt_hash":"{rh}"}}"#
    );
    assert!(matches!(pay_with(&mut c, AGENT, 5, m), PromiseOrValue::Promise(_)));
    let inv = c.get_invoice("ECHK".into()).unwrap().invoice;
    assert_eq!(inv.status, InvoiceStatus::Paid);
    assert_eq!(inv.receipt_hash, Some(rh));
    assert_eq!(inv.amount_units, Some(U128(5)));
    assert_eq!(inv.payee, Some(acc(PAYEE)));
}

#[test]
fn refused_already_paid() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV3, INV3_UNITS));
    let r = pay(&mut c, AGENT, INV3, INV3_UNITS);
    assert_refused(r, INV3_UNITS, "invoice not payable (status paid)");
}

#[test]
fn refused_already_pending() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    let r = pay(&mut c, AGENT, INV4, INV4_UNITS);
    assert_refused(r, INV4_UNITS, "invoice not payable (status pending)");
}

#[test]
fn refused_rejected_invoice() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    set_caller(CPO);
    drop(c.reject(INV4.into()));
    let r = pay(&mut c, AGENT, INV4, INV4_UNITS);
    assert_refused(r, INV4_UNITS, "invoice not payable (status rejected)");
}

#[test]
fn refused_bad_msg() {
    let mut c = setup();
    let bad = [
        "".to_string(),
        "not json".to_string(),
        r#"{"inv":"x"}"#.to_string(),
        r#"{"invoice":7}"#.to_string(),
        r#"{"invoice":""}"#.to_string(),
        // v1 msg (no reveal) is refused, not paid
        format!(r#"{{"invoice":"{INV3}"}}"#),
        format!(r#"{{"invoice":"{INV3}","payee":"{PAYEE}"}}"#),
        format!(r#"{{"invoice":"{INV3}","payee":"NOT VALID","salt":"{SALT}"}}"#),
        format!(r#"{{"invoice":"{INV3}","payee":"{PAYEE}","salt":"short"}}"#),
        format!(r#"{{"invoice":"{INV3}","payee":"{PAYEE}","salt":"{}"}}"#, SALT.to_uppercase()),
        format!(r#"{{"invoice":"{INV3}","payee":"{PAYEE}","salt":"{SALT}","checkout_hash":"xyz"}}"#),
        format!(r#"{{"invoice":"{INV3}","payee":"{PAYEE}","salt":"{SALT}","receipt_hash":"12"}}"#),
    ];
    for m in bad {
        set_caller(TOKEN);
        let r = c.ft_on_transfer(acc(AGENT), U128(5), m.clone());
        assert_refused(r, 5, BAD_MSG_REASON);
        assert_eq!(last_event()["data"][0]["said"], Value::Null, "msg {m}");
    }
    assert_eq!(status(&c, INV3), InvoiceStatus::Registered);
}

#[test]
#[should_panic(expected = "only the configured token can call ft_on_transfer")]
fn ft_on_transfer_only_from_token() {
    let mut c = setup();
    set_caller("fake-usdc.testnet");
    drop(c.ft_on_transfer(acc(AGENT), U128(INV3_UNITS), msg(INV3)));
}

// ------------------------------------------------------------------ events

#[test]
fn events_are_nep297_and_indexed() {
    let mut c = setup();
    drop(pay(&mut c, AGENT, INV4, INV4_UNITS));
    let raw = get_logs().pop().unwrap();
    assert!(raw.starts_with(r#"EVENT_JSON:{"standard":"signatory","version":"2.0.0","event":"payment_pending","data":[{"#));

    let all = c.get_events(0, None);
    let names: Vec<_> = all.iter().map(|e| e.event.as_str()).collect();
    assert_eq!(names, vec!["invoice_registered", "invoice_registered", "payment_pending"]);
    assert_eq!(all.iter().map(|e| e.index).collect::<Vec<_>>(), vec![0, 1, 2]);
    assert_eq!(all[2].json, raw.strip_prefix("EVENT_JSON:").unwrap());
    assert_eq!(all[2].block_height, U64(42));

    assert_eq!(c.get_events(2, None).len(), 1);
    assert_eq!(c.get_events(1, Some(1))[0].index, 1);
    assert!(c.get_events(3, None).is_empty());
    assert!(c.get_events(u32::MAX, Some(u32::MAX)).is_empty());
}

#[test]
fn get_events_page_is_capped() {
    let mut c = setup();
    for i in 0..(MAX_EVENTS_PAGE + 5) {
        // one tx per registration (per-receipt log limit is 16 KiB)
        register(&mut c, &format!("E{i}"), 1);
    }
    assert_eq!(c.get_events(0, Some(1000)).len() as u32, MAX_EVENTS_PAGE);
    assert_eq!(c.get_events(0, None).len() as u32, MAX_EVENTS_PAGE);
    assert_eq!(c.get_config().events_count, MAX_EVENTS_PAGE + 7);
}

#[test]
fn invoice_view_json_shape() {
    let mut c = setup();
    let v = serde_json::to_value(c.get_invoice(INV3.into()).unwrap()).unwrap();
    assert_eq!(v["said"], INV3);
    assert_eq!(v["commit"], INV3_COMMIT_VECTOR);
    assert_eq!(v["status"], "registered");
    assert_eq!(v["amount_units"], Value::Null);
    assert_eq!(v["payee"], Value::Null);
    assert_eq!(v["payer"], Value::Null);
    for gone in ["seller_lei", "buyer_lei", "due"] {
        assert!(v.get(gone).is_none(), "{gone} must not be on-chain");
    }
    assert!(c.get_invoice("EUNKNOWN".into()).is_none());
    // after payment the revealed amount and payee are visible (the transfer shows them too)
    drop(pay(&mut c, AGENT, INV3, INV3_UNITS));
    let v = serde_json::to_value(c.get_invoice(INV3.into()).unwrap()).unwrap();
    assert_eq!(v["amount_units"], "84000");
    assert_eq!(v["payee"], PAYEE);
    assert_eq!(v["status"], "paid");
}

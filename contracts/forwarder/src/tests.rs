use super::*;
use near_sdk::mock::MockAction;
use near_sdk::test_utils::{VMContextBuilder, get_created_receipts, get_logs};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn me() -> AccountId {
    acc("forwarder.nearbi.testnet")
}
fn owner() -> AccountId {
    acc("owner.testnet")
}
fn agent() -> AccountId {
    acc("agent.testnet")
}
fn splitter() -> AccountId {
    acc("splitter.nearbi.testnet")
}
fn token() -> AccountId {
    acc("usdc.testnet")
}
const USDC: u128 = 1_000_000;

fn ctx(predecessor: AccountId, deposit: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(me())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300));
    b
}

fn at(predecessor: AccountId, deposit: u128, ts_ns: u64) {
    testing_env!(ctx(predecessor, deposit).block_timestamp(ts_ns).build());
}

fn with_results(results: Vec<PromiseResult>) {
    testing_env!(
        ctx(me(), 0).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn setup(delay: Option<u64>) -> Forwarder {
    testing_env!(ctx(owner(), 0).build());
    Forwarder::init(owner(), splitter(), token(), agent(), delay.map(U64))
}

fn events(name: &str) -> Vec<serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<serde_json::Value>(j).unwrap())
        .filter(|v| v["event"] == name)
        .map(|v| v["data"][0].clone())
        .collect()
}

/// Every receipt the contract created so far: either the token's
/// ft_transfer_call with receiver_id == the expected splitter and 1 yocto, or
/// the on_forward callback to itself with no deposit. No NEAR transfers, no
/// other methods, no other receivers. Returns the number of ft_transfer_calls.
fn assert_only_splitter_transfers(expected_splitter: &AccountId, expected_token: &AccountId) -> usize {
    let mut n = 0;
    for r in get_created_receipts() {
        for a in &r.actions {
            match a {
                MockAction::FunctionCallWeight { method_name, args, attached_deposit, .. } => {
                    let m = String::from_utf8(method_name.clone()).unwrap();
                    if r.receiver_id == *expected_token {
                        assert_eq!(m, "ft_transfer_call", "unexpected token method {m}");
                        let v: serde_json::Value = serde_json::from_slice(args).unwrap();
                        assert_eq!(v["receiver_id"], expected_splitter.as_str(), "tokens sent to non-splitter: {v}");
                        assert_eq!(*attached_deposit, NearToken::from_yoctonear(1));
                        let msg: serde_json::Value = serde_json::from_str(v["msg"].as_str().unwrap()).unwrap();
                        assert_eq!(msg.as_object().unwrap().len(), 1, "msg must only carry order_id: {msg}");
                        assert!(msg["order_id"].is_string());
                        n += 1;
                    } else {
                        assert_eq!(r.receiver_id, me(), "call to unexpected account {}", r.receiver_id);
                        assert_eq!(m, "on_forward");
                        assert_eq!(*attached_deposit, NearToken::from_yoctonear(0));
                    }
                }
                other => panic!("unexpected action {other:?}"),
            }
        }
    }
    n
}

fn forward_ok(f: &mut Forwarder, who: AccountId, id: &str, amount: u128) {
    testing_env!(ctx(who, 0).build());
    let _ = f.forward(id.into(), U128(amount));
}

fn used(v: u128) -> PromiseResult {
    PromiseResult::Successful(serde_json::to_vec(&U128(v)).unwrap())
}

// ----------------------------------------------------------------- init

#[test]
fn init_defaults_to_24h_delay() {
    let f = setup(None);
    let c = f.get_config();
    assert_eq!(c.change_delay_sec.0, 86_400);
    assert_eq!(c.splitter, splitter());
    assert_eq!(c.token, token());
    assert_eq!(c.agent, agent());
    assert!(!c.paused);
    assert!(c.pending_change.is_none());
    assert_eq!(events("init").len(), 1);
}

#[test]
#[should_panic(expected = "splitter and token must differ")]
fn init_rejects_splitter_equal_token() {
    testing_env!(ctx(owner(), 0).build());
    Forwarder::init(owner(), token(), token(), agent(), None);
}

#[test]
#[should_panic(expected = "splitter must not be the forwarder itself")]
fn init_rejects_self_as_splitter() {
    testing_env!(ctx(owner(), 0).build());
    Forwarder::init(owner(), me(), token(), agent(), None);
}

#[test]
#[should_panic(expected = "owner must not be the forwarder account itself")]
fn init_rejects_self_as_owner() {
    testing_env!(ctx(owner(), 0).build());
    Forwarder::init(me(), splitter(), token(), agent(), None);
}

#[test]
#[should_panic(expected = "change_delay_sec too large")]
fn init_rejects_huge_delay() {
    setup(Some(31 * 86_400));
}

// ------------------------------------------------------------- forward

#[test]
fn agent_forward_creates_only_a_splitter_transfer_call() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, agent(), "ord-1", 49 * USDC);
    assert_eq!(assert_only_splitter_transfers(&splitter(), &token()), 1);
    let o = f.get_order("ord-1".into()).unwrap();
    assert_eq!(o.status, OrderStatus::InFlight);
    assert_eq!(o.amount.0, 49 * USDC);
    assert!(!f.is_forwarded("ord-1".into()));
    assert_eq!(f.get_pending(None, None).len(), 1);
    let ev = &events("forward_started")[0];
    assert_eq!(ev["order_id"], "ord-1");
    assert_eq!(ev["splitter"], splitter().as_str());
}

#[test]
fn owner_can_forward_too() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, owner(), "ord-o", 1);
    assert_eq!(assert_only_splitter_transfers(&splitter(), &token()), 1);
}

#[test]
fn msg_is_json_encoded_so_order_id_cannot_inject_fields() {
    let mut f = setup(Some(0));
    let evil = r#"x","receiver_id":"evil.testnet","order_id":"y"#;
    forward_ok(&mut f, agent(), evil, 5);
    assert_eq!(assert_only_splitter_transfers(&splitter(), &token()), 1);
    let r = &get_created_receipts()[0];
    if let MockAction::FunctionCallWeight { args, .. } = &r.actions[0] {
        let v: serde_json::Value = serde_json::from_slice(args).unwrap();
        let msg: serde_json::Value = serde_json::from_str(v["msg"].as_str().unwrap()).unwrap();
        assert_eq!(msg["order_id"], evil);
    } else {
        panic!()
    }
}

#[test]
#[should_panic(expected = "agent or owner only")]
fn stranger_cannot_forward() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, acc("mallory.testnet"), "ord-1", 1);
}

#[test]
#[should_panic(expected = "agent or owner only")]
fn splitter_cannot_forward() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, splitter(), "ord-1", 1);
}

#[test]
#[should_panic(expected = "order_id must not be empty")]
fn forward_rejects_empty_order_id() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, agent(), "", 1);
}

#[test]
#[should_panic(expected = "order_id too long")]
fn forward_rejects_long_order_id() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, agent(), &"a".repeat(129), 1);
}

#[test]
#[should_panic(expected = "amount must be positive")]
fn forward_rejects_zero() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, agent(), "z", 0);
}

#[test]
#[should_panic(expected = "attach at least 130 Tgas")]
fn forward_requires_enough_gas_for_callback() {
    let mut f = setup(Some(0));
    testing_env!(ctx(agent(), 0).prepaid_gas(Gas::from_tgas(100)).build());
    let _ = f.forward("g".into(), U128(1));
}

#[test]
#[should_panic(expected = "order forward already in flight")]
fn double_forward_while_in_flight_rejected() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, agent(), "dup", 49 * USDC);
    forward_ok(&mut f, agent(), "dup", 49 * USDC);
}

#[test]
#[should_panic(expected = "order already forwarded")]
fn double_forward_after_success_rejected() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, agent(), "dup", 49 * USDC);
    with_results(vec![used(49 * USDC)]);
    f.on_forward("dup".into(), U128(49 * USDC));
    assert!(f.is_forwarded("dup".into()));
    forward_ok(&mut f, owner(), "dup", 49 * USDC);
}

#[test]
fn success_callback_marks_forwarded_and_emits() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, agent(), "ok", 49 * USDC);
    with_results(vec![used(49 * USDC)]);
    assert_eq!(f.on_forward("ok".into(), U128(49 * USDC)).0, 49 * USDC);
    assert!(f.is_forwarded("ok".into()));
    assert!(f.get_pending(None, None).is_empty());
    let c = f.get_config();
    assert_eq!(c.forwarded_count, 1);
    assert_eq!(c.forwarded_total.0, 49 * USDC);
    let ev = &events("forwarded")[0];
    assert_eq!(ev["order_id"], "ok");
    assert_eq!(ev["amount"], "49000000");
}

#[test]
fn refund_marks_retryable_then_retry_succeeds() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, agent(), "r", 49 * USDC);
    // splitter paused: ft_on_transfer returned everything unused -> used = 0
    with_results(vec![used(0)]);
    assert_eq!(f.on_forward("r".into(), U128(49 * USDC)).0, 0);
    let o = f.get_order("r".into()).unwrap();
    assert_eq!(o.status, OrderStatus::Retryable);
    assert_eq!(o.unused.0, 49 * USDC);
    assert!(!f.is_forwarded("r".into()));
    let ev = &events("forward_failed")[0];
    assert_eq!(ev["unused"], "49000000");
    assert_eq!(ev["amount"], "49000000");
    assert_eq!(f.get_pending(None, None)[0].status, OrderStatus::Retryable);

    forward_ok(&mut f, agent(), "r", 49 * USDC);
    assert_eq!(assert_only_splitter_transfers(&splitter(), &token()), 1);
    assert_eq!(f.get_order("r".into()).unwrap().attempts, 2);
    with_results(vec![used(49 * USDC)]);
    f.on_forward("r".into(), U128(49 * USDC));
    assert!(f.is_forwarded("r".into()));
    assert_eq!(f.get_config().forwarded_total.0, 49 * USDC);
}

#[test]
fn failed_promise_marks_retryable() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, agent(), "pf", 7);
    with_results(vec![PromiseResult::Failed]);
    assert_eq!(f.on_forward("pf".into(), U128(7)).0, 0);
    let o = f.get_order("pf".into()).unwrap();
    assert_eq!(o.status, OrderStatus::Retryable);
    assert_eq!(o.unused.0, 7);
}

#[test]
fn partial_use_records_forwarded_part_and_retries_only_the_rest() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, agent(), "part", 100);
    with_results(vec![used(60)]);
    f.on_forward("part".into(), U128(100));
    let o = f.get_order("part".into()).unwrap();
    assert_eq!((o.status.clone(), o.forwarded_amount.0, o.unused.0), (OrderStatus::Retryable, 60, 40));
    forward_ok(&mut f, agent(), "part", 40);
    with_results(vec![used(40)]);
    f.on_forward("part".into(), U128(40));
    let o = f.get_order("part".into()).unwrap();
    assert_eq!((o.status, o.forwarded_amount.0), (OrderStatus::Forwarded, 100));
    assert_eq!(f.get_config().forwarded_total.0, 100);
}

#[test]
#[should_panic(expected = "retry amount must equal the recorded unused amount")]
fn retry_cannot_change_amount() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, agent(), "r2", 49 * USDC);
    with_results(vec![used(0)]);
    f.on_forward("r2".into(), U128(49 * USDC));
    forward_ok(&mut f, agent(), "r2", 50 * USDC);
}

#[test]
#[should_panic(expected = "forwarder is paused")]
fn paused_blocks_forward() {
    let mut f = setup(Some(0));
    testing_env!(ctx(owner(), 1).build());
    f.pause();
    forward_ok(&mut f, agent(), "p", 1);
}

// --------------------------------------------------------------- owner

#[test]
fn owner_sets_agent_and_pauses() {
    let mut f = setup(Some(0));
    testing_env!(ctx(owner(), 1).build());
    f.set_agent(acc("agent2.testnet"));
    f.pause();
    assert!(f.get_config().paused);
    f.unpause();
    assert_eq!(f.get_config().agent, acc("agent2.testnet"));
    assert_eq!(events("config_change").len(), 3);
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_set_agent() {
    let mut f = setup(Some(0));
    testing_env!(ctx(agent(), 1).build());
    f.set_agent(acc("agent2.testnet"));
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_methods_need_one_yocto() {
    let mut f = setup(Some(0));
    testing_env!(ctx(owner(), 0).build());
    f.pause();
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_propose() {
    let mut f = setup(Some(0));
    testing_env!(ctx(agent(), 1).build());
    f.propose_change(ChangeField::Splitter, acc("evil.testnet"));
}

#[test]
fn splitter_change_is_delayed_and_public() {
    let day = 86_400u64;
    let mut f = setup(Some(day));
    at(owner(), 1, 1_000);
    f.propose_change(ChangeField::Splitter, acc("splitter2.testnet"));
    let ev = &events("change_proposed")[0];
    assert_eq!(ev["field"], "splitter");
    assert_eq!(ev["value"], "splitter2.testnet");
    let pc = f.get_config().pending_change.unwrap();
    assert_eq!(pc.eta_ns.0, 1_000 + day * 1_000_000_000);
    // still forwards to the OLD splitter during the delay
    at(agent(), 0, 2_000);
    let _ = f.forward("during-delay".into(), U128(1));
    assert_eq!(assert_only_splitter_transfers(&splitter(), &token()), 1);

    at(owner(), 1, pc.eta_ns.0);
    f.accept_change();
    let ev = &events("change_accepted")[0];
    assert_eq!(ev["old"], splitter().as_str());
    assert_eq!(ev["new"], "splitter2.testnet");
    assert_eq!(f.get_config().splitter, acc("splitter2.testnet"));
    assert!(f.get_config().pending_change.is_none());
    at(agent(), 0, pc.eta_ns.0 + 1);
    let _ = f.forward("after".into(), U128(1));
    assert_eq!(assert_only_splitter_transfers(&acc("splitter2.testnet"), &token()), 1);
}

#[test]
#[should_panic(expected = "change delay has not elapsed")]
fn accept_before_delay_fails() {
    let mut f = setup(None);
    at(owner(), 1, 1_000);
    f.propose_change(ChangeField::Splitter, acc("splitter2.testnet"));
    at(owner(), 1, 1_000 + 86_399 * 1_000_000_000);
    f.accept_change();
}

#[test]
#[should_panic(expected = "a change is already pending")]
fn only_one_pending_change() {
    let mut f = setup(None);
    at(owner(), 1, 1_000);
    f.propose_change(ChangeField::Splitter, acc("splitter2.testnet"));
    f.propose_change(ChangeField::Token, acc("usdc2.testnet"));
}

#[test]
fn cancel_change_clears_it() {
    let mut f = setup(None);
    at(owner(), 1, 1_000);
    f.propose_change(ChangeField::Owner, acc("owner2.testnet"));
    f.cancel_change();
    assert!(f.get_config().pending_change.is_none());
    assert_eq!(events("change_cancelled").len(), 1);
    f.propose_change(ChangeField::Splitter, acc("splitter2.testnet"));
}

#[test]
#[should_panic(expected = "cannot change token while orders are in flight or retryable")]
fn token_change_blocked_with_open_orders() {
    let mut f = setup(Some(0));
    forward_ok(&mut f, agent(), "open", 1);
    at(owner(), 1, 10);
    f.propose_change(ChangeField::Token, acc("usdc2.testnet"));
}

#[test]
fn owner_change_via_timelock() {
    let mut f = setup(Some(0));
    at(owner(), 1, 10);
    f.propose_change(ChangeField::Owner, acc("owner2.testnet"));
    f.accept_change();
    assert_eq!(f.get_config().owner, acc("owner2.testnet"));
}

#[test]
#[should_panic(expected = "splitter must not be the forwarder itself")]
fn cannot_propose_self_as_splitter() {
    let mut f = setup(Some(0));
    at(owner(), 1, 10);
    f.propose_change(ChangeField::Splitter, me());
}

// -------------------------------------------------------- ft_on_transfer

#[test]
fn ft_on_transfer_accepts_configured_token() {
    let mut f = setup(Some(0));
    testing_env!(ctx(token(), 0).build());
    match f.ft_on_transfer(acc("intents.near"), U128(49 * USDC), "anything".into()) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 0),
        _ => panic!("expected value"),
    }
    assert_eq!(events("received")[0]["sender"], "intents.near");
    assert!(get_created_receipts().is_empty());
}

#[test]
#[should_panic(expected = "token not accepted")]
fn ft_on_transfer_rejects_other_tokens() {
    let mut f = setup(Some(0));
    testing_env!(ctx(acc("other-token.testnet"), 0).build());
    let _ = f.ft_on_transfer(acc("x.testnet"), U128(1), "".into());
}

// ------------------------------------------------------------- invariant

/// Drive every state-changing method as owner and as agent with crafted
/// arguments and check that no receipt ever targets anything but
/// token.ft_transfer_call(receiver = configured splitter) or our own callback.
#[test]
fn invariant_no_path_sends_tokens_to_a_non_splitter() {
    // (the mocked blockchain resets receipts on every testing_env!, so check after each call)
    let mut f = setup(Some(0));
    let mut sent = 0;
    for who in [owner(), agent()] {
        let id = format!("inv-{who}");
        forward_ok(&mut f, who.clone(), &id, 3);
        sent += assert_only_splitter_transfers(&splitter(), &token());
        with_results(vec![used(0)]);
        f.on_forward(id.clone(), U128(3));
        assert!(get_created_receipts().is_empty(), "callback must not create receipts");
        forward_ok(&mut f, who.clone(), &id, 3);
        sent += assert_only_splitter_transfers(&splitter(), &token());
    }
    assert_eq!(sent, 4);
    at(owner(), 1, 5);
    f.set_agent(owner());
    f.pause();
    f.unpause();
    f.propose_change(ChangeField::Owner, acc("o2.testnet"));
    f.cancel_change();
    assert!(get_created_receipts().is_empty(), "owner methods must not create receipts");
    testing_env!(ctx(token(), 0).build());
    let _ = f.ft_on_transfer(owner(), U128(10), r#"{"receiver_id":"owner.testnet"}"#.into());
    assert!(get_created_receipts().is_empty(), "ft_on_transfer must not create receipts");
}

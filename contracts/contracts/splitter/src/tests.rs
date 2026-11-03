use super::*;
use near_sdk::test_utils::{VMContextBuilder, accounts, get_logs};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn splitter_id() -> AccountId {
    acc("splitter.nearbi.testnet")
}
fn owner() -> AccountId {
    acc("owner.testnet")
}
fn token() -> AccountId {
    acc("usdc.testnet")
}

fn ctx(predecessor: AccountId, deposit: u128) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(splitter_id())
        .signer_account_id(predecessor.clone())
        .predecessor_account_id(predecessor)
        .attached_deposit(NearToken::from_yoctonear(deposit));
    b
}

/// Simulate a callback on the splitter with the given promise results.
fn with_results(results: Vec<PromiseResult>) {
    testing_env!(
        ctx(splitter_id(), 0).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}

fn setup(bps: u16) -> Splitter {
    testing_env!(ctx(owner(), 0).build());
    Splitter::init(owner(), acc("treasury.testnet"), acc("contributors.testnet"), bps, vec![token()])
}

fn events(name: &str) -> Vec<serde_json::Value> {
    get_logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<serde_json::Value>(j).unwrap())
        .filter(|v| v["event"] == name)
        .collect()
}

#[test]
fn split_math_is_floor_with_remainder_to_treasury() {
    assert_eq!(split_amount(49_000_000, 1000), (4_900_000, 44_100_000));
    assert_eq!(split_amount(1, 1000), (0, 1));
    assert_eq!(split_amount(9, 1000), (0, 9));
    assert_eq!(split_amount(10, 1000), (1, 9));
    assert_eq!(split_amount(12_345_679, 1000), (1_234_567, 11_111_112));
    assert_eq!(split_amount(10_001, 3333), (3_333, 6_668));
    assert_eq!(split_amount(7, 5000), (3, 4));
    assert_eq!(split_amount(123, 0), (0, 123));
    // no overflow at the top of the range
    let (c, t) = split_amount(u128::MAX, 5000);
    assert_eq!(c + t, u128::MAX);
    assert_eq!(c, u128::MAX / 2);
}

#[test]
fn split_sums_exactly_for_many_amounts() {
    for bps in [0u16, 1, 999, 1000, 2500, 4999, 5000] {
        for amount in (0u128..20_000).step_by(7).chain([u64::MAX as u128, 10u128.pow(30) + 3]) {
            let (c, t) = split_amount(amount, bps);
            assert_eq!(c + t, amount);
            assert_eq!(c, amount * bps as u128 / 10_000);
        }
    }
}

#[test]
#[should_panic(expected = "split_bps_contributors must be in 0..=5000")]
fn init_rejects_split_above_5000() {
    setup(5001);
}

#[test]
fn get_config_reflects_init() {
    let c = setup(1000).get_config();
    assert_eq!(c.split_bps_contributors, 1000);
    assert_eq!(c.split_bps_treasury, 9000);
    assert_eq!(c.accepted_tokens, vec![token()]);
    assert!(!c.paused);
}

#[test]
fn owner_can_set_split_within_bounds() {
    let mut s = setup(1000);
    testing_env!(ctx(owner(), 1).build());
    s.set_split(5000);
    assert_eq!(s.get_config().split_bps_contributors, 5000);
    s.set_split(0);
    assert_eq!(s.get_config().split_bps_contributors, 0);
    assert_eq!(events("config_change").len(), 2);
}

#[test]
#[should_panic(expected = "split_bps_contributors must be in 0..=5000")]
fn set_split_rejects_above_bound() {
    let mut s = setup(1000);
    testing_env!(ctx(owner(), 1).build());
    s.set_split(5001);
}

#[test]
#[should_panic(expected = "owner only")]
fn set_split_rejects_non_owner() {
    let mut s = setup(1000);
    testing_env!(ctx(accounts(1), 1).build());
    s.set_split(2000);
}

#[test]
#[should_panic(expected = "owner only")]
fn set_split_rejects_splitter_self_call() {
    // i.e. the agent's function-call key on the splitter account
    let mut s = setup(1000);
    testing_env!(ctx(splitter_id(), 1).build());
    s.set_split(2000);
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_methods_require_one_yocto() {
    let mut s = setup(1000);
    testing_env!(ctx(owner(), 0).build());
    s.pause();
}

#[test]
fn set_accounts_and_tokens() {
    let mut s = setup(1000);
    testing_env!(ctx(owner(), 1).build());
    s.set_accounts(None, Some(acc("t2.testnet")), Some(acc("c2.testnet")));
    s.add_token(acc("usdt.testnet"));
    s.remove_token(token());
    let c = s.get_config();
    assert_eq!(c.treasury, acc("t2.testnet"));
    assert_eq!(c.contributors, acc("c2.testnet"));
    assert_eq!(c.accepted_tokens, vec![acc("usdt.testnet")]);
}

#[test]
#[should_panic(expected = "treasury and contributors must differ")]
fn set_accounts_rejects_same_payout_accounts() {
    let mut s = setup(1000);
    testing_env!(ctx(owner(), 1).build());
    s.set_accounts(None, Some(acc("contributors.testnet")), None);
}

#[test]
fn ft_on_transfer_splits_and_emits_sale() {
    let mut s = setup(1000);
    testing_env!(ctx(token(), 0).build());
    let r = s.ft_on_transfer(acc("customer.testnet"), U128(49_000_000), r#"{"order_id":"ord-1"}"#.into());
    match r {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 0),
        _ => panic!("expected value"),
    }
    let sale = &events("sale")[0];
    assert_eq!(sale["standard"], EVENT_STANDARD);
    let d = &sale["data"][0];
    assert_eq!(d["order_id"], "ord-1");
    assert_eq!(d["payer"], "customer.testnet");
    assert_eq!(d["token"], "usdc.testnet");
    assert_eq!(d["amount"], "49000000");
    assert_eq!(d["contributors_amount"], "4900000");
    assert_eq!(d["treasury_amount"], "44100000");
    let st = &s.get_stats()[0];
    assert_eq!(st.stats.sales, 1);
    assert_eq!(st.stats.total_received.0, 49_000_000);
    assert_eq!(st.stats.contributors_amount.0, 4_900_000);
    assert_eq!(st.stats.treasury_amount.0, 44_100_000);
}

#[test]
#[should_panic(expected = "token not accepted")]
fn ft_on_transfer_rejects_unknown_token() {
    let mut s = setup(1000);
    testing_env!(ctx(acc("evil-token.testnet"), 0).build());
    let _ = s.ft_on_transfer(acc("customer.testnet"), U128(1), r#"{"order_id":"x"}"#.into());
}

#[test]
#[should_panic(expected = "msg must be JSON")]
fn ft_on_transfer_rejects_bad_msg() {
    let mut s = setup(1000);
    testing_env!(ctx(token(), 0).build());
    let _ = s.ft_on_transfer(acc("customer.testnet"), U128(1), "hello".into());
}

#[test]
#[should_panic(expected = "order_id must not be empty")]
fn ft_on_transfer_rejects_empty_order_id() {
    let mut s = setup(1000);
    testing_env!(ctx(token(), 0).build());
    let _ = s.ft_on_transfer(acc("customer.testnet"), U128(1), r#"{"order_id":""}"#.into());
}

#[test]
fn paused_returns_full_amount_unused() {
    let mut s = setup(1000);
    testing_env!(ctx(owner(), 1).build());
    s.pause();
    testing_env!(ctx(token(), 0).build());
    match s.ft_on_transfer(acc("customer.testnet"), U128(777), r#"{"order_id":"p"}"#.into()) {
        PromiseOrValue::Value(v) => assert_eq!(v.0, 777),
        _ => panic!("expected value"),
    }
    assert!(s.get_stats().is_empty());
    testing_env!(ctx(owner(), 1).build());
    s.unpause();
    assert!(!s.get_config().paused);
}

#[test]
fn agent_can_record_cost_and_anchor() {
    let mut s = setup(1000);
    testing_env!(ctx(splitter_id(), 0).build());
    s.record_cost("inference".into(), U64(1_234), "nearai:run-1".into());
    s.anchor_report("q4-report".into(), "a".repeat(64));
    let c = &events("cost")[0]["data"][0];
    assert_eq!(c["kind"], "inference");
    assert_eq!(c["amount_usd_micros"], "1234");
    assert_eq!(c["ref"], "nearai:run-1");
    assert_eq!(events("report_anchor")[0]["data"][0]["manifest_sha256"], "a".repeat(64));
}

#[test]
#[should_panic(expected = "agent or owner only")]
fn record_cost_rejects_strangers() {
    let mut s = setup(1000);
    testing_env!(ctx(accounts(2), 0).build());
    s.record_cost("inference".into(), U64(1), "x".into());
}

#[test]
#[should_panic(expected = "manifest_sha256 must be 64 lowercase hex chars")]
fn anchor_rejects_bad_hash() {
    let mut s = setup(1000);
    testing_env!(ctx(splitter_id(), 0).build());
    s.anchor_report("r".into(), "XYZ".into());
}

#[test]
fn failed_payout_is_recorded_and_retryable() {
    let mut s = setup(1000);
    with_results(vec![PromiseResult::Failed]);
    let ok = s.on_payout(token(), acc("contributors.testnet"), Role::Contributors, U128(4_900_000), "o1".into());
    assert!(!ok);
    let f = s.get_failed_payouts();
    assert_eq!(f.len(), 1);
    assert_eq!(f[0].amount.0, 4_900_000);
    assert_eq!(f[0].recipient, acc("contributors.testnet"));
    assert_eq!(s.get_stats()[0].stats.pending_failed.0, 4_900_000);
    assert_eq!(events("payout_failed")[0]["data"][0]["order_id"], "o1");

    testing_env!(ctx(accounts(3), 0).build());
    s.retry_payout(U64(0));
    assert!(s.get_failed_payouts().is_empty());
    assert_eq!(s.get_stats()[0].stats.pending_failed.0, 0);
}

#[test]
fn successful_payout_emits_payout_event() {
    let mut s = setup(1000);
    with_results(vec![PromiseResult::Successful(vec![])]);
    assert!(s.on_payout(token(), acc("treasury.testnet"), Role::Treasury, U128(5), "o2".into()));
    assert_eq!(events("payout")[0]["data"][0]["role"], "Treasury");
    assert!(s.get_failed_payouts().is_empty());
}

//! near-workspaces sandbox tests: real NEP-141 mock token + splitter WASM.
//!
//! Uses the release artifacts in res/ (built by bin/build.sh). Override with
//! SPLITTER_WASM / FT_WASM.
use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{Value, json};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const USDC: u128 = 1_000_000; // 6 decimals

fn wasm(env_var: &str, default: &str) -> Vec<u8> {
    let path = std::env::var(env_var)
        .unwrap_or_else(|_| format!("{}/../res/{}", env!("CARGO_MANIFEST_DIR"), default));
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e} (run bin/build.sh)"))
}

struct Env {
    worker: Worker<Sandbox>,
    owner: Account,
    splitter: Contract,
    token: Contract,
    treasury: Account,
    contributors: Account,
    customer: Account,
}

async fn deploy_token(worker: &Worker<Sandbox>, owner: &Account, name: &str) -> anyhow::Result<Contract> {
    let acc = owner
        .create_subaccount(name)
        .initial_balance(NearToken::from_near(10))
        .transact()
        .await?
        .into_result()?;
    let token = acc.deploy(&wasm("FT_WASM", "usdc_mock.wasm")).await?.into_result()?;
    token
        .call("new")
        .args_json(json!({ "owner_id": owner.id(), "total_supply": (1_000_000 * USDC).to_string() }))
        .transact()
        .await?
        .into_result()?;
    let _ = worker;
    Ok(token)
}

async fn register(token: &Contract, who: &AccountId, payer: &Account) -> anyhow::Result<()> {
    payer
        .call(token.id(), "storage_deposit")
        .args_json(json!({ "account_id": who, "registration_only": true }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn ft_transfer(token: &Contract, from: &Account, to: &AccountId, amount: u128) -> anyhow::Result<()> {
    from.call(token.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": to, "amount": amount.to_string() }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn balance(token: &Contract, who: &AccountId) -> anyhow::Result<u128> {
    let v: String = token.view("ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
    Ok(v.parse()?)
}

async fn pay(token: &Contract, customer: &Account, splitter: &AccountId, amount: u128, order_id: &str) -> anyhow::Result<ExecutionFinalResult> {
    Ok(customer
        .call(token.id(), "ft_transfer_call")
        .args_json(json!({
            "receiver_id": splitter,
            "amount": amount.to_string(),
            "msg": json!({ "order_id": order_id }).to_string(),
        }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?)
}

/// Assert a call made with the function-call key was rejected, and print why.
fn rejected<E: std::fmt::Debug>(what: &str, r: Result<ExecutionFinalResult, E>, reasons: &[&str]) {
    let text = match &r {
        Err(e) => format!("{e:?}"),
        Ok(res) => {
            assert!(res.is_failure(), "{what} unexpectedly succeeded: {res:?}");
            format!("{:?}", res.failures())
        }
    };
    let hit = reasons.iter().find(|k| text.contains(*k));
    assert!(hit.is_some(), "{what}: expected one of {reasons:?}, got {text}");
    eprintln!("rejected as expected: {what} -> {}", hit.unwrap());
}

fn events(res: &ExecutionFinalResult, name: &str) -> Vec<Value> {
    res.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .filter(|v| v["standard"] == "nearbi_splitter" && v["event"] == name)
        .map(|v| v["data"][0].clone())
        .collect()
}

async fn setup(bps: u16) -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let owner = root.create_subaccount("owner").initial_balance(NearToken::from_near(100)).transact().await?.into_result()?;
    let token = deploy_token(&worker, &owner, "usdc").await?;
    let splitter_acc = owner.create_subaccount("splitter").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let treasury = owner.create_subaccount("treasury").initial_balance(NearToken::from_near(2)).transact().await?.into_result()?;
    let contributors = owner.create_subaccount("contributors").initial_balance(NearToken::from_near(2)).transact().await?.into_result()?;
    let customer = root.create_subaccount("customer").initial_balance(NearToken::from_near(10)).transact().await?.into_result()?;
    let splitter = splitter_acc.deploy(&wasm("SPLITTER_WASM", "nearbi_splitter.wasm")).await?.into_result()?;
    splitter
        .call("init")
        .args_json(json!({
            "owner": owner.id(),
            "treasury": treasury.id(),
            "contributors": contributors.id(),
            "split_bps_contributors": bps,
            "accepted_tokens": [token.id()],
        }))
        .transact()
        .await?
        .into_result()?;
    for who in [splitter.id(), treasury.id(), contributors.id(), customer.id()] {
        register(&token, who, &owner).await?;
    }
    ft_transfer(&token, &owner, customer.id(), 1_000 * USDC).await?;
    Ok(Env { worker, owner, splitter, token, treasury, contributors, customer })
}

#[tokio::test]
async fn sale_splits_exactly_including_odd_amounts() -> anyhow::Result<()> {
    let e = setup(1000).await?;
    let cases: [(u128, u128, u128); 5] = [
        (49 * USDC, 4_900_000, 44_100_000),
        (1, 0, 1),
        (9_999, 999, 9_000),
        (12_345_679, 1_234_567, 11_111_112),
        (10_000_001, 1_000_000, 9_000_001),
    ];
    let (mut exp_c, mut exp_t) = (0u128, 0u128);
    let cust0 = balance(&e.token, e.customer.id()).await?;
    let mut paid = 0u128;
    for (i, (amount, c, t)) in cases.iter().enumerate() {
        let res = pay(&e.token, &e.customer, e.splitter.id(), *amount, &format!("ord-{i}")).await?;
        assert!(res.is_success(), "{res:?}");
        let sale = &events(&res, "sale")[0];
        assert_eq!(sale["order_id"], format!("ord-{i}"));
        assert_eq!(sale["payer"], e.customer.id().as_str());
        assert_eq!(sale["token"], e.token.id().as_str());
        assert_eq!(sale["amount"], amount.to_string());
        assert_eq!(sale["contributors_amount"], c.to_string());
        assert_eq!(sale["treasury_amount"], t.to_string());
        assert!(events(&res, "payout_failed").is_empty());
        exp_c += c;
        exp_t += t;
        paid += amount;
        assert_eq!(balance(&e.token, e.contributors.id()).await?, exp_c);
        assert_eq!(balance(&e.token, e.treasury.id()).await?, exp_t);
        assert_eq!(balance(&e.token, e.splitter.id()).await?, 0, "no dust left in splitter");
    }
    assert_eq!(balance(&e.token, e.customer.id()).await?, cust0 - paid);
    let stats: Value = e.splitter.view("get_stats").await?.json()?;
    assert_eq!(stats[0]["sales"], 5);
    assert_eq!(stats[0]["total_received"], paid.to_string());
    assert_eq!(stats[0]["contributors_amount"], exp_c.to_string());
    assert_eq!(stats[0]["treasury_amount"], exp_t.to_string());
    Ok(())
}

#[tokio::test]
async fn paused_refunds_payer_in_full() -> anyhow::Result<()> {
    let e = setup(1000).await?;
    e.owner.call(e.splitter.id(), "pause").deposit(ONE_YOCTO).transact().await?.into_result()?;
    let before = balance(&e.token, e.customer.id()).await?;
    let res = pay(&e.token, &e.customer, e.splitter.id(), 49 * USDC, "paused-1").await?;
    assert!(res.is_success(), "{res:?}");
    assert!(events(&res, "sale").is_empty());
    assert_eq!(events(&res, "refund_paused").len(), 1);
    assert_eq!(balance(&e.token, e.customer.id()).await?, before);
    assert_eq!(balance(&e.token, e.splitter.id()).await?, 0);
    assert_eq!(balance(&e.token, e.treasury.id()).await?, 0);

    e.owner.call(e.splitter.id(), "unpause").deposit(ONE_YOCTO).transact().await?.into_result()?;
    let res = pay(&e.token, &e.customer, e.splitter.id(), 49 * USDC, "after-unpause").await?;
    assert_eq!(events(&res, "sale").len(), 1);
    assert_eq!(balance(&e.token, e.treasury.id()).await?, 44_100_000);
    Ok(())
}

#[tokio::test]
async fn non_accepted_token_is_rejected_and_refunded() -> anyhow::Result<()> {
    let e = setup(1000).await?;
    let other = deploy_token(&e.worker, &e.owner, "other").await?;
    for who in [e.splitter.id(), e.customer.id()] {
        register(&other, who, &e.owner).await?;
    }
    ft_transfer(&other, &e.owner, e.customer.id(), 100 * USDC).await?;
    let res = pay(&other, &e.customer, e.splitter.id(), 49 * USDC, "bad-token").await?;
    // outer tx succeeds (ft_resolve_transfer refunds), the receiver call failed
    assert!(events(&res, "sale").is_empty());
    let failed = format!("{:?}", res.receipt_failures());
    assert!(failed.contains("token not accepted"), "{failed}");
    assert_eq!(balance(&other, e.customer.id()).await?, 100 * USDC);
    assert_eq!(balance(&other, e.splitter.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn function_call_key_can_record_but_not_administer_or_transfer() -> anyhow::Result<()> {
    let e = setup(1000).await?;
    let sk = SecretKey::from_random(KeyType::ED25519);
    // full-access splitter account (deployer) adds the scoped key
    e.splitter
        .as_account()
        .batch(e.splitter.id())
        .add_key(
            sk.public_key(),
            AccessKey::function_call_access(e.splitter.id(), &["record_cost", "anchor_report"], Some(NearToken::from_millinear(250))),
        )
        .transact()
        .await?
        .into_result()?;
    let agent = Account::from_secret_key(e.splitter.id().clone(), sk, &e.worker);

    // allowed
    let res = agent
        .call(e.splitter.id(), "record_cost")
        .args_json(json!({ "kind": "inference", "amount_usd_micros": "1250", "ref": "nearai:test" }))
        .transact()
        .await?;
    assert!(res.is_success(), "{res:?}");
    assert_eq!(events(&res, "cost")[0]["amount_usd_micros"], "1250");
    let res = agent
        .call(e.splitter.id(), "anchor_report")
        .args_json(json!({ "slug": "r1", "manifest_sha256": "ab".repeat(32) }))
        .transact()
        .await?;
    assert!(res.is_success(), "{res:?}");

    // not in method_names -> rejected by the protocol
    let r = agent.call(e.splitter.id(), "set_split").args_json(json!({ "split_bps_contributors": 5000 })).deposit(ONE_YOCTO).transact().await;
    rejected("set_split with deposit must fail", r, &["DepositWithFunctionCall"]);
    let r = agent.call(e.splitter.id(), "set_split").args_json(json!({ "split_bps_contributors": 5000 })).transact().await;
    rejected("set_split must fail", r, &["MethodNameMismatch"]);
    let r = agent.call(e.splitter.id(), "pause").transact().await;
    rejected("pause must fail", r, &["MethodNameMismatch"]);
    let r = agent.call(e.splitter.id(), "retry_payout").args_json(json!({ "id": "0" })).transact().await;
    rejected("retry_payout must fail", r, &["MethodNameMismatch"]);
    // a deposit on an allowed method is rejected too
    let r = agent.call(e.splitter.id(), "record_cost")
        .args_json(json!({ "kind": "x", "amount_usd_micros": "1", "ref": "y" }))
        .deposit(ONE_YOCTO).transact().await;
    rejected("deposit must fail", r, &["DepositWithFunctionCall"]);
    // FT transfer on the token contract: wrong receiver for this key
    let r = agent.call(e.token.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": e.customer.id(), "amount": "1" }))
        .deposit(ONE_YOCTO).transact().await;
    rejected("ft_transfer (1 yocto) must fail", r, &["DepositWithFunctionCall", "ReceiverMismatch"]);
    let r = agent.call(e.token.id(), "ft_transfer")
        .args_json(json!({ "receiver_id": e.customer.id(), "amount": "1" }))
        .transact().await;
    rejected("ft_transfer must fail", r, &["ReceiverMismatch"]);
    // plain NEAR transfer
    let r = agent.transfer_near(e.customer.id(), ONE_YOCTO).await;
    rejected("NEAR transfer must fail", r, &["RequiresFullAccess"]);
    // adding keys / deleting the account
    let r = agent.batch(e.splitter.id()).add_key(SecretKey::from_random(KeyType::ED25519).public_key(), AccessKey::full_access()).transact().await;
    rejected("add_key must fail", r, &["RequiresFullAccess"]);

    let cfg: Value = e.splitter.view("get_config").await?.json()?;
    assert_eq!(cfg["split_bps_contributors"], 1000);
    assert_eq!(cfg["paused"], false);
    Ok(())
}

#[tokio::test]
async fn owner_admin_and_bounds() -> anyhow::Result<()> {
    let e = setup(1000).await?;
    let r = e.owner.call(e.splitter.id(), "set_split").args_json(json!({ "split_bps_contributors": 5001 })).deposit(ONE_YOCTO).transact().await?;
    assert!(r.is_failure());
    let r = e.customer.call(e.splitter.id(), "set_split").args_json(json!({ "split_bps_contributors": 2000 })).deposit(ONE_YOCTO).transact().await?;
    assert!(r.is_failure());
    let r = e.owner.call(e.splitter.id(), "set_split").args_json(json!({ "split_bps_contributors": 2500 })).deposit(ONE_YOCTO).transact().await?;
    assert!(r.is_success(), "{r:?}");
    let res = pay(&e.token, &e.customer, e.splitter.id(), 49 * USDC, "after-split").await?;
    let sale = &events(&res, "sale")[0];
    assert_eq!(sale["contributors_amount"], "12250000");
    assert_eq!(sale["treasury_amount"], "36750000");
    let r = e.customer.call(e.splitter.id(), "record_cost").args_json(json!({ "kind": "x", "amount_usd_micros": "1", "ref": "y" })).transact().await?;
    assert!(r.is_failure(), "strangers cannot write ledger events");
    Ok(())
}

#[tokio::test]
async fn failed_payout_is_recorded_then_retried() -> anyhow::Result<()> {
    let e = setup(1000).await?;
    // contributors moves to an account that is NOT storage-registered on the token
    let newc = e.owner.create_subaccount("newcontrib").initial_balance(NearToken::from_near(1)).transact().await?.into_result()?;
    e.owner.call(e.splitter.id(), "set_accounts").args_json(json!({ "contributors": newc.id() })).deposit(ONE_YOCTO).transact().await?.into_result()?;

    let res = pay(&e.token, &e.customer, e.splitter.id(), 49 * USDC, "ord-fail").await?;
    assert_eq!(events(&res, "sale").len(), 1);
    let pf = events(&res, "payout_failed");
    assert_eq!(pf.len(), 1, "{:?}", res.logs());
    assert_eq!(pf[0]["recipient"], newc.id().as_str());
    assert_eq!(pf[0]["amount"], "4900000");
    // treasury still paid, contributors' share held in the splitter
    assert_eq!(balance(&e.token, e.treasury.id()).await?, 44_100_000);
    assert_eq!(balance(&e.token, e.splitter.id()).await?, 4_900_000);
    let failed: Value = e.splitter.view("get_failed_payouts").await?.json()?;
    assert_eq!(failed.as_array().unwrap().len(), 1);

    register(&e.token, newc.id(), &e.owner).await?;
    let res = e.customer.call(e.splitter.id(), "retry_payout").args_json(json!({ "id": "0" })).max_gas().transact().await?;
    assert!(res.is_success(), "{res:?}");
    assert_eq!(events(&res, "payout").len(), 1);
    assert_eq!(balance(&e.token, newc.id()).await?, 4_900_000);
    assert_eq!(balance(&e.token, e.splitter.id()).await?, 0);
    let failed: Value = e.splitter.view("get_failed_payouts").await?.json()?;
    assert!(failed.as_array().unwrap().is_empty());
    let _ = &e.contributors;
    Ok(())
}

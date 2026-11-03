//! near-workspaces sandbox tests for the settlement forwarder, against the real
//! mock NEP-141 token and the real splitter WASM.
//!
//! WASM from res/ (bin/build.sh); override with FORWARDER_WASM / SPLITTER_WASM / FT_WASM.
//!
//! Setup mirrors testnet: the agent's function-call key lives on the forwarder
//! account itself (agent = forwarder account), limited to `[forward]`; the
//! owner is a separate full-access account.
mod common;

use near_workspaces::network::Sandbox;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{Value, json};

const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
const USDC: u128 = 1_000_000;
const PRICE: u128 = 49 * USDC;
/// What bin/demo-intents.sh attaches; proves the gas budget is enough.
const FORWARD_GAS: Gas = Gas::from_tgas(150);

fn wasm(env_var: &str, default: &str) -> Vec<u8> {
    let path = std::env::var(env_var)
        .unwrap_or_else(|_| format!("{}/../res/{}", env!("CARGO_MANIFEST_DIR"), default));
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e} (run bin/build.sh)"))
}

struct Env {
    worker: Worker<Sandbox>,
    owner: Account,
    token: Contract,
    splitter: Contract,
    forwarder: Contract,
    treasury: Account,
    contributors: Account,
    oneclick: Account,
    /// function-call key on the forwarder account, methods = [forward]
    agent: Account,
}

async fn sub(parent: &Account, name: &str, near: u128) -> anyhow::Result<Account> {
    Ok(parent.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
}

async fn register(token: &AccountId, who: &AccountId, payer: &Account) -> anyhow::Result<()> {
    payer
        .call(token, "storage_deposit")
        .args_json(json!({ "account_id": who, "registration_only": true }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    Ok(())
}

async fn ft_transfer(token: &AccountId, from: &Account, to: &AccountId, amount: u128) -> anyhow::Result<ExecutionFinalResult> {
    Ok(from
        .call(token, "ft_transfer")
        .args_json(json!({ "receiver_id": to, "amount": amount.to_string(), "memo": "1click withdrawal (simulated)" }))
        .deposit(ONE_YOCTO)
        .transact()
        .await?)
}

async fn balance(token: &AccountId, worker: &Worker<Sandbox>, who: &AccountId) -> anyhow::Result<u128> {
    let v: String = worker.view(token, "ft_balance_of").args_json(json!({ "account_id": who })).await?.json()?;
    Ok(v.parse()?)
}

async fn deploy_token(owner: &Account, name: &str) -> anyhow::Result<Contract> {
    let acc = sub(owner, name, 10).await?;
    let token = acc.deploy(&wasm("FT_WASM", "usdc_mock.wasm")).await?.into_result()?;
    token
        .call("new")
        .args_json(json!({ "owner_id": owner.id(), "total_supply": (1_000_000 * USDC).to_string() }))
        .transact()
        .await?
        .into_result()?;
    Ok(token)
}

async fn deploy_splitter(owner: &Account, name: &str, token: &AccountId, treasury: &AccountId, contributors: &AccountId) -> anyhow::Result<Contract> {
    let acc = sub(owner, name, 10).await?;
    let s = acc.deploy(&wasm("SPLITTER_WASM", "nearbi_splitter.wasm")).await?.into_result()?;
    s.call("init")
        .args_json(json!({
            "owner": owner.id(), "treasury": treasury, "contributors": contributors,
            "split_bps_contributors": 1000, "accepted_tokens": [token],
        }))
        .transact()
        .await?
        .into_result()?;
    register(token, s.id(), owner).await?;
    Ok(s)
}

async fn setup_with_delay(delay_sec: u64) -> anyhow::Result<Env> {
    let worker = common::sandbox().await?;
    let root = worker.root_account()?;
    let owner = sub(&root, "owner", 200).await?;
    let token = deploy_token(&owner, "usdc").await?;
    let treasury = sub(&owner, "treasury", 2).await?;
    let contributors = sub(&owner, "contributors", 2).await?;
    let splitter = deploy_splitter(&owner, "splitter", token.id(), treasury.id(), contributors.id()).await?;
    let fwd_acc = sub(&owner, "forwarder", 10).await?;
    let forwarder = fwd_acc.deploy(&wasm("FORWARDER_WASM", "nearbi_forwarder.wasm")).await?.into_result()?;
    forwarder
        .call("init")
        .args_json(json!({
            "owner": owner.id(), "splitter": splitter.id(), "token": token.id(),
            "agent": forwarder.id(), "change_delay_sec": delay_sec.to_string(),
        }))
        .transact()
        .await?
        .into_result()?;
    let oneclick = sub(&root, "oneclick", 10).await?;
    for who in [treasury.id(), contributors.id(), forwarder.id(), oneclick.id()] {
        register(token.id(), who, &owner).await?;
    }
    ft_transfer(token.id(), &owner, oneclick.id(), 10_000 * USDC).await?.into_result()?;

    let sk = SecretKey::from_random(KeyType::ED25519);
    forwarder
        .as_account()
        .batch(forwarder.id())
        .add_key(sk.public_key(), AccessKey::function_call_access(forwarder.id(), &["forward"], Some(NearToken::from_near(1))))
        .transact()
        .await?
        .into_result()?;
    let agent = Account::from_secret_key(forwarder.id().clone(), sk, &worker);
    Ok(Env { worker, owner, token, splitter, forwarder, treasury, contributors, oneclick, agent })
}

async fn setup() -> anyhow::Result<Env> {
    setup_with_delay(0).await
}

impl Env {
    async fn bal(&self, who: &AccountId) -> anyhow::Result<u128> {
        balance(self.token.id(), &self.worker, who).await
    }
    async fn forward_as(&self, signer: &Account, order_id: &str, amount: u128) -> anyhow::Result<ExecutionFinalResult> {
        Ok(signer
            .call(self.forwarder.id(), "forward")
            .args_json(json!({ "order_id": order_id, "amount": amount.to_string() }))
            .gas(FORWARD_GAS)
            .transact()
            .await?)
    }
    async fn owner_call(&self, contract: &AccountId, method: &str, args: Value) -> anyhow::Result<ExecutionFinalResult> {
        Ok(self.owner.call(contract, method).args_json(args).deposit(ONE_YOCTO).transact().await?)
    }
    async fn order(&self, id: &str) -> anyhow::Result<Value> {
        Ok(self.forwarder.view("get_order").args_json(json!({ "order_id": id })).await?.json()?)
    }
    async fn is_forwarded(&self, id: &str) -> anyhow::Result<bool> {
        Ok(self.forwarder.view("is_forwarded").args_json(json!({ "order_id": id })).await?.json()?)
    }
}

fn events(res: &ExecutionFinalResult, standard: &str, name: &str) -> Vec<Value> {
    res.logs()
        .iter()
        .filter_map(|l| l.strip_prefix("EVENT_JSON:"))
        .map(|j| serde_json::from_str::<Value>(j).unwrap())
        .filter(|v| v["standard"] == standard && v["event"] == name)
        .map(|v| v["data"][0].clone())
        .collect()
}

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

#[tokio::test]
async fn plain_transfer_then_forward_splits_exactly() -> anyhow::Result<()> {
    let e = setup().await?;
    // 1Click delivers with a plain ft_transfer: no code runs on the forwarder
    let res = ft_transfer(e.token.id(), &e.oneclick, e.forwarder.id(), PRICE).await?;
    assert!(res.is_success(), "{res:?}");
    assert_eq!(e.bal(e.forwarder.id()).await?, PRICE);

    let res = e.forward_as(&e.agent, "pay-0001", PRICE).await?;
    assert!(res.is_success(), "{res:?}");
    assert_eq!(res.clone().json::<String>()?, PRICE.to_string(), "callback returns used amount");
    let fw = events(&res, "nearbi_forwarder", "forwarded");
    assert_eq!(fw, vec![json!({ "order_id": "pay-0001", "amount": "49000000" })]);
    assert!(events(&res, "nearbi_forwarder", "forward_failed").is_empty());
    let sale = &events(&res, "nearbi_splitter", "sale")[0];
    assert_eq!(sale["order_id"], "pay-0001");
    assert_eq!(sale["payer"], e.forwarder.id().as_str());
    assert_eq!(sale["contributors_amount"], "4900000");
    assert_eq!(sale["treasury_amount"], "44100000");
    assert_eq!(events(&res, "nearbi_splitter", "payout").len(), 2);

    assert_eq!(e.bal(e.contributors.id()).await?, 4_900_000);
    assert_eq!(e.bal(e.treasury.id()).await?, 44_100_000);
    assert_eq!(e.bal(e.forwarder.id()).await?, 0);
    assert_eq!(e.bal(e.splitter.id()).await?, 0);
    assert!(e.is_forwarded("pay-0001").await?);
    let pending: Vec<Value> = e.forwarder.view("get_pending").args_json(json!({})).await?.json()?;
    assert!(pending.is_empty());
    let cfg: Value = e.forwarder.view("get_config").await?.json()?;
    assert_eq!(cfg["forwarded_count"], 1);
    assert_eq!(cfg["forwarded_total"], "49000000");
    Ok(())
}

#[tokio::test]
async fn double_forward_is_rejected() -> anyhow::Result<()> {
    let e = setup().await?;
    ft_transfer(e.token.id(), &e.oneclick, e.forwarder.id(), 2 * PRICE).await?.into_result()?;
    e.forward_as(&e.agent, "dup-1", PRICE).await?.into_result()?;
    let r = e.forward_as(&e.agent, "dup-1", PRICE).await;
    rejected("second forward (agent)", r, &["order already forwarded"]);
    let r = e.forward_as(&e.owner, "dup-1", PRICE).await;
    rejected("second forward (owner)", r, &["order already forwarded"]);
    // the second 49 stays in the forwarder; only one sale reached the splitter
    assert_eq!(e.bal(e.forwarder.id()).await?, PRICE);
    assert_eq!(e.bal(e.treasury.id()).await?, 44_100_000);
    let stats: Value = e.splitter.view("get_stats").await?.json()?;
    assert_eq!(stats[0]["sales"], 1);
    Ok(())
}

#[tokio::test]
async fn paused_splitter_keeps_funds_marks_retryable_and_retry_succeeds() -> anyhow::Result<()> {
    let e = setup().await?;
    ft_transfer(e.token.id(), &e.oneclick, e.forwarder.id(), PRICE).await?.into_result()?;
    e.owner_call(e.splitter.id(), "pause", json!({})).await?.into_result()?;

    let res = e.forward_as(&e.agent, "pay-paused", PRICE).await?;
    assert!(res.is_success(), "outer tx succeeds, callback records the refund: {res:?}");
    assert_eq!(res.clone().json::<String>()?, "0");
    assert_eq!(events(&res, "nearbi_splitter", "refund_paused").len(), 1);
    let ff = events(&res, "nearbi_forwarder", "forward_failed");
    assert_eq!(ff, vec![json!({ "order_id": "pay-paused", "amount": "49000000", "unused": "49000000" })]);
    assert_eq!(e.bal(e.forwarder.id()).await?, PRICE, "funds stay in the forwarder");
    assert_eq!(e.bal(e.treasury.id()).await?, 0);
    let o = e.order("pay-paused").await?;
    assert_eq!(o["status"], "retryable");
    assert_eq!(o["unused"], "49000000");
    assert!(!e.is_forwarded("pay-paused").await?);
    let pending: Vec<Value> = e.forwarder.view("get_pending").args_json(json!({})).await?.json()?;
    assert_eq!(pending.len(), 1);

    // retry with a different amount is refused
    let r = e.forward_as(&e.agent, "pay-paused", PRICE - 1).await;
    rejected("retry with other amount", r, &["retry amount must equal the recorded unused amount"]);

    e.owner_call(e.splitter.id(), "unpause", json!({})).await?.into_result()?;
    let res = e.forward_as(&e.agent, "pay-paused", PRICE).await?;
    assert!(res.is_success(), "{res:?}");
    assert_eq!(events(&res, "nearbi_forwarder", "forwarded").len(), 1);
    assert_eq!(e.bal(e.forwarder.id()).await?, 0);
    assert_eq!(e.bal(e.contributors.id()).await?, 4_900_000);
    assert_eq!(e.bal(e.treasury.id()).await?, 44_100_000);
    let o = e.order("pay-paused").await?;
    assert_eq!(o["status"], "forwarded");
    assert_eq!(o["attempts"], 2);
    assert!(e.is_forwarded("pay-paused").await?);
    Ok(())
}

#[tokio::test]
async fn forward_without_balance_fails_safely_and_is_retryable() -> anyhow::Result<()> {
    let e = setup().await?;
    // nothing delivered yet: the token panics, nothing moves, order is retryable
    let res = e.forward_as(&e.agent, "early", PRICE).await?;
    assert!(res.is_success(), "{res:?}");
    assert_eq!(events(&res, "nearbi_forwarder", "forward_failed")[0]["unused"], "49000000");
    assert_eq!(e.order("early").await?["status"], "retryable");
    ft_transfer(e.token.id(), &e.oneclick, e.forwarder.id(), PRICE).await?.into_result()?;
    e.forward_as(&e.agent, "early", PRICE).await?.into_result()?;
    assert!(e.is_forwarded("early").await?);
    assert_eq!(e.bal(e.treasury.id()).await?, 44_100_000);
    Ok(())
}

#[tokio::test]
async fn function_call_key_can_forward_but_not_administer() -> anyhow::Result<()> {
    let e = setup().await?;
    ft_transfer(e.token.id(), &e.oneclick, e.forwarder.id(), PRICE).await?.into_result()?;
    let res = e.forward_as(&e.agent, "fc-1", PRICE).await?;
    assert!(res.is_success(), "{res:?}");
    assert!(e.is_forwarded("fc-1").await?);

    let a = &e.agent;
    let f = e.forwarder.id();
    let r = a.call(f, "set_agent").args_json(json!({ "agent": "mallory.test.near" })).transact().await;
    rejected("set_agent", r, &["MethodNameMismatch"]);
    let r = a.call(f, "set_agent").args_json(json!({ "agent": "mallory.test.near" })).deposit(ONE_YOCTO).transact().await;
    rejected("set_agent with 1 yocto", r, &["DepositWithFunctionCall"]);
    for m in ["pause", "unpause", "accept_change", "cancel_change"] {
        let r = a.call(f, m).args_json(json!({})).transact().await;
        rejected(m, r, &["MethodNameMismatch"]);
    }
    let r = a.call(f, "propose_change").args_json(json!({ "field": "splitter", "value": "mallory.test.near" })).transact().await;
    rejected("propose_change", r, &["MethodNameMismatch"]);
    let r = a.call(f, "forward").args_json(json!({ "order_id": "fc-2", "amount": "1" })).deposit(ONE_YOCTO).gas(FORWARD_GAS).transact().await;
    rejected("forward with deposit", r, &["DepositWithFunctionCall"]);
    // signing as the forwarder towards the token is outside the key's receiver
    let r = a.call(e.token.id(), "ft_transfer").args_json(json!({ "receiver_id": e.owner.id(), "amount": "1" })).transact().await;
    rejected("ft_transfer as forwarder via FC key", r, &["ReceiverMismatch"]);
    let r = a.transfer_near(e.owner.id(), ONE_YOCTO).await;
    rejected("NEAR transfer", r, &["RequiresFullAccess"]);
    let r = a.batch(f).add_key(SecretKey::from_random(KeyType::ED25519).public_key(), AccessKey::full_access()).transact().await;
    rejected("add_key", r, &["RequiresFullAccess"]);

    let cfg: Value = e.forwarder.view("get_config").await?.json()?;
    assert_eq!(cfg["agent"], f.as_str());
    assert_eq!(cfg["paused"], false);
    assert!(cfg["pending_change"].is_null());
    Ok(())
}

/// Owner and agent try every way we could think of to get tokens anywhere but
/// the splitter. The only token flows must be oneclick -> forwarder -> splitter
/// -> (treasury, contributors).
#[tokio::test]
async fn no_path_sends_tokens_to_a_non_splitter() -> anyhow::Result<()> {
    let e = setup_with_delay(3600).await?;
    ft_transfer(e.token.id(), &e.oneclick, e.forwarder.id(), 3 * PRICE).await?.into_result()?;
    let owner0 = e.bal(e.owner.id()).await?;
    let f = e.forwarder.id().clone();

    // 1. forward with crafted extra args (receiver_id / splitter / token / msg): ignored
    for (who, signer) in [("owner", &e.owner), ("agent", &e.agent)] {
        let id = format!("crafted-{who}");
        let res = signer
            .call(&f, "forward")
            .args_json(json!({
                "order_id": id, "amount": PRICE.to_string(),
                "receiver_id": e.owner.id(), "splitter": e.owner.id(), "token": e.token.id(),
                "msg": "{\"order_id\":\"x\"}",
            }))
            .gas(FORWARD_GAS)
            .transact()
            .await?;
        // either near-sdk rejects unknown args or they are ignored; never redirected
        if res.is_success() {
            let sale = &events(&res, "nearbi_splitter", "sale")[0];
            assert_eq!(sale["order_id"], id.as_str());
        } else {
            eprintln!("crafted args rejected for {who}: {:?}", res.failures());
        }
    }
    // 2. an order_id that tries to inject JSON into msg is just an order id
    let evil = r#"x","receiver_id":"owner.test.near"#;
    let res = e.forward_as(&e.agent, evil, PRICE).await?;
    assert!(res.is_success(), "{res:?}");
    assert_eq!(events(&res, "nearbi_splitter", "sale")[0]["order_id"], evil);

    // 3. methods that do not exist on the forwarder
    for (who, signer) in [("owner", &e.owner), ("forwarder full-access", e.forwarder.as_account())] {
        for m in ["ft_transfer", "ft_transfer_call", "withdraw", "sweep", "storage_withdraw", "storage_unregister", "transfer", "upgrade", "migrate"] {
            let r = signer.call(&f, m)
                .args_json(json!({ "receiver_id": e.owner.id(), "amount": "1", "msg": "" }))
                .deposit(ONE_YOCTO).max_gas().transact().await;
            rejected(&format!("{who} calls forwarder.{m}"), r, &["MethodNotFound"]);
        }
    }
    // 4. the agent key can't reach the token at all
    let r = e.agent.call(e.token.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": e.owner.id(), "amount": "1", "msg": "" })).transact().await;
    rejected("agent ft_transfer_call on token", r, &["ReceiverMismatch"]);
    // 5. callback is private
    let r = e.owner.call(&f, "on_forward").args_json(json!({ "order_id": "crafted-owner", "amount": "1" })).transact().await;
    rejected("owner calls on_forward", r, &["Method on_forward is private"]);
    // 6. redirecting the splitter needs the public delay (3600 s here)
    let res = e.owner_call(&f, "propose_change", json!({ "field": "splitter", "value": e.owner.id() })).await?;
    assert!(res.is_success(), "{res:?}");
    assert_eq!(events(&res, "nearbi_forwarder", "change_proposed")[0]["field"], "splitter");
    let r = e.owner_call(&f, "accept_change", json!({})).await;
    rejected("accept before delay", r, &["change delay has not elapsed"]);
    // and during the delay forwards still go to the old splitter
    let cfg: Value = e.forwarder.view("get_config").await?.json()?;
    assert_eq!(cfg["splitter"], e.splitter.id().as_str());
    assert_eq!(cfg["pending_change"]["value"], e.owner.id().as_str());
    // 7. the agent can't propose either (contract check, full-access forwarder key as predecessor = agent)
    let r = e.forwarder.as_account().call(&f, "propose_change")
        .args_json(json!({ "field": "splitter", "value": e.owner.id() })).deposit(ONE_YOCTO).transact().await;
    rejected("agent account proposes", r, &["owner only"]);

    // net effect: owner never gained a token; every token ended in treasury/contributors
    assert_eq!(e.bal(e.owner.id()).await?, owner0);
    let fwd = e.bal(&f).await?;
    let paid = e.bal(e.treasury.id()).await? + e.bal(e.contributors.id()).await?;
    assert_eq!(fwd + paid, 3 * PRICE);
    assert_eq!(e.bal(e.splitter.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn ft_transfer_call_into_forwarder_is_accepted_only_for_the_token() -> anyhow::Result<()> {
    let e = setup().await?;
    let res = e.oneclick
        .call(e.token.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": e.forwarder.id(), "amount": PRICE.to_string(), "msg": "{\"order_id\":\"via-call\"}" }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?;
    assert!(res.is_success(), "{res:?}");
    assert_eq!(events(&res, "nearbi_forwarder", "received")[0]["amount"], "49000000");
    assert_eq!(e.bal(e.forwarder.id()).await?, PRICE, "kept, not refunded");

    let other = deploy_token(&e.owner, "other").await?;
    for who in [e.forwarder.id(), e.oneclick.id()] {
        register(other.id(), who, &e.owner).await?;
    }
    ft_transfer(other.id(), &e.owner, e.oneclick.id(), PRICE).await?.into_result()?;
    let res = e.oneclick
        .call(other.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": e.forwarder.id(), "amount": PRICE.to_string(), "msg": "" }))
        .deposit(ONE_YOCTO)
        .max_gas()
        .transact()
        .await?;
    assert!(format!("{:?}", res.receipt_failures()).contains("token not accepted"));
    assert_eq!(balance(other.id(), &e.worker, e.oneclick.id()).await?, PRICE, "refunded");
    assert_eq!(balance(other.id(), &e.worker, e.forwarder.id()).await?, 0);
    Ok(())
}

#[tokio::test]
async fn splitter_change_after_delay_redirects_only_to_the_new_splitter() -> anyhow::Result<()> {
    let e = setup().await?; // delay 0 (testnet demo setting)
    let t2 = sub(&e.owner, "treasury2", 2).await?;
    let c2 = sub(&e.owner, "contrib2", 2).await?;
    for who in [t2.id(), c2.id()] {
        register(e.token.id(), who, &e.owner).await?;
    }
    let s2 = deploy_splitter(&e.owner, "splitter2", e.token.id(), t2.id(), c2.id()).await?;
    let f = e.forwarder.id();
    let r = e.owner_call(f, "propose_change", json!({ "field": "splitter", "value": s2.id() })).await?;
    assert!(r.is_success(), "{r:?}");
    let r = e.owner_call(f, "accept_change", json!({})).await?;
    assert!(r.is_success(), "{r:?}");
    let ch = &events(&r, "nearbi_forwarder", "change_accepted")[0];
    assert_eq!(ch["old"], e.splitter.id().as_str());
    assert_eq!(ch["new"], s2.id().as_str());

    ft_transfer(e.token.id(), &e.oneclick, f, PRICE).await?.into_result()?;
    e.forward_as(&e.agent, "after-change", PRICE).await?.into_result()?;
    assert_eq!(e.bal(t2.id()).await?, 44_100_000);
    assert_eq!(e.bal(c2.id()).await?, 4_900_000);
    assert_eq!(e.bal(e.treasury.id()).await?, 0);

    // token change is blocked while an order is retryable
    e.owner_call(s2.id(), "pause", json!({})).await?.into_result()?;
    ft_transfer(e.token.id(), &e.oneclick, f, PRICE).await?.into_result()?;
    e.forward_as(&e.agent, "stuck", PRICE).await?.into_result()?;
    assert_eq!(e.order("stuck").await?["status"], "retryable");
    let r = e.owner_call(f, "propose_change", json!({ "field": "token", "value": "other.test.near" })).await;
    rejected("token change with open orders", r, &["cannot change token while orders are in flight or retryable"]);
    Ok(())
}

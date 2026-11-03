//! NearBI revenue splitter (ARCHITECTURE.md §3.1).
//!
//! Every sale arrives as a NEP-141 `ft_transfer_call` to this contract. In the
//! same `ft_on_transfer` call the amount is split by basis points and both
//! shares are sent out with `ft_transfer`, so payouts provably match the split.
//!
//! Split math (no dust): `contributors = floor(amount * bps / 10_000)`,
//! `treasury = amount - contributors`.
//!
//! Payout failure policy: RECORD, not refund. Once `ft_on_transfer` accepts the
//! tokens the sale is final for the customer. If a payout `ft_transfer` fails
//! (typically: recipient not storage-registered on the token), the callback
//! keeps the tokens in this contract, stores a `FailedPayout`, emits
//! `payout_failed`, and anyone can later call `retry_payout(id)`, which pays the
//! *originally recorded* recipient. Funds can never be redirected by a retry.
use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U64, U128};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, IterableSet};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PromiseError, PromiseOrValue,
    assert_one_yocto, env, near, require,
};

pub const EVENT_STANDARD: &str = "nearbi_splitter";
pub const EVENT_VERSION: &str = "1.0.0";
pub const BPS_DENOMINATOR: u128 = 10_000;
/// Upper bound for the contributors' share (50%).
pub const MAX_SPLIT_BPS_CONTRIBUTORS: u16 = 5_000;
pub const MAX_ORDER_ID_LEN: usize = 128;
pub const MAX_TEXT_LEN: usize = 256;

const GAS_FOR_FT_TRANSFER: Gas = Gas::from_tgas(10);
const GAS_FOR_ON_PAYOUT: Gas = Gas::from_tgas(10);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    AcceptedTokens,
    Stats,
    FailedPayouts,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Contributors,
    Treasury,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TokenStats {
    pub sales: u64,
    pub total_received: U128,
    pub contributors_amount: U128,
    pub treasury_amount: U128,
    /// Payout amounts currently held because an ft_transfer failed.
    pub pending_failed: U128,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FailedPayout {
    pub id: U64,
    pub order_id: String,
    pub token: AccountId,
    pub recipient: AccountId,
    pub role: Role,
    pub amount: U128,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub version: String,
    pub owner: AccountId,
    pub treasury: AccountId,
    pub contributors: AccountId,
    pub split_bps_contributors: u16,
    pub split_bps_treasury: u16,
    pub accepted_tokens: Vec<AccountId>,
    pub paused: bool,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TokenStatsView {
    pub token: AccountId,
    #[serde(flatten)]
    pub stats: TokenStats,
}

#[derive(Deserialize, Serialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct SaleMsg {
    order_id: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Splitter {
    owner: AccountId,
    treasury: AccountId,
    contributors: AccountId,
    split_bps_contributors: u16,
    accepted_tokens: IterableSet<AccountId>,
    paused: bool,
    stats: IterableMap<AccountId, TokenStats>,
    failed_payouts: IterableMap<u64, FailedPayout>,
    next_failure_id: u64,
}

/// Contributors' share: floor(amount * bps / 10_000), computed without overflow
/// for any u128 amount. Treasury gets the remainder, so the two always sum to
/// `amount` exactly.
pub fn split_amount(amount: u128, bps_contributors: u16) -> (u128, u128) {
    let bps = bps_contributors as u128;
    require!(bps <= BPS_DENOMINATOR, "bps out of range");
    let q = amount / BPS_DENOMINATOR;
    let r = amount % BPS_DENOMINATOR;
    let contributors = q * bps + (r * bps) / BPS_DENOMINATOR;
    (contributors, amount - contributors)
}

fn emit(event: &str, data: serde_json::Value) {
    let ev = json!({
        "standard": EVENT_STANDARD,
        "version": EVENT_VERSION,
        "event": event,
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{}", ev));
}

fn check_text(name: &str, value: &str, max: usize) {
    require!(!value.is_empty(), format!("{} must not be empty", name));
    require!(value.len() <= max, format!("{} too long (max {})", name, max));
}

#[near]
impl Splitter {
    #[init]
    pub fn init(
        owner: AccountId,
        treasury: AccountId,
        contributors: AccountId,
        split_bps_contributors: u16,
        accepted_tokens: Vec<AccountId>,
    ) -> Self {
        require!(
            split_bps_contributors <= MAX_SPLIT_BPS_CONTRIBUTORS,
            "split_bps_contributors must be in 0..=5000"
        );
        require!(treasury != contributors, "treasury and contributors must differ");
        let me = env::current_account_id();
        require!(owner != me, "owner must not be the splitter account itself");
        require!(treasury != me && contributors != me, "payout accounts must not be the splitter");
        let mut set = IterableSet::new(StorageKey::AcceptedTokens);
        for t in accepted_tokens {
            set.insert(t);
        }
        Self {
            owner,
            treasury,
            contributors,
            split_bps_contributors,
            accepted_tokens: set,
            paused: false,
            stats: IterableMap::new(StorageKey::Stats),
            failed_payouts: IterableMap::new(StorageKey::FailedPayouts),
            next_failure_id: 0,
        }
    }

    // ---------------------------------------------------------------- owner

    fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn config_changed(&self, field: &str, value: serde_json::Value) {
        emit("config_change", json!({ "field": field, "value": value, "by": env::predecessor_account_id() }));
    }

    /// Owner only, 1 yocto. Bounded to 0..=5000 bps.
    #[payable]
    pub fn set_split(&mut self, split_bps_contributors: u16) {
        self.assert_owner();
        require!(
            split_bps_contributors <= MAX_SPLIT_BPS_CONTRIBUTORS,
            "split_bps_contributors must be in 0..=5000"
        );
        self.split_bps_contributors = split_bps_contributors;
        self.config_changed("split_bps_contributors", json!(split_bps_contributors));
    }

    /// Owner only, 1 yocto. Any argument left out is unchanged.
    #[payable]
    pub fn set_accounts(
        &mut self,
        owner: Option<AccountId>,
        treasury: Option<AccountId>,
        contributors: Option<AccountId>,
    ) {
        self.assert_owner();
        let me = env::current_account_id();
        if let Some(o) = owner {
            require!(o != me, "owner must not be the splitter account itself");
            self.owner = o;
            self.config_changed("owner", json!(self.owner));
        }
        if let Some(t) = treasury {
            require!(t != me, "payout accounts must not be the splitter");
            self.treasury = t;
            self.config_changed("treasury", json!(self.treasury));
        }
        if let Some(c) = contributors {
            require!(c != me, "payout accounts must not be the splitter");
            self.contributors = c;
            self.config_changed("contributors", json!(self.contributors));
        }
        require!(self.treasury != self.contributors, "treasury and contributors must differ");
    }

    #[payable]
    pub fn add_token(&mut self, token: AccountId) {
        self.assert_owner();
        self.accepted_tokens.insert(token.clone());
        self.config_changed("add_token", json!(token));
    }

    #[payable]
    pub fn remove_token(&mut self, token: AccountId) {
        self.assert_owner();
        self.accepted_tokens.remove(&token);
        self.config_changed("remove_token", json!(token));
    }

    /// Kill switch: while paused every incoming transfer is refunded in full.
    #[payable]
    pub fn pause(&mut self) {
        self.assert_owner();
        self.paused = true;
        self.config_changed("paused", json!(true));
    }

    #[payable]
    pub fn unpause(&mut self) {
        self.assert_owner();
        self.paused = false;
        self.config_changed("paused", json!(false));
    }

    // ---------------------------------------------------------------- agent

    /// Only the splitter account itself (i.e. the agent's function-call key on
    /// this account) or the owner may write ledger events.
    fn assert_agent(&self) {
        let p = env::predecessor_account_id();
        require!(p == env::current_account_id() || p == self.owner, "agent or owner only");
    }

    /// Emits a `cost` event. No state change, no deposit (not payable).
    pub fn record_cost(&mut self, kind: String, amount_usd_micros: U64, r#ref: String) {
        self.assert_agent();
        check_text("kind", &kind, 64);
        check_text("ref", &r#ref, MAX_TEXT_LEN);
        emit(
            "cost",
            json!({ "kind": kind, "amount_usd_micros": amount_usd_micros, "ref": r#ref }),
        );
    }

    /// Emits a `report_anchor` event. `manifest_sha256` must be 64 lowercase hex chars.
    pub fn anchor_report(&mut self, slug: String, manifest_sha256: String) {
        self.assert_agent();
        check_text("slug", &slug, MAX_ORDER_ID_LEN);
        require!(
            manifest_sha256.len() == 64
                && manifest_sha256.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "manifest_sha256 must be 64 lowercase hex chars"
        );
        emit("report_anchor", json!({ "slug": slug, "manifest_sha256": manifest_sha256 }));
    }

    // -------------------------------------------------------------- payouts

    fn send_payout(
        &self,
        token: &AccountId,
        recipient: &AccountId,
        role: Role,
        amount: u128,
        order_id: &str,
    ) {
        ext_ft_core::ext(token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER)
            .ft_transfer(recipient.clone(), U128(amount), Some(format!("nearbi:{}", order_id)))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_PAYOUT)
                    .on_payout(
                        token.clone(),
                        recipient.clone(),
                        role,
                        U128(amount),
                        order_id.to_string(),
                    ),
            )
            .detach();
    }

    #[private]
    pub fn on_payout(
        &mut self,
        token: AccountId,
        recipient: AccountId,
        role: Role,
        amount: U128,
        order_id: String,
    ) -> bool {
        let ok = !matches!(env::promise_result_checked(0, 256), Err(PromiseError::Failed));
        if ok {
            emit(
                "payout",
                json!({ "order_id": order_id, "token": token, "recipient": recipient, "role": role, "amount": amount }),
            );
            return true;
        }
        let id = self.next_failure_id;
        self.next_failure_id += 1;
        let mut s = self.stats.get(&token).cloned().unwrap_or_default();
        s.pending_failed = U128(s.pending_failed.0 + amount.0);
        self.stats.insert(token.clone(), s);
        self.failed_payouts.insert(
            id,
            FailedPayout {
                id: U64(id),
                order_id: order_id.clone(),
                token: token.clone(),
                recipient: recipient.clone(),
                role,
                amount,
            },
        );
        emit(
            "payout_failed",
            json!({ "id": U64(id), "order_id": order_id, "token": token, "recipient": recipient, "role": role, "amount": amount }),
        );
        false
    }

    /// Re-send a failed payout to its originally recorded recipient. Anyone may
    /// call it (e.g. after the recipient registers storage on the token). The
    /// record is removed first; if the transfer fails again a new record is made.
    pub fn retry_payout(&mut self, id: U64) {
        let fp = self
            .failed_payouts
            .remove(&id.0)
            .unwrap_or_else(|| env::panic_str("no such failed payout"));
        let mut s = self.stats.get(&fp.token).cloned().unwrap_or_default();
        s.pending_failed = U128(s.pending_failed.0 - fp.amount.0);
        self.stats.insert(fp.token.clone(), s);
        emit("payout_retry", json!({ "id": id, "order_id": fp.order_id }));
        self.send_payout(&fp.token, &fp.recipient, fp.role, fp.amount.0, &fp.order_id);
    }

    // ---------------------------------------------------------------- views

    pub fn get_config(&self) -> Config {
        Config {
            version: env!("CARGO_PKG_VERSION").to_string(),
            owner: self.owner.clone(),
            treasury: self.treasury.clone(),
            contributors: self.contributors.clone(),
            split_bps_contributors: self.split_bps_contributors,
            split_bps_treasury: (BPS_DENOMINATOR as u16) - self.split_bps_contributors,
            accepted_tokens: self.accepted_tokens.iter().cloned().collect(),
            paused: self.paused,
        }
    }

    pub fn get_stats(&self) -> Vec<TokenStatsView> {
        self.stats
            .iter()
            .map(|(token, stats)| TokenStatsView { token: token.clone(), stats: stats.clone() })
            .collect()
    }

    pub fn get_failed_payouts(&self) -> Vec<FailedPayout> {
        self.failed_payouts.values().cloned().collect()
    }
}

#[near]
impl FungibleTokenReceiver for Splitter {
    /// `msg` = `{"order_id": "..."}`. Panicking here makes the FT contract
    /// refund the payer in full (NEP-141 `ft_resolve_transfer`).
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        require!(self.accepted_tokens.contains(&token), "token not accepted");
        if self.paused {
            // Kill switch: return everything as unused -> FT standard refunds payer.
            emit("refund_paused", json!({ "token": token, "payer": sender_id, "amount": amount }));
            return PromiseOrValue::Value(amount);
        }
        let parsed: SaleMsg = serde_json::from_str(&msg)
            .unwrap_or_else(|_| env::panic_str(r#"msg must be JSON {"order_id": "..."}"#));
        check_text("order_id", &parsed.order_id, MAX_ORDER_ID_LEN);
        require!(amount.0 > 0, "amount must be positive");

        let (c_amt, t_amt) = split_amount(amount.0, self.split_bps_contributors);

        let mut s = self.stats.get(&token).cloned().unwrap_or_default();
        s.sales += 1;
        s.total_received = U128(s.total_received.0 + amount.0);
        s.contributors_amount = U128(s.contributors_amount.0 + c_amt);
        s.treasury_amount = U128(s.treasury_amount.0 + t_amt);
        self.stats.insert(token.clone(), s);

        emit(
            "sale",
            json!({
                "order_id": parsed.order_id,
                "payer": sender_id,
                "token": token,
                "amount": amount,
                "contributors_amount": U128(c_amt),
                "treasury_amount": U128(t_amt),
                "split_bps_contributors": self.split_bps_contributors,
            }),
        );

        // ft_transfer of 0 is rejected by NEP-141, so skip empty shares.
        if c_amt > 0 {
            self.send_payout(&token, &self.contributors.clone(), Role::Contributors, c_amt, &parsed.order_id);
        }
        if t_amt > 0 {
            self.send_payout(&token, &self.treasury.clone(), Role::Treasury, t_amt, &parsed.order_id);
        }
        PromiseOrValue::Value(U128(0))
    }
}

#[cfg(test)]
mod tests;

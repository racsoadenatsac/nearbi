//! NearBI settlement forwarder.
//!
//! NEAR Intents 1Click delivers each subscription payment as a plain NEP-141
//! `ft_transfer` of USDC to a settlement account. This contract IS that
//! settlement account. It holds the funds and has exactly one way to move them:
//!
//! ```text
//! token.ft_transfer_call(receiver_id = splitter, amount, msg = {"order_id": …})
//! ```
//!
//! # Invariant: tokens can only leave into the splitter
//!
//! * The only outgoing token call this code can make is `ft_transfer_call` on
//!   the configured `token`, and its `receiver_id` is always the configured
//!   `splitter` read from state, never from call arguments (`send_to_splitter`).
//! * There is no `ft_transfer`, `storage_withdraw`, NEAR transfer, withdraw,
//!   sweep, upgrade, or arbitrary-call method. The only other promises the
//!   contract creates are callbacks to itself (`on_forward`).
//! * `splitter` and `token` can only change through a public, time-delayed
//!   two-step `propose_change` / `accept_change` (`change_delay_sec`, fixed at
//!   init: 24 h on mainnet, 0 for the testnet demo). Both steps emit events.
//!
//! This holds for the CODE. Whoever holds a full-access key of the forwarder
//! account can deploy different code or sign `ft_transfer` as the account
//! directly; in production those keys must be deleted (or held by a custody
//! with its own controls). See README "Forwarder trust model".
//!
//! # Order lifecycle (per `order_id`)
//!
//! `forward` → `InFlight` → callback `on_forward`:
//! * splitter used the full amount → `Forwarded` (terminal; `is_forwarded` = true)
//! * anything unused (splitter paused/panicked → the FT standard refunds the
//!   forwarder) or the transfer call failed → `Retryable {unused}`; the funds
//!   stay here and `forward(order_id, unused)` retries.
//!
//! A second `forward` for an `InFlight` or `Forwarded` order panics.
use near_contract_standards::fungible_token::core::ext_ft_core;
use near_contract_standards::fungible_token::receiver::FungibleTokenReceiver;
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{
    AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue, assert_one_yocto, env, near, require,
};

pub const EVENT_STANDARD: &str = "nearbi_forwarder";
pub const EVENT_VERSION: &str = "1.0.0";
/// Same bound the splitter enforces on `order_id`.
pub const MAX_ORDER_ID_LEN: usize = 128;
/// Mainnet default for the splitter/token/owner change delay.
pub const DEFAULT_CHANGE_DELAY_SEC: u64 = 24 * 60 * 60;
pub const MAX_CHANGE_DELAY_SEC: u64 = 30 * 24 * 60 * 60;

/// Static gas for the token's `ft_transfer_call`; it also gets all unused gas
/// (weight 1). The token forwards its leftover to the splitter's
/// `ft_on_transfer`, which needs ~45 Tgas for two payouts + callbacks.
pub const GAS_FOR_FT_TRANSFER_CALL: Gas = Gas::from_tgas(100);
pub const GAS_FOR_ON_FORWARD: Gas = Gas::from_tgas(15);
/// `forward` refuses to start with less prepaid gas, so the callback always runs.
pub const MIN_PREPAID_GAS_FOR_FORWARD: Gas = Gas::from_tgas(130);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Orders,
    Open,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrderStatus {
    /// `ft_transfer_call` sent, callback not yet run.
    InFlight,
    /// The splitter accepted the full amount. Terminal.
    Forwarded,
    /// Refunded or failed; `unused` is back in the forwarder and can be re-forwarded.
    Retryable,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Order {
    pub order_id: String,
    pub status: OrderStatus,
    /// Amount of the current/last attempt.
    pub amount: U128,
    /// Total the splitter has accepted for this order.
    pub forwarded_amount: U128,
    /// For `Retryable`: amount that came back and must be retried.
    pub unused: U128,
    pub attempts: u32,
    pub updated_at_ns: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ChangeField {
    Splitter,
    Token,
    Owner,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingChange {
    pub field: ChangeField,
    pub value: AccountId,
    pub proposed_at_ns: U64,
    /// Earliest block timestamp at which `accept_change` succeeds.
    pub eta_ns: U64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub version: String,
    pub owner: AccountId,
    pub splitter: AccountId,
    pub token: AccountId,
    pub agent: AccountId,
    pub paused: bool,
    pub change_delay_sec: U64,
    pub pending_change: Option<PendingChange>,
    pub forwarded_count: u64,
    pub forwarded_total: U128,
    pub open_orders: u32,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Forwarder {
    owner: AccountId,
    splitter: AccountId,
    token: AccountId,
    agent: AccountId,
    paused: bool,
    change_delay_ns: u64,
    pending_change: Option<PendingChange>,
    orders: LookupMap<String, Order>,
    /// order ids that are InFlight or Retryable
    open: IterableSet<String>,
    forwarded_count: u64,
    forwarded_total: u128,
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

fn check_order_id(order_id: &str) {
    require!(!order_id.is_empty(), "order_id must not be empty");
    require!(order_id.len() <= MAX_ORDER_ID_LEN, "order_id too long (max 128)");
}

#[near]
impl Forwarder {
    /// `change_delay_sec` defaults to 24 h. It is fixed for the life of the
    /// contract, so the owner can't shorten the delay before a redirection.
    #[init]
    pub fn init(
        owner: AccountId,
        splitter: AccountId,
        token: AccountId,
        agent: AccountId,
        change_delay_sec: Option<U64>,
    ) -> Self {
        let me = env::current_account_id();
        require!(owner != me, "owner must not be the forwarder account itself");
        Self::check_splitter(&splitter, &token);
        let delay = change_delay_sec.map(|d| d.0).unwrap_or(DEFAULT_CHANGE_DELAY_SEC);
        require!(delay <= MAX_CHANGE_DELAY_SEC, "change_delay_sec too large (max 30 days)");
        emit(
            "init",
            json!({ "owner": owner, "splitter": splitter, "token": token, "agent": agent, "change_delay_sec": U64(delay) }),
        );
        Self {
            owner,
            splitter,
            token,
            agent,
            paused: false,
            change_delay_ns: delay * 1_000_000_000,
            pending_change: None,
            orders: LookupMap::new(StorageKey::Orders),
            open: IterableSet::new(StorageKey::Open),
            forwarded_count: 0,
            forwarded_total: 0,
        }
    }

    fn check_splitter(splitter: &AccountId, token: &AccountId) {
        let me = env::current_account_id();
        require!(*splitter != me, "splitter must not be the forwarder itself");
        require!(*token != me, "token must not be the forwarder itself");
        require!(splitter != token, "splitter and token must differ");
    }

    // ------------------------------------------------------------ forwarding

    fn assert_agent_or_owner(&self) {
        let p = env::predecessor_account_id();
        require!(p == self.agent || p == self.owner, "agent or owner only");
    }

    /// Send `amount` of the configured token into the configured splitter with
    /// `msg = {"order_id": order_id}`. Agent or owner; no deposit (a
    /// function-call key can call it). A `Retryable` order is retried with
    /// `amount` equal to its recorded `unused`.
    pub fn forward(&mut self, order_id: String, amount: U128) -> Promise {
        self.assert_agent_or_owner();
        require!(!self.paused, "forwarder is paused");
        check_order_id(&order_id);
        require!(amount.0 > 0, "amount must be positive");
        require!(
            env::prepaid_gas() >= MIN_PREPAID_GAS_FOR_FORWARD,
            "attach at least 130 Tgas so the callback can record the result"
        );
        let now = U64(env::block_timestamp());
        let order = match self.orders.get(&order_id) {
            None => Order {
                order_id: order_id.clone(),
                status: OrderStatus::InFlight,
                amount,
                forwarded_amount: U128(0),
                unused: U128(0),
                attempts: 1,
                updated_at_ns: now,
            },
            Some(o) => match o.status {
                OrderStatus::Forwarded => env::panic_str("order already forwarded"),
                OrderStatus::InFlight => env::panic_str("order forward already in flight"),
                OrderStatus::Retryable => {
                    require!(amount == o.unused, "retry amount must equal the recorded unused amount");
                    Order {
                        status: OrderStatus::InFlight,
                        amount,
                        unused: U128(0),
                        attempts: o.attempts + 1,
                        updated_at_ns: now,
                        ..o.clone()
                    }
                }
            },
        };
        let attempt = order.attempts;
        self.orders.insert(order_id.clone(), order);
        self.open.insert(order_id.clone());
        emit(
            "forward_started",
            json!({
                "order_id": order_id, "amount": amount, "attempt": attempt,
                "splitter": self.splitter, "token": self.token, "by": env::predecessor_account_id(),
            }),
        );
        self.send_to_splitter(order_id, amount)
    }

    /// THE ONLY place tokens leave this contract. Receiver = `self.splitter`.
    fn send_to_splitter(&self, order_id: String, amount: U128) -> Promise {
        let msg = json!({ "order_id": order_id }).to_string();
        ext_ft_core::ext(self.token.clone())
            .with_attached_deposit(ONE_YOCTO)
            .with_static_gas(GAS_FOR_FT_TRANSFER_CALL)
            .with_unused_gas_weight(1)
            .ft_transfer_call(self.splitter.clone(), amount, None, msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_ON_FORWARD)
                    .with_unused_gas_weight(0)
                    .on_forward(order_id, amount),
            )
    }

    /// Result of `ft_transfer_call` = amount the splitter used (NEP-141
    /// `ft_resolve_transfer`). Unused tokens are already back in this account.
    #[private]
    pub fn on_forward(&mut self, order_id: String, amount: U128) -> U128 {
        let used: u128 = match env::promise_result_checked(0, 64) {
            Ok(bytes) => serde_json::from_slice::<U128>(&bytes).map(|u| u.0).unwrap_or(0),
            // The token call panicked before moving anything (e.g. balance
            // too low, forwarder not registered): nothing left the account.
            Err(PromiseError::Failed) => 0,
            Err(_) => 0,
        };
        let used = used.min(amount.0);
        let unused = amount.0 - used;
        let mut o = self
            .orders
            .get(&order_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("unknown order"));
        o.forwarded_amount = U128(o.forwarded_amount.0 + used);
        o.updated_at_ns = U64(env::block_timestamp());
        if used > 0 {
            self.forwarded_total += used;
        }
        if unused == 0 {
            o.status = OrderStatus::Forwarded;
            o.unused = U128(0);
            self.open.remove(&order_id);
            self.forwarded_count += 1;
            emit("forwarded", json!({ "order_id": order_id, "amount": amount }));
        } else {
            o.status = OrderStatus::Retryable;
            o.unused = U128(unused);
            emit(
                "forward_failed",
                json!({ "order_id": order_id, "amount": amount, "unused": U128(unused) }),
            );
        }
        self.orders.insert(order_id, o);
        U128(used)
    }

    // ----------------------------------------------------------------- owner

    fn assert_owner(&self) {
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    fn config_changed(&self, field: &str, value: serde_json::Value) {
        emit("config_change", json!({ "field": field, "value": value, "by": env::predecessor_account_id() }));
    }

    /// Owner, 1 yocto. The agent can only ever call `forward`, so this is
    /// immediate.
    #[payable]
    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        self.agent = agent;
        self.config_changed("agent", json!(self.agent));
    }

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

    /// Step 1 of a splitter/token/owner change. Owner, 1 yocto. Public via the
    /// `change_proposed` event and `get_config().pending_change`. One change at
    /// a time; cancel first to propose another.
    #[payable]
    pub fn propose_change(&mut self, field: ChangeField, value: AccountId) {
        self.assert_owner();
        require!(self.pending_change.is_none(), "a change is already pending; cancel it first");
        self.validate_change(field, &value);
        let now = env::block_timestamp();
        let pc = PendingChange {
            field,
            value,
            proposed_at_ns: U64(now),
            eta_ns: U64(now + self.change_delay_ns),
        };
        emit(
            "change_proposed",
            json!({ "field": pc.field, "value": pc.value, "eta_ns": pc.eta_ns, "delay_sec": U64(self.change_delay_ns / 1_000_000_000) }),
        );
        self.pending_change = Some(pc);
    }

    /// Step 2. Owner, 1 yocto, only once `eta_ns` has passed.
    #[payable]
    pub fn accept_change(&mut self) {
        self.assert_owner();
        let pc = self.pending_change.clone().unwrap_or_else(|| env::panic_str("no pending change"));
        require!(env::block_timestamp() >= pc.eta_ns.0, "change delay has not elapsed");
        self.validate_change(pc.field, &pc.value);
        let old = match pc.field {
            ChangeField::Splitter => std::mem::replace(&mut self.splitter, pc.value.clone()),
            ChangeField::Token => std::mem::replace(&mut self.token, pc.value.clone()),
            ChangeField::Owner => std::mem::replace(&mut self.owner, pc.value.clone()),
        };
        self.pending_change = None;
        emit("change_accepted", json!({ "field": pc.field, "old": old, "new": pc.value }));
    }

    #[payable]
    pub fn cancel_change(&mut self) {
        self.assert_owner();
        let pc = self.pending_change.take().unwrap_or_else(|| env::panic_str("no pending change"));
        emit("change_cancelled", json!({ "field": pc.field, "value": pc.value }));
    }

    fn validate_change(&self, field: ChangeField, value: &AccountId) {
        match field {
            ChangeField::Splitter => Self::check_splitter(value, &self.token),
            ChangeField::Token => {
                Self::check_splitter(&self.splitter, value);
                // Open orders hold balances of the current token; switching
                // would strand them, so drain (forward) them first.
                require!(self.open.is_empty(), "cannot change token while orders are in flight or retryable");
            }
            ChangeField::Owner => {
                require!(*value != env::current_account_id(), "owner must not be the forwarder account itself")
            }
        }
    }

    // ----------------------------------------------------------------- views

    pub fn get_config(&self) -> Config {
        Config {
            version: env!("CARGO_PKG_VERSION").to_string(),
            owner: self.owner.clone(),
            splitter: self.splitter.clone(),
            token: self.token.clone(),
            agent: self.agent.clone(),
            paused: self.paused,
            change_delay_sec: U64(self.change_delay_ns / 1_000_000_000),
            pending_change: self.pending_change.clone(),
            forwarded_count: self.forwarded_count,
            forwarded_total: U128(self.forwarded_total),
            open_orders: self.open.len(),
        }
    }

    /// True only once the splitter accepted the full amount.
    pub fn is_forwarded(&self, order_id: String) -> bool {
        matches!(self.orders.get(&order_id), Some(o) if o.status == OrderStatus::Forwarded)
    }

    pub fn get_order(&self, order_id: String) -> Option<Order> {
        self.orders.get(&order_id).cloned()
    }

    /// Orders not yet confirmed: `in_flight` and `retryable` (paged).
    pub fn get_pending(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<Order> {
        self.open
            .iter()
            .skip(from_index.unwrap_or(0) as usize)
            .take(limit.unwrap_or(100) as usize)
            .filter_map(|id| self.orders.get(id).cloned())
            .collect()
    }
}

#[near]
impl FungibleTokenReceiver for Forwarder {
    /// Plain `ft_transfer` deliveries need no code. If a sender uses
    /// `ft_transfer_call` instead, accept everything (return 0) for the
    /// configured token; any other token panics so its contract refunds the sender.
    fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        require!(token == self.token, "token not accepted");
        let msg: String = msg.chars().take(256).collect();
        emit("received", json!({ "sender": sender_id, "amount": amount, "msg": msg }));
        PromiseOrValue::Value(U128(0))
    }
}

#[cfg(test)]
mod tests;

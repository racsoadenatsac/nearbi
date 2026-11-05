# rs-payments

NearBI's payment rail: the onchain revenue splitter contract (v0.1.0-testnet) and the
settlement forwarder for NEAR Intents 1Click deliveries (v0.2.0-testnet, §7). Part of the NEAR Hackathon one-agent
research shop; design in `rs-docs/ARCHITECTURE.md` §3.1.

> **Mainnet (since 2026-11-03):** `splitter.nearbi.near` + `forwarder.nearbi.near`, real USDC, both
> locked (no full-access keys). See §8. Everything in §3–§7 and all demos run on NEAR **testnet** with a
> mock token (`usdc-mock`, no value).

## 1. Architecture

```
customer ──ft_transfer_call(49 USDCm, msg={"order_id":…})──▶ usdc-mock (NEP-141)
                                                               │ ft_on_transfer
                                                               ▼
                                                splitter.nearbi-agent.testnet
                     ┌──────────── same receipt ───────────────┤ emits EVENT_JSON sale
       ft_transfer 1y│                                         │ft_transfer 1y
                     ▼                                         ▼
     contributors.nearbi-agent.testnet  (floor share)   treasury.nearbi-agent.testnet (remainder)
                     │ on_payout callback                      │ on_payout callback
                     └── payout / payout_failed events ────────┘

agent (function-call key on splitter, no deposits) ──▶ record_cost / anchor_report ──▶ events only
operator (owner = nearbi-agent.testnet, full-access, 1 yocto) ──▶ set_split / set_accounts / tokens / pause
```

* **Payouts are enforced by the contract.** In `ft_on_transfer` the amount is split
  by basis points and both shares leave in the same call. The agent never touches
  sale proceeds and cannot skim, delay or forget a payout.
* **Split math, no dust:** `contributors = floor(amount × bps / 10 000)` (computed as
  `q·bps + r·bps/10 000` so it can't overflow u128), `treasury = amount − contributors`.
  49.000000 at 1000 bps → 4.900000 / 44.100000. A zero share is skipped (NEP-141
  rejects 0-amount transfers).
* **Only accepted tokens.** A transfer from any other token contract panics in
  `ft_on_transfer`, so the token's `ft_resolve_transfer` refunds the payer in full.
* **Kill switch.** While `paused`, `ft_on_transfer` returns the full amount as unused
  and the FT standard refunds the payer. No sale event is emitted (`refund_paused` is).
* **Payout failure policy: record, not refund.** Once the splitter accepts a payment the
  sale is final for the customer. If a payout `ft_transfer` fails (typically the
  recipient isn't storage-registered on the token), the `on_payout` callback keeps the
  tokens in the splitter, stores a `FailedPayout {id, order_id, token, recipient, role,
  amount}`, adds it to `get_stats().pending_failed` and emits `payout_failed`.
  Anyone can call `retry_payout(id)`; it always pays the **originally recorded**
  recipient (a retry can't redirect funds), and a repeat failure is recorded again.
  Why not refund: refunding a share would leave the customer with a half-paid order
  and the ledger with a sale that doesn't match its payouts.

### Contract interface (`contracts/splitter`)

| Method | Who | Notes |
|---|---|---|
| `init(owner, treasury, contributors, split_bps_contributors, accepted_tokens)` | deployer | bps ≤ 5000; owner ≠ splitter account |
| `ft_on_transfer(sender_id, amount, msg)` | accepted token contracts | `msg = {"order_id": "…"}` (1–128 chars) |
| `set_split(split_bps_contributors)` | owner, 1 yocto | 0..=5000 |
| `set_accounts(owner?, treasury?, contributors?)` | owner, 1 yocto | treasury ≠ contributors |
| `add_token(token)` / `remove_token(token)` | owner, 1 yocto | the splitter must also be storage-registered on a new token |
| `pause()` / `unpause()` | owner, 1 yocto | kill switch |
| `record_cost(kind, amount_usd_micros, ref)` | splitter account itself (agent FC key) or owner; no deposit | event only |
| `anchor_report(slug, manifest_sha256)` | same | 64 lowercase hex; event only |
| `retry_payout(id)` | anyone | pays the recorded recipient |
| `get_config()`, `get_stats()`, `get_failed_payouts()` | view | stats are per token |

Owner methods require exactly 1 yoctoNEAR, which a function-call key can never attach,
so they always need a full-access key of the owner account.

### Events (NEP-297, `standard: "nearbi_splitter"`, `version: "1.0.0"`, `data: [ {…} ]`)

`sale {order_id, payer, token, amount, contributors_amount, treasury_amount, split_bps_contributors}`,
`payout {order_id, token, recipient, role, amount}`, `payout_failed {id, order_id, token, recipient, role, amount}`,
`payout_retry {id, order_id}`, `refund_paused {token, payer, amount}`,
`cost {kind, amount_usd_micros, ref}`, `report_anchor {slug, manifest_sha256}`,
`config_change {field, value, by}`. Amounts are decimal strings (U128).

## 2. Build (reproducible) and test

Rust is **not** installed on the host; all Rust tooling runs in Docker.

| Purpose | Image |
|---|---|
| Release WASM | `sourcescan/cargo-near:0.22.0-rust-1.97.1@sha256:7467038b…` (linux/amd64), pinned in each contract's `[package.metadata.near.reproducible_build]` |
| Unit + sandbox tests | `docker/dev.Dockerfile`: `rust:1.97.1-trixie` (digest-pinned) + cargo-near 0.22.0 (sha256-checked) |

Contracts use **near-sdk 5.29.1** (not 5.30), see "Protocol compatibility" below; sandbox tests use
near-workspaces 0.23.0 with a nearcore 2.13.4 sandbox (protocol 86, same as mainnet).

```bash
bin/build.sh                       # exports git HEAD, builds splitter, forwarder, mock-ft in the pinned image
cat res/*.sha256 res/BUILD_COMMIT  # committed checksums
bin/dev.sh cargo test -p nearbi-splitter        # unit tests
bin/dev.sh cargo test -p nearbi-forwarder       # forwarder unit tests
bin/dev.sh cargo test -p integration-tests      # near-workspaces sandbox tests (uses res/*.wasm)
```

`bin/build.sh` only builds committed code (it `git archive`s HEAD), runs the crate's
`container_build_command` (`cargo near build non-reproducible-wasm --locked`) inside
the digest-pinned image, and writes `res/<crate>.wasm` + `.sha256`. That's what
`cargo near build reproducible-wasm` does internally, so SourceScan-style verifiers get
the same bytes. The deploy script checks that the on-chain `code_hash`
(base58 of sha256) equals the local WASM.

Determinism check (2026-11-03): a second clean `bin/build.sh` from a later commit with
identical contract sources produced byte-identical files: `nearbi_splitter.wasm`
sha256 `193b1516326f09dafd3d6d1364cf085891ea4a021335184e3a83bad4f2b1fc13`, `usdc_mock.wasm`
sha256 `1a380d783c16f3f3c9460707254b0cd0e6d366a079584c99cfc663391548ec01`, the same bytes that
are deployed. On an Apple-silicon host the amd64 image runs under QEMU and takes about 10–12 min
for both contracts. One attempt hung (cargo idle at 0 % CPU) and had to be killed and re-run.

Test counts (2026-11-03, against the release WASM in `res/`): unit 21 (splitter) + 36 (forwarder),
sandbox 6 (splitter) + 8 (forwarder), all passing. The v0.2.0 rebuild (commit `28a65eb`, which adds the
forwarder) reproduced `nearbi_splitter.wasm` and `usdc_mock.wasm` byte for byte (same sha256 as above);
the first attempt hung under QEMU again and was killed and re-run.

### Protocol compatibility

Mainnet ran **protocol 86** on 2026-11-03 (testnet already 88). A host function the network doesn't
provide makes `deploy` fail with `Link Error: unknown or invalid import`, and the deploy+init tx is
rolled back. That happened with the v0.2.0 WASMs:

* near-sdk **5.30.0** (near-sys ≥ 0.3.0) added `Promise::universal_state_init`, and its action
  dispatcher links `env.promise_batch_action_universal_state_init` into **every** contract that builds
  a promise. That host function exists only from protocol 88 (`universal_accounts`). There is no
  feature flag to drop it. All other imports (incl. gas-key and global-contract actions) are enabled on
  86 (`gas_key_host_fns` since 85, `global_contract_host_fns` since 78, per mainnet
  `EXPERIMENTAL_protocol_config`).
* Fix: `near-sdk`/`near-contract-standards` `=5.29.1` (near-sys 0.2.14, near-sdk-env locked at 0.1.6;
  near-sdk-env 0.1.8 would pull near-sys 0.4.0 back in). Same cargo-near 0.22.0 / rust 1.97.1 image.
* Guard rails: `bin/wasm-imports.py` lists a WASM's imports; `bin/build.sh` fails if any import is in
  `bin/denied-imports-protocol-86.txt` (universal-account, sha3 and ml-dsa host fns, sandbox/test fns).
  `integration-tests/tests/common` runs every sandbox test on nearcore **2.13.4** and asserts protocol 86
  (`NEARBI_SANDBOX_VERSION` / `NEARBI_SANDBOX_PROTOCOL` to change it when mainnet upgrades). The old
  5.30 WASMs fail all 14 sandbox tests there with the same Link Error.
* Gas on mainnet: while a tx runs, its prepaid gas is **held** from the signer's balance (and from a
  function-call key's allowance) at 1e9 yocto/gas, ten times the ~1e8 actually charged. A deploy+init
  with 100 Tgas on `init` therefore failed with `LackBalanceForState` (short 0.02594 NEAR). `init` burns
  ~1.9 Tgas; `bin/deploy-mainnet.sh` attaches 10 Tgas and checks the balance before broadcasting.

Release artifacts (built from `0b921bb`, rebuilt from a clean worktree byte for byte):

| WASM | bytes | sha256 | code_hash |
|---|---:|---|---|
| `nearbi_splitter.wasm` | 205 443 | `a204827262d123224b6a286d34921ef7348ee58f100a9d5dc37b9b76d20b648c` | `BuT33o2VKMCx1rhxfZSYSsL5jWVfFjZNsv5xGSMV7YQB` |
| `nearbi_forwarder.wasm` | 182 812 | `631ecec5011e039d55075e05b4726da7895ac96627a476452809f904ee998ea5` | `7fvcJC7FEwcM4oz4E1UWQ8EuPfh2P8vvVw6GBGLpaEK6` |
| `usdc_mock.wasm` | 153 505 | `d6403cbcb2dad34ab7b6ccf1ec1ad7a03609c723822faa1daaedb100bfe27671` | (testnet v2 reuses the v1 token) |

Tests against these (2026-11-03, protocol-86 sandbox): unit 21 + 36, sandbox 6 + 8, all passing.
The v1 testnet contracts (`splitter.`/`forwarder.nearbi-agent.testnet`, §3/§7) still run the near-sdk 5.30
build; the new build runs side by side as `splitter-v2.` / `forwarder-v2.nearbi-agent.testnet`
(`deploy/testnet-v2.json`, demos `docs/demo-v2-run-2026-11-03T1639Z.txt` 37 s and
`docs/demo-intents-v2-run-2026-11-03T1640Z.txt` 28 s).

Sandbox tests deploy the real mock NEP-141 and the splitter, register storage, then
check: exact split for odd amounts (1, 9 999, 12 345 679, 10 000 001 base units, plus
49.000000) with zero dust left in the splitter; paused → full refund; non-accepted token →
rejected and refunded; owner bounds and access control; failed payout recorded and
retried; and that a function-call key limited to `[record_cost, anchor_report]` can call
`record_cost`/`anchor_report` but **not** `set_split`, `pause`, `retry_payout`, any
`ft_transfer`, a NEAR transfer, `add_key`, or an allowed method with a deposit.

## 3. Testnet deployment

```bash
bin/fetch-near-cli.sh     # near-cli-rs 0.30.1 single binary -> .tools/bin/near (gitignored, sha256-checked)
bin/build.sh
bin/deploy-testnet.sh     # idempotent; NEARBI_AGENT=… to use another name, SPLIT_BPS=… (default 1000)
```

The script:

1. creates `nearbi-agent.testnet` through the testnet faucet sponsor (if missing);
2. creates `splitter.`, `usdc-mock.`, `treasury.`, `contributors.` sub-accounts funded by the agent;
3. deploys + inits `usdc-mock` (NEP-141, 6 decimals, supply 10 000 000 USDCm to the agent);
4. deploys + inits the splitter: owner = agent, split 1000 bps (10 %), accepted = [usdc-mock];
5. storage-registers splitter, treasury and contributors on the token;
6. adds the agent's function-call key on the splitter (`record_cost`, `anchor_report`,
   allowance 0.25 NEAR) and verifies its permission on chain;
7. writes the public record `deploy/testnet.json` (accounts, code hashes, tx links; no keys).

### Current testnet deployment (2026-11-03 UTC)

| Role | Account |
|---|---|
| splitter contract | [`splitter.nearbi-agent.testnet`](https://testnet.nearblocks.io/address/splitter.nearbi-agent.testnet) — code_hash `2hVSpdD7oPbfVwUmm2VBQTdxmskfs7DFSfN2dLVBUUF4` = sha256 `193b1516…fc13` of `res/nearbi_splitter.wasm` |
| owner / agent | `nearbi-agent.testnet` (faucet-created) |
| treasury | `treasury.nearbi-agent.testnet` |
| contributors | `contributors.nearbi-agent.testnet` |
| mock token | `usdc-mock.nearbi-agent.testnet` (USDCm, 6 decimals) — code_hash `2mMB4BWM1M2bfRyPgWuwovdHDhAx7JBzt4wLUkNASfHr` |
| agent function-call key | `ed25519:8s7VkyEA9AQyEAS8Ct1WjHRD6ShMf5Cku3zdktcz5HPJ` on the splitter |

Split at init: 1000 bps (10 %) contributors / 9000 bps treasury. All deploy tx links are
in `deploy/testnet.json`.

## 4. Key custody

| Key | Type | Where | Can do |
|---|---|---|---|
| `nearbi-agent.testnet` | full access | `~/.near-credentials/testnet/nearbi-agent.testnet.json` (+ `…/nearbi-agent.testnet/ed25519_*.json`), chmod 600, dir 700 | owner of the splitter, holds mock-token supply, funds sub-accounts |
| `splitter.nearbi-agent.testnet` | full access | `~/.near-credentials/testnet/splitter.nearbi-agent.testnet.json` | redeploy code, add/remove keys. Production: keep offline / OutLayer custody, or delete it |
| `usdc-mock.`, `treasury.`, `contributors.` | full access | `~/.near-credentials/testnet/<account>.json` | own account only |
| demo customers `nearbi-cust-*.testnet` | full access | `~/.near-credentials/testnet/<account>.json` | throwaway |
| `forwarder.nearbi-agent.testnet` | full access | `~/.near-credentials/testnet/forwarder.nearbi-agent.testnet.json` | redeploy code, **sign `ft_transfer` as the forwarder** (bypasses the contract). Production: delete it (see §7 trust model) |
| `oneclick-sim.nearbi-agent.testnet` | full access | `~/.near-credentials/testnet/<account>.json` | testnet stand-in for the 1Click sender |
| **forwarder function-call key** | function-call on `forwarder.nearbi-agent.testnet`, methods `[forward]`, allowance 0.5 NEAR | `~/.near-credentials/nearbi-fc/forwarder.nearbi-agent.testnet.fc.json`, chmod 600 | `forward` only, no deposit; can't reach the token, transfer NEAR, add keys or call any owner method |
| **agent function-call key** | function-call on `splitter.nearbi-agent.testnet`, methods `[record_cost, anchor_report]`, allowance 0.25 NEAR | `~/.near-credentials/nearbi-fc/splitter.nearbi-agent.testnet.fc.json`, chmod 600 | see below |

Nothing is in the repo: `.gitignore` excludes key files, and every push is preceded by
`bin/check-secrets.sh`, which scans the working tree and every blob in the git history
for `ed25519:` private keys, `private_key`/`seed_phrase` fields and BIP-39 word runs
(install it as a hook with `ln -s ../../bin/check-secrets.sh .git/hooks/pre-push`).

**What the function-call key can do:** sign a transaction from `splitter.nearbi-agent.testnet`
to itself calling `record_cost` or `anchor_report` with zero deposit, spending at most
0.25 NEAR of gas in total. The contract additionally requires the predecessor to be the
splitter itself or the owner, so nobody else can write ledger events.

**What it can't do:** call any other method (`set_split`, `set_accounts`, `pause`,
`add_token`, `retry_payout`, …) — the protocol rejects the method name, and owner methods
need 1 yocto + the owner account anyway; attach any deposit; call any other contract
(e.g. `ft_transfer` on the token); transfer NEAR; add/delete keys; deploy code; delete the
account. It never touches revenue: payouts are made by the contract, not by a key.

## 5. Changing the split

```bash
# 20 % to contributors (bounded 0..=5000); signed by the owner's full-access key, 1 yocto
.tools/bin/near contract call-function as-transaction splitter.nearbi-agent.testnet set_split \
  json-args '{"split_bps_contributors":2000}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' \
  sign-as nearbi-agent.testnet network-config testnet sign-with-legacy-keychain send
```

It emits `config_change`. Also update `split_bps` in the agent's `config.yaml`
(ARCHITECTURE §3.2); the agent refuses to run while they disagree. `set_accounts`,
`add_token`/`remove_token` and `pause`/`unpause` work the same way.

## 6. Demo

```bash
bin/demo.sh      # ~1 min; fails if it takes ≥ 120 s or the split doesn't match
```

Creates a fresh customer through the faucet, registers it on usdc-mock, drips it
49 USDCm, pays 49.000000 with `ft_transfer_call` + an `order_id`, prints balances
before/after and checks the exact split (contributors +4.900000, treasury +44.100000,
splitter ±0), then the agent records an inference cost and anchors a report hash with
the function-call key, and finally shows the same key being rejected for `set_split`.
Every tx is printed with its hash, a `https://testnet.nearblocks.io/txns/<hash>` link
and its NEP-297 events.

### Recorded run (2026-11-03 00:57 UTC, 33 s) — full log: `docs/demo-run-2026-11-03T0057Z.txt`

| Account | Before | After | Δ |
|---|---:|---:|---:|
| customer `nearbi-cust-1793667426.testnet` | 49.000000 | 0.000000 | −49.000000 |
| `splitter.nearbi-agent.testnet` | 0.000000 | 0.000000 | 0 |
| `contributors.nearbi-agent.testnet` | 4.900000 | 9.800000 | +4.900000 |
| `treasury.nearbi-agent.testnet` | 44.100000 | 88.200000 | +44.100000 |

(Before-balances include an earlier demo run.)

| Step | Tx |
|---|---|
| customer created (faucet) | [ENrevuwY…](https://testnet.nearblocks.io/txns/ENrevuwY3dSGHQFdRbGBPfCTm5mRSSiT2ikdHX3mA5NU) |
| storage_deposit | [A4UeDLTy…](https://testnet.nearblocks.io/txns/A4UeDLTy6hw78va2ggTXMM9h4tmwuKftaZg2JztLvWYL) |
| 49 USDCm drip | [Dw6YfVVg…](https://testnet.nearblocks.io/txns/Dw6YfVVgk6s5FhPeKTCtC1noi13f25Myua7d4VsjypGK) |
| **sale** `ft_transfer_call` → split | [7cAyURgz…](https://testnet.nearblocks.io/txns/7cAyURgzFpXEsB9UqdeP7Lf5FxD3unJaFfXsNAugNwcR) |
| `record_cost` (function-call key) | [3SDSA1Xo…](https://testnet.nearblocks.io/txns/3SDSA1Xo4NVwmAchvDFSwrYxcav3G8wHS6eBqvicAKZs) |
| `anchor_report` (function-call key) | [5Wn9FMg5…](https://testnet.nearblocks.io/txns/5Wn9FMg5vEmzJuWXnXAenRpC7DTXwqgGxcLegypPrHXG) |
| `set_split` with the function-call key | rejected by RPC before inclusion: *Transaction method name \<set_split\> isn't allowed by the access key* (no tx) |

Events in the sale tx: `nep141 ft_transfer` (customer→splitter), `nearbi_splitter sale
{amount 49000000, contributors_amount 4900000, treasury_amount 44100000}`, two
`nep141 ft_transfer` payouts, and two `nearbi_splitter payout` confirmations.

## 7. Settlement forwarder (NEAR Intents 1Click), v0.2.0-testnet

1Click delivers each subscription payment as a **plain `ft_transfer`** of USDC to a settlement
account (`SETTLEMENT_DELIVERY=transfer` in nearbi-app). Delivery straight into the splitter with
`ft_transfer_call` + msg is experimental and gets no refund on failure (nearbi-app README,
"Settlement design and trust tradeoff"). The forwarder closes most of the custody gap: it **is**
the settlement account, holds the funds, and its code has one way to move them, into the
splitter with an order id.

```
1Click / Verifier ──ft_transfer 49 USDC (no msg)──▶ usdc-mock ──▶ forwarder.nearbi-agent.testnet (holds)
                                                                       │
agent: FC key on the forwarder, methods [forward], no deposit          │ forward(order_id, amount)
                                                                       ▼
            usdc-mock.ft_transfer_call(receiver = splitter from state, amount, {"order_id": …})
                                                                       │
                                     splitter.ft_on_transfer: split ───┼──▶ contributors / treasury
                                                                       ▼
                             forwarder.on_forward(used): forwarded | forward_failed (retryable)
```

### Invariant: tokens leave only into the splitter

* The only outgoing token call in the code is `token.ft_transfer_call` in `send_to_splitter`, and
  its `receiver_id` is `self.splitter` from state. No argument of any method can change the
  receiver; `order_id` goes into `msg` through `serde_json` (no injection).
* There is no `ft_transfer`, withdraw, sweep, `storage_withdraw`, NEAR transfer, upgrade or
  arbitrary-call method. The only other promise is the `on_forward` callback to itself (`#[private]`).
* `splitter`, `token` and `owner` change only by `propose_change(field, value)` → wait
  `change_delay_sec` → `accept_change()`, both owner + 1 yocto and both evented
  (`change_proposed {field, value, eta_ns, delay_sec}`, `change_accepted {field, old, new}`).
  The delay is fixed at `init` (contract default **86 400 s**; testnet deploy uses **0** so the demo
  and tests can show a change). One pending change at a time; `cancel_change` drops it. A token
  change is refused while orders are in flight or retryable.
* Tested in three ways: unit tests check every receipt created by every state-changing method
  (only `ft_transfer_call` to the token with `receiver_id == splitter` and 1 yocto, or the
  callback, never a NEAR transfer); sandbox tests make the owner and the agent try crafted args
  (`receiver_id`/`splitter`/`token`/`msg` extras are ignored), nonexistent methods
  (`ft_transfer`, `withdraw`, `sweep`, `storage_withdraw`, `upgrade`, … → `MethodNotFound`), the
  private callback, an immediate `accept_change` under a 3 600 s delay, and the agent key signing
  `ft_transfer(_call)` on the token (→ `ReceiverMismatch`); then they check the owner's token
  balance never moved and every token is in the forwarder, treasury or contributors.

### Order lifecycle and failure handling

| State | Meaning | Next |
|---|---|---|
| (none) | never forwarded | `forward` → `in_flight` |
| `in_flight` | `ft_transfer_call` sent, callback pending | a second `forward` panics |
| `forwarded` | the splitter used the full amount | terminal; `is_forwarded` = true; `forward` panics |
| `retryable` | splitter paused/panicked (FT standard refunded the forwarder) or the token call failed (e.g. balance too low); `unused` is back in the forwarder | `forward(order_id, unused)` retries (amount must equal `unused`) |

`forward` needs ≥ 130 Tgas prepaid (100 Tgas + leftover to `ft_transfer_call`, 15 Tgas reserved for
the callback) so the callback always runs. It attaches the 1 yocto that `ft_transfer_call`
requires from the forwarder's own NEAR, so a function-call key can call it.

### Interface (`contracts/forwarder`)

| Method | Who | Notes |
|---|---|---|
| `init(owner, splitter, token, agent, change_delay_sec?)` | deployer | delay default 86 400 s, max 30 d; owner ≠ forwarder; splitter ∉ {forwarder, token} |
| `forward(order_id, amount)` | `agent` or `owner`, no deposit | order_id 1–128 chars (same as the splitter); not while paused |
| `on_forward(order_id, amount)` | private callback | records `forwarded` / `forward_failed` |
| `ft_on_transfer(sender_id, amount, msg)` | configured token only | returns `"0"` (keeps everything), emits `received`; other tokens panic → refunded |
| `set_agent(agent)`, `pause()`, `unpause()` | owner, 1 yocto | immediate; pausing stops `forward` only (deliveries still arrive) |
| `propose_change(field: splitter\|token\|owner, value)`, `accept_change()`, `cancel_change()` | owner, 1 yocto | timelocked as above |
| `get_config()`, `is_forwarded(order_id)`, `get_order(order_id)`, `get_pending(from_index?, limit?)` | view | `get_pending` = `in_flight` + `retryable` orders |

Events (`standard: "nearbi_forwarder"`, `version: "1.0.0"`): `init`, `forward_started {order_id,
amount, attempt, splitter, token, by}`, `forwarded {order_id, amount}`, `forward_failed {order_id,
amount, unused}`, `received {sender, amount, msg}` (only for `ft_transfer_call` deliveries; plain
transfers emit just the token's `ft_transfer`), `config_change {field, value, by}`,
`change_proposed`, `change_accepted`, `change_cancelled`. The splitter's `sale` event for a
forwarded order has `payer = forwarder.nearbi-agent.testnet`; the order id is the link to the
1Click payment.

### Trust model: what the forwarder does and does not remove

Removed (enforced by code): the operator or agent sending settlement funds anywhere but the
splitter; the agent doing anything but `forward` (protocol-level key scope + contract check);
forwarding one order twice; losing funds on a failed forward (they stay, retryable);
a silent splitter swap (public event + delay).

Still trusted / honest limits:

1. **Full-access keys of `forwarder.nearbi-agent.testnet`.** Whoever holds one can deploy new
   code or sign `usdc.ft_transfer` as the forwarder directly, bypassing every rule above. On testnet
   the key is kept (as for the splitter) at `~/.near-credentials/testnet/forwarder.nearbi-agent.testnet.json`
   so bugs can be fixed. For mainnet: delete all full-access keys after deploy (then the code is
   final; a fix means a new forwarder via the timelocked flow on the 1Click side), or hand them to
   a custody with its own delay/multisig. `bin/demo-intents.sh` prints the keys on the account so
   this is visible.
2. **The owner** (`nearbi-agent.testnet`, full access) can, immediately: pause forwarding (funds
   then sit in the forwarder; it cannot take them), and `set_agent`. With the delay: point the
   forwarder at any splitter or token, or hand ownership over. A malicious splitter could pass
   funds on anywhere; the protection is that the change is public for `change_delay_sec` before
   it takes effect (24 h on mainnet; **0 on this testnet deployment**, so on testnet it's evented
   but not delayed). Watchers must actually watch `change_proposed`.
3. **Order id ↔ amount mapping.** A plain `ft_transfer` doesn't notify the contract, so it can't
   tell which delivery belongs to which order. The agent picks `(order_id, amount)`; it can forward
   under the wrong order id or amount, or not forward at all (funds then sit idle, not lost). The
   ledger can reconcile 1Click withdrawals (public NEAR txs) against `forwarded` events by order
   id, but the contract doesn't enforce it.
4. **Promptness.** Nothing forces the agent to forward. Anyone could be allowed to call `forward`
   for "unclaimed" balance in a future version; not done here because the order id must come from
   the payment record.
5. **Token and splitter contracts.** The forwarder trusts the token's NEP-141 behaviour (refunds
   unused amounts in `ft_resolve_transfer`) and the splitter. If `ft_resolve_transfer` itself ran
   out of gas (not possible with the standard 5 Tgas and our gas floor) the callback would mark the
   order retryable although the splitter had used the funds; a retry would then fail for lack of
   balance rather than double-pay, unless other deliveries had arrived in the meantime.
6. **Storage.** Every order id is stored forever (~200 bytes ≈ 0.002 NEAR from the forwarder's
   balance); the forwarder needs NEAR top-ups at scale. It also needs `storage_deposit` on any new
   token before a token change.
7. **1Click → forwarder leg.** The forwarder must be storage-registered on USDC or the 1Click
   withdrawal fails (refunded by the Verifier). Testnet accounts are rejected by 1Click, so the
   1Click delivery is **simulated** here by `oneclick-sim.nearbi-agent.testnet`.

### Deploy and demo

```bash
bin/build.sh                        # also builds res/nearbi_forwarder.wasm
bin/deploy-forwarder-testnet.sh     # idempotent; FWD_CHANGE_DELAY_SEC=… (default 0 on testnet)
bin/demo-intents.sh                 # simulated 1Click delivery -> forward -> split; fails if >= 120 s
```

`deploy-forwarder-testnet.sh` creates `forwarder.` (2.3 NEAR; the 185 KB WASM needs ~1.9 NEAR of
storage) and `oneclick-sim.` (0.1 NEAR), deploys + inits the forwarder (owner = agent, agent = the
forwarder account itself, i.e. its function-call key), registers both on usdc-mock, adds the agent
function-call key (`[forward]`, allowance 0.5 NEAR) at
`~/.near-credentials/nearbi-fc/forwarder.nearbi-agent.testnet.fc.json` (chmod 600, dir 700),
verifies its on-chain permission and writes the `forwarder` section of `deploy/testnet.json`.

`demo-intents.sh`: the agent gives `oneclick-sim` 49 USDCm (its "liquidity"); `oneclick-sim` sends a
plain `ft_transfer` of 49.000000 to the forwarder; the agent calls `forward(order_id, 49000000)`
with the function-call key; the splitter pays 4.900000 / 44.100000; the script checks exact
deltas (1click −49, forwarder 0, splitter 0, contributors +4.9, treasury +44.1), `is_forwarded`,
that a second `forward` of the same order fails in the contract, and that the key can't call
`set_agent`.

Knobs (defaults reproduce the runs below): `PRICE=<base units>`, `PAYER=<account>.testnet` (who sends the plain
`ft_transfer`; e.g. a demo customer standing in for the 1Click withdrawal), `DRIP=always|auto` (auto: drip only if the
payer holds < `PRICE`), `QUICK=1` (skip the negative checks and the config/key dumps), `RESULT_JSON=<file>` (order,
txs, balances, deltas, split verdict), `DEMO_T0=<epoch s>` (step clock origin). rs-agent `make demo` runs it as
`NEARBI_SPLITTER=splitter-v2… NEARBI_FORWARDER=forwarder-v2… PRICE=29000000 PAYER=demo-customer.nearbi-agent.testnet
DRIP=auto QUICK=1` for a $29 Quick Answer (rs-agent README, "Order loop + testnet demo").

### Current testnet deployment (2026-11-03 UTC)

| Role | Account / value |
|---|---|
| forwarder contract | [`forwarder.nearbi-agent.testnet`](https://testnet.nearblocks.io/address/forwarder.nearbi-agent.testnet) — code_hash `Ht4N9MPmr7KRpgQDTYLkv4piR4TQ4R7LSZGnMwxo38Go` = sha256 `facf6a98…a0a0` of `res/nearbi_forwarder.wasm` (built from `28a65eb`) |
| owner | `nearbi-agent.testnet` |
| splitter / token | `splitter.nearbi-agent.testnet` / `usdc-mock.nearbi-agent.testnet` |
| change delay | 0 s (testnet demo setting; mainnet: 86 400 s) |
| agent function-call key | `ed25519:4e7uzpp3u8U3aFwEb5HtRWfCLhQU8QWeSQyNradfASQp` on the forwarder, `[forward]`, allowance 0.5 NEAR |
| simulated 1Click sender | `oneclick-sim.nearbi-agent.testnet` |

Create/deploy/storage/key tx links are in `deploy/testnet.json` (`forwarder.txs`). The first
deploy run got an RPC 524 after the deploy tx landed; the script was re-run (it is idempotent) and the
create/deploy hashes were recovered from the FastNEAR tx index and checked with `EXPERIMENTAL_tx_status`.

### Recorded run (2026-11-03 05:10 UTC, 88 s) — full log: `docs/demo-intents-run-2026-11-03T0510Z.txt`

| Account | Before | After | Δ |
|---|---:|---:|---:|
| `oneclick-sim.nearbi-agent.testnet` | 49.000000 | 0.000000 | −49.000000 |
| `forwarder.nearbi-agent.testnet` | 0.000000 | 0.000000 | 0 (49 in, 49 out) |
| `splitter.nearbi-agent.testnet` | 0.000000 | 0.000000 | 0 |
| `contributors.nearbi-agent.testnet` | 9.800000 | 14.700000 | +4.900000 |
| `treasury.nearbi-agent.testnet` | 88.200000 | 132.300000 | +44.100000 |

| Step | Tx |
|---|---|
| 49 USDCm liquidity to the 1Click simulator | [DcG6kRUH…](https://testnet.nearblocks.io/txns/DcG6kRUHEKzwAPBcYuc2ZvHL6sot91SqTACbPB4d1RpJ) |
| **1Click delivery**: plain `ft_transfer` → forwarder | [8LWABgbC…](https://testnet.nearblocks.io/txns/8LWABgbCHDW1nsGJmERiGz8FLo8dnD3Cx3hxzYkagJN3) |
| **forward** (function-call key) → `ft_transfer_call` → split | [9AFtmGBm…](https://testnet.nearblocks.io/txns/9AFtmGBmdrs4QYSX7rE1a1fDrqf17wYhgkLwXuzajnzB) |
| same order forwarded again | [33gUmZ6D…](https://testnet.nearblocks.io/txns/33gUmZ6DCff9cz1kkXFnUNop8ApnTizBp3Rp4ZYvGSYN) fails: *Smart contract panicked: order already forwarded* |
| `set_agent` with the function-call key | rejected by RPC before inclusion: *Transaction method name \<set_agent\> isn't allowed by the access key* (no tx) |

Events in the forward tx: `nearbi_forwarder forward_started`, `nep141 ft_transfer`
(forwarder→splitter 49000000), `nearbi_splitter sale {order_id intents-20261103T051041Z, payer
forwarder, 4900000 / 44100000}`, two `nep141 ft_transfer` payouts + two `nearbi_splitter payout`,
then `nearbi_forwarder forwarded {order_id, amount 49000000}`. Most of the 88 s was one slow
testnet tx (the liquidity drip took 57 s during an RPC incident); the forward itself took 11 s.
The public ledger (rs-ledger) picked the sale up automatically: https://nearbi.ai/ledger/ now has
13 events / 3 sales and reconciles against `get_stats()`.

## 8. Mainnet

Deployed 2026-11-03 17:01 UTC by `bin/deploy-mainnet.sh` (steps `preflight`, `splitter`, `forwarder`,
`storage`, `fc-keys`, `verify`, `lock`), protocol 86. Public record with every tx: `deploy/mainnet.json`.

| Role | Account | Notes |
|---|---|---|
| splitter | [`splitter.nearbi.near`](https://nearblocks.io/address/splitter.nearbi.near) | code_hash `BuT33o2VKMCx1rhxfZSYSsL5jWVfFjZNsv5xGSMV7YQB` = local `nearbi_splitter.wasm`; 1000 bps to contributors; accepts only USDC |
| forwarder | [`forwarder.nearbi.near`](https://nearblocks.io/address/forwarder.nearbi.near) | code_hash `7fvcJC7FEwcM4oz4E1UWQ8EuPfh2P8vvVw6GBGLpaEK6` = local `nearbi_forwarder.wasm`; splitter = `splitter.nearbi.near`; agent = itself; change delay **86 400 s** |
| owner + treasury | `nearbi.near` | operator's account; owner methods need its full-access key + 1 yocto |
| contributors | `contributors.nearbi.near` | operator key only |
| token | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | Circle USDC (6 decimals). Splitter, forwarder, contributors and nearbi.near are storage-registered |

**Keys.** Neither contract account has a full-access key (deleted in the `lock` step, txs in
`deploy/mainnet.json`), so their code is final: nobody can redeploy them or sign token transfers as
them. A fix means a new contract, switched to through the forwarder's 24 h timelock. Each has one
function-call key, whose secret is in the operator machine's macOS Keychain (`nearbi-mainnet-fc-<account>`), never on disk:

| Account | Public key | Methods | Allowance |
|---|---|---|---|
| `splitter.nearbi.near` | `ed25519:HFbATpvL7pcDahRX6SFsRA4JSjUA1fGS9bDhEGnRDRZS` | `record_cost`, `anchor_report` | 0.25 NEAR |
| `forwarder.nearbi.near` | `ed25519:5xFkgAW74jxwq8FFJPR14hfnKfM3q2HxXkJ4BwwsQwSi` | `forward` | 0.5 NEAR |

**Allowance and balance sizing.** A function-call tx needs `allowance ≥ prepaid gas × 1e9` up front
(the hold), but is charged only its burnt gas (~1e8/gas now). Measured on testnet v2: `record_cost` /
`anchor_report` ≈ 0.00018 NEAR each (~1.8 Tgas); `forward` ≈ 0.0021 NEAR (~21 Tgas burnt of 150 prepaid).

| Key | Hold per call | Usable allowance | Calls at current price | Calls if burnt gas were priced at 1e9 |
|---|---:|---:|---:|---:|
| splitter, 30 Tgas | 0.030 | 0.22 | ~1 200 | ~120 |
| forwarder, 150 Tgas (contract minimum 130) | 0.150 | 0.35 | ~165 | ~16 |

**These allowances can't be refilled.** Adding or replacing a key needs a full-access key on the same
account, and both accounts are locked. The numbers above are lifetime budgets for these two keys
(a key stops working once its allowance is below the hold). Refillable alternatives, no redeploy needed:

* forwarder: the owner calls `set_agent(<account>)` (immediate, 1 yocto), e.g. `agent.nearbi.near`
  with its own function-call key for `forward` on `forwarder.nearbi.near`; that key lives on an account
  the operator controls, so it can be re-added with a new allowance at any time;
* splitter: `record_cost` / `anchor_report` also accept the owner, so a function-call key on
  `nearbi.near` limited to those two methods on `splitter.nearbi.near` works the same way.

The tighter limit today is the forwarder's **own NEAR**, which pays the gas and holds the 0.15 NEAR
per `forward`: after storage it has ~0.226 NEAR free; each order keeps ~0.002 NEAR of storage and
burns ~0.002 NEAR of gas, so after ~19 orders it needs a NEAR top-up (a plain transfer from any
account; no key needed). The splitter has ~0.184 NEAR free (holds 0.03 per agent call).

Remaining operator step: remove the temporary deploy key from `nearbi.near`:

```bash
near account delete-keys nearbi.near public-keys ed25519:FvLoT3qgjGRKhsPvMVFtpuLyvKkY8QU6tSTw3DzoJKFZ \
  network-config mainnet sign-with-keychain send   # or sign-with-ledger / the method holding ed25519:ECakcb9R…
```

## Layout

```
contracts/splitter     splitter contract + unit tests (src/tests.rs)
contracts/forwarder    settlement forwarder + unit tests (src/tests.rs)
contracts/mock-ft      testnet-only mock USDC (NEP-141/145/148, 6 decimals)
integration-tests      near-workspaces sandbox tests (tests/splitter.rs, tests/forwarder.rs)
res/                   release WASM + sha256 + BUILD_COMMIT
bin/                   build, dev, deploy-testnet, deploy-forwarder-testnet, demo, demo-intents,
                       fetch-near-cli, check-secrets
docs/                  recorded demo runs
deploy/testnet.json    public deployment record
docker/dev.Dockerfile  test toolchain
```

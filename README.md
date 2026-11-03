# rs-payments

NearBI's payment rail: the onchain revenue splitter contract (this repo, v0.1.0-testnet)
and, later, the NEAR Intents 1Click checkout. Part of the NEAR Hackathon one-agent
research shop; design in `rs-docs/ARCHITECTURE.md` §3.1.

> **TESTNET ONLY.** Everything here runs on NEAR testnet with a mock token
> (`usdc-mock`, no value). No mainnet account, key or fund is used anywhere.

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

Rust 1.97 rather than 1.86: near-sdk 5.30 / near-workspaces 0.24 require rustc ≥ 1.95.

```bash
bin/build.sh                       # exports git HEAD, builds both contracts in the pinned image
cat res/*.sha256 res/BUILD_COMMIT  # committed checksums
bin/dev.sh cargo test -p nearbi-splitter        # unit tests
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

## Layout

```
contracts/splitter     splitter contract + unit tests (src/tests.rs)
contracts/mock-ft      testnet-only mock USDC (NEP-141/145/148, 6 decimals)
integration-tests      near-workspaces sandbox tests
res/                   release WASM + sha256 + BUILD_COMMIT
bin/                   build, dev, deploy-testnet, demo, fetch-near-cli, check-secrets
docs/                  recorded demo runs
deploy/testnet.json    public deployment record
docker/dev.Dockerfile  test toolchain
```

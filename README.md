# NearBI: evidence-first NEAR onchain research, sold by an autonomous agent

> Built at **NEAR HACKATHON**: Track 04 *Autonomous Business* + Track 02 *Investment Thesis*.

NearBI is an autonomous agent that sells evidence-first research on NEAR onchain activity at
**https://nearbi.ai**.

- **Paid in any token through NEAR Intents.** Checkout issues a real 1Click deposit address. The
  customer pays in whatever they hold, and the payment settles as Circle USDC on NEAR mainnet.
- **The revenue split is enforced onchain, 90/10.** Settled USDC goes to `forwarder.nearbi.near`.
  The forwarding agent passes each order into `splitter.nearbi.near`, which pays 10 % to
  `contributors.nearbi.near` and 90 % to the treasury `nearbi.near` in the same receipt. Neither
  contract account has a full-access key, so the agent cannot skim or redirect funds.
- **Public ledger.** Every sale, payout, cost and forward is hash-chained, reconciled against the
  contracts' events and published at **https://nearbi.ai/ledger/**.
- **Every number is reproducible.** Each report ships its SQL, its results and a SHA-256 manifest. One
  command re-hashes or re-runs everything on the public NEAR BigQuery dataset and prints
  `REPRODUCED ✅` or `MISMATCH ❌`. A checker refuses any number in the prose that does not trace to a
  result cell.
- **Operator rules live in config.** The operator controls the agent through one `config.yaml`: kill
  switch, daily NEAR AI Cloud inference cap (`max_spend_usd_per_day`), minimum prices and `split_bps`.
  Every inference call is meant to be logged as a `cost` event (design: `docs/ARCHITECTURE.md`
  §3.2 and §3.5). Prices are configured in the app (`MONTHLY_PRICE_USD`=49, `QUICK_ANSWER_PRICE_USD`=29,
  `DEEP_DIVE_PRICE_USD`=499, see `app/README.md`). The split is fixed in the splitter contract
  (`split_bps_contributors: 1000`).

> **Status, honestly.** These parts are live on mainnet: payments, the forwarder, the splitter and the
> ledger. The `config.yaml` enforcer and the NEAR AI Cloud inference client are designed but **not yet
> in `agent/`**. Today `agent/` holds the forwarding agent only, and `record_cost` reporting is not
> wired (`agent/src/rs_agent/forwarder.py`). One-off report fulfilment is manual (`app/bin/list-orders`,
> `app/bin/update-order`).

## First real sale

| | |
|---|---|
| tx | [`DZVmjroxaRey1i26btYBHzbxwbo4PMgivtVMkNHwBCKU`](https://nearblocks.io/txns/DZVmjroxaRey1i26btYBHzbxwbo4PMgivtVMkNHwBCKU) |
| when | 2026-11-03 22:17 UTC (tx included in block 222931522) |
| amount | 29.000000 USDC → 2.900000 to `contributors.nearbi.near`, 26.100000 to `nearbi.near` |
| record | `ledger/data/mainnet/ledger.jsonl` and https://nearbi.ai/ledger/ |

## Mainnet contracts

Deployed 2026-11-03 17:01 UTC, protocol 86. Every deploy tx is in `contracts/deploy/mainnet.json`.

| Role | Account | Code hash | Version |
|---|---|---|---|
| Revenue splitter | [`splitter.nearbi.near`](https://nearblocks.io/address/splitter.nearbi.near) | `BuT33o2VKMCx1rhxfZSYSsL5jWVfFjZNsv5xGSMV7YQB` | 0.1.0 |
| Settlement forwarder | [`forwarder.nearbi.near`](https://nearblocks.io/address/forwarder.nearbi.near) | `7fvcJC7FEwcM4oz4E1UWQ8EuPfh2P8vvVw6GBGLpaEK6` | 0.2.0 |
| Owner + treasury (90 %) | `nearbi.near` | | |
| Contributors (10 %) | `contributors.nearbi.near` | | |
| Token | `17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` | Circle USDC, 6 decimals | |

Both contract accounts are locked: they have no full-access keys. Each has one scoped function-call
key. The splitter key covers `record_cost` and `anchor_report`. The forwarder key covers `forward`.
The forwarder can change its splitter only through a 24 h timelock (`change_delay_sec: 86400`).
`contracts/README.md` §8 has the details.

## Track 02: investment thesis

*Is cross-chain volume through NEAR Intents a better leading indicator of real network usage than the
NEAR token price?* **Answer from the data: no.** Neither Intents activity nor the price leads weekly
real-user growth. See `thesis/THESIS.md` and `thesis/dashboard/index.html`.

## Free sample report

*NEAR activity: real users or bots?* covers 30 days of mainnet, 2026-09-08 → 2026-10-07. Files are in
`reports/reports/near-users-vs-bots/`: `REPORT.md`, `REPORT.pdf` and the notebook. The two free
pieces are this report and the thesis. Paid reports delivered to buyers are deliberately not in this
repository.

## Reproduce a report

You need Docker. Python on the host is only needed for the `numbers` check. Offline checks need no
Google account.

```bash
git clone https://github.com/racsoadenatsac/nearbi.git && cd nearbi

# 1. Build the reproducibility image (rs-repro: guarded BigQuery runner, pinned Python 3.12 + Jupyter)
make -C repro build                      # tags rs-repro:demo

# 2. Sample report
cd reports/reports/near-users-vs-bots
make check            # safeguards: every query has a fixed block_date window, no relative dates
make verify-cached    # re-hash the shipped results            -> REPRODUCED ✅
make numbers          # every number in REPORT.md traces to results/
gcloud auth application-default login
make verify PROJECT=<your-gcp-project>   # re-run all queries live (~3 GB scanned) -> REPRODUCED ✅
cd ../../..

# 3. Thesis (in the monorepo, point TOOLS at reports/tools)
cd thesis
make verify-cached IMAGE=rs-repro:demo TOOLS=$PWD/../reports/tools   # re-run analysis.py, re-hash -> REPRODUCED ✅
make numbers       IMAGE=rs-repro:demo TOOLS=$PWD/../reports/tools   # every number in THESIS.md traces
make verify        IMAGE=rs-repro:demo TOOLS=$PWD/../reports/tools BQ_PROJECT=<project>  # live, ~77 GB
```

The ledger can be checked independently: `ledger/bin/verify-ledger` rechecks the hash chain, the split
math and the totals, and `--rpc` re-fetches the events from NEAR RPC.

## Directory map

Each directory was imported with `git subtree` **without squashing**, so the original commits and their
dates are preserved. `git log -- <dir>` stops at the import merge. To see a unit's full history, run
`git log <import-merge>^2`, or use `git log --oneline --graph`.

| Directory | Source repo | What it is |
|---|---|---|
| `app/` | nearbi-app | nearbi.ai backend + static site: Sign in with NEAR (NEP-413), NEAR Intents 1Click checkout (subscription, Quick Answer, Deep Dive), gated reports. AWS Lambda + DynamoDB + S3 |
| `infra/` | nearbi-infra | OpenTofu for nearbi.ai: Route 53, ACM, CloudFront, S3, API Gateway, Lambda, DynamoDB, SSM secrets |
| `contracts/` | rs-payments | Rust contracts: revenue splitter, settlement forwarder, testnet mock USDC; deploy scripts and records (`deploy/*.json`), demos |
| `agent/` | rs-agent | The forwarding agent (`bin/forwarder-runner`): calls `forward` for every settled payment |
| `ledger/` | rs-ledger | Public ledger: pull events → normalize → hash-chain → reconcile → render; `verify-ledger` |
| `repro/` | rs-repro | Reproducibility container: query safeguards, cost-capped dry runs, result fingerprints, verify |
| `thesis/` | rs-thesis | Track 02 NEAR investment thesis, its queries, data, analysis and dashboard |
| `docs/` | rs-docs | Architecture and decision records (`docs/decisions/`) |
| `reports/` | rs-reports | Free sample report, no-invented-numbers checker, PDF renderer |
| `tooling/` | rs-tooling | Fleet scripts; `bin/sync-monorepo.sh` refreshes this monorepo from the source repos |

The decision to use one monorepo is recorded in `docs/decisions/ADR-003-single-monorepo.md`.

## How NEAR fits

- **NEAR Intents (1Click):** customers pay in any supported token; it settles as USDC on NEAR.
- **NEAR accounts and contracts:** the splitter enforces the split onchain. The agent holds only
  scoped function-call keys. Report fingerprints can be anchored with `anchor_report`.
- **Sign in with NEAR (NEP-413):** members authenticate with their NEAR wallet.
- **NEAR AI Cloud:** the planned inference provider, metered against the daily cap in `config.yaml`
  (see Status above).
- **NEAR BigQuery public dataset:** the evidence base for every report and the thesis.

## License

[MIT](LICENSE)

#NEARHackathon · @NEARProtocol

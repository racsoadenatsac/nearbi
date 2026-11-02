# Architecture v1: One-Agent Research Shop

Status: DRAFT, awaiting the operator's OK. NEAR Hackathon, Tracks 04 (Business) and 02 (Thesis). Deadline: 14 Nov 2026 23:59 UTC.

## 1. What it does

1. A customer orders a report and pays in any token through NEAR Intents.
2. The payment settles as USDC into the shop's splitter contract on NEAR. The contract splits it onchain: the contributors' share goes out at once and the rest goes to the agent treasury.
3. The agent sees the paid order, checks `config.yaml` (kill switch, minimum price, daily inference cap), runs the guarded BigQuery queries, and buys inference from NEAR AI Cloud to write the narrative.
4. The customer receives a report and a reproducibility pack (container, SQL and result checksums).
5. Every sale, cost and payout lands on the public ledger. Report checksums are anchored onchain.

## 2. Components (one git repo each)

| Repo | Responsibility |
|---|---|
| `rs-agent` | Orchestrator: order queue, config enforcement, inference client, delivery |
| `rs-payments` | 1Click checkout (quote → deposit address → status) and the splitter contract |
| `rs-repro` | Docker + Jupyter image and a guarded BigQuery runner |
| `rs-reports` | Report templates and published reports with their query packs |
| `rs-ledger` | Append-only event log and a static public ledger page |
| `rs-sales` | Offers, pricing, landing copy and the outreach pipeline |
| `rs-docs` | This file and the ADRs |
| `rs-tooling` | Fleet scripts |

Submission: the judges need ONE public repo. We'll publish an umbrella repo, `research-shop`, that pulls in the others as git submodules (ADR-002).

## 3. Key design decisions

### 3.1 Revenue split is enforced onchain, not by the agent
- The split happens in the splitter contract's `ft_on_transfer`: incoming USDC is divided by the configured basis points and sent to the contributors and the treasury in the same call.
- Why: payouts then *must* match the split. The agent can't skim or forget, and the ledger reconciles against the contract's events.
- It also solves key custody. NEAR function-call keys can't attach deposits, and `ft_transfer` needs 1 yoctoNEAR, so a scoped key couldn't make payouts anyway. Because the contract does the payouts, the agent's key only needs function-call access to our own contract methods (`record_cost`, `anchor_report`). No full-access key ever sits on disk. The full-access key for the contract account stays offline or in OutLayer custody.

### 3.2 config.yaml is the operator's whole control surface
```yaml
kill_switch: false            # true = stop accepting orders, finish nothing new
inference:
  max_spend_usd_per_day: 50
pricing:                      # minimum prices; the agent may quote higher, never lower
  quick: 29
  deep_dive: 499
  custom_min: 2500
split_bps:                    # must sum to 10000; mirrored into the contract
  contributors: 1000
  treasury: 9000
contributors_account: contributors.<tbd>.near
```
- The agent re-reads the file before every order, so a kill-switch flip takes effect on the next check (≤5 s).
- `split_bps` is pushed to the contract on change, and the agent refuses to run if the file and the contract disagree.

### 3.3 Reproducibility (`rs-repro`)
- Every query must have a `block_date` filter. The runner parses the SQL and rejects queries without one, because the dataset doesn't require a partition filter.
- Every query gets a dry run first. The runner prints the bytes and dollar estimate and aborts above a cap.
- Every query uses a fixed date range, so results are deterministic.
- Each result is canonicalized (sorted, CSV) and hashed with SHA-256. The hashes are printed in the report and anchored onchain.
- `make verify` re-runs the queries and prints ✅ or ❌ for each hash. A cached-results mode rebuilds the charts without GCP.
- Credentials are mounted at runtime (`-v key.json:/secrets/gcp.json:ro`) and never baked into the image. Recommend a read-only service account.

### 3.4 Report generation: no invented numbers
- The LLM gets the query results as structured data and writes prose around them only.
- A post-check extracts every number in the prose and requires it to trace back to a result cell, within rounding. Otherwise the report fails and is regenerated or escalated.
- Every report has fixed sections (Track 02): Claim · Evidence for · Evidence against · What would change the conclusion · Queries.

### 3.5 Inference
- NEAR AI Cloud, through its OpenAI-compatible endpoint (to verify on Day 1). Every call's cost is written to the ledger as a `cost` event and counted against the daily cap. If a call would exceed the cap, the order queues until the next UTC day.

### 3.6 Public ledger
- Events are written to an append-only JSONL file: `sale`, `cost`, `payout`, `report_anchor`, `config_change`. Each event chains to the hash of the previous one.
- A static page renders the totals, the event list and onchain links. Anyone can reconcile it against the contract's events.

### 3.7 Demo mode
- `make demo` runs on testnet: a fake customer pays through a testnet Intents path (or a direct testnet USDC transfer if 1Click has no testnet), then the splitter pays out, then a cached-mode report is delivered, then the ledger updates. Target: under 90 s.

## 4. Build order (driven by revenue, not by components)

| Days | Ship | Why |
|---|---|---|
| Nov 2–3 | `rs-sales` offer + landing; `rs-repro` runner; first sample report | Start selling custom reports by hand now |
| Nov 3–5 | `rs-payments` 1Click checkout + splitter (testnet → mainnet) | Take money without us in the loop |
| Nov 5–7 | `rs-ledger` page; `rs-agent` order loop | The ledger doubles as the sales page |
| Nov 7–10 | Full autonomy, demo mode, hardening | Self-serve tiers; Track 04 requirements |
| Nov 10–13 | Umbrella repo, X demo post, submission | Submit by Nov 13, keep Nov 14 as buffer |

## 5. Open items for the operator
- Pricing tiers: approve them or change them.
- Contributors account and split percentage.
- Agent NEAR account name; prize wallet (kept separate).
- NEAR AI Cloud key, Intents Explorer JWT, a GCP service account for production queries.
- X account and email to sell from.

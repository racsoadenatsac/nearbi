# rs-ledger

Public ledger for NearBI: every sale, payout, cost and report anchor emitted by the revenue splitter
contract (and, on mainnet, every forward by the settlement forwarder), hash-chained, reconciled against the
contracts, published per network:

| Network | Contracts | Published at | Data |
|---|---|---|---|
| **mainnet** (default, live, real USDC) | `splitter.nearbi.near` + `forwarder.nearbi.near`, token Circle USDC `17208628…6133a1` | **https://nearbi.ai/ledger/** | `data/mainnet/` |
| testnet (demo, mock USDC) | `splitter.nearbi-agent.testnet` | https://nearbi.ai/ledger/testnet/ | `data/testnet/` |
| testnet-v2 (`make demo`, mock USDC) | `splitter-v2.nearbi-agent.testnet` + `forwarder-v2.nearbi-agent.testnet` | https://nearbi.ai/ledger/testnet-v2/ | `data/testnet-v2/` |

Part of the NEAR Hackathon one-agent research shop (Track 04: "log every sale, cost and payout to a
public ledger page"). See `rs-docs/ARCHITECTURE.md` and `rs-payments/README.md` for the contract.

> v0.2.0: mainnet is the primary ledger. The testnet ledger keeps its original 13-event chain unchanged
> (splitter events only; its forwarder demo is not added, because inserting those rows would rewrite the
> published, append-only history).

## Layout

```
bin/build-ledger    pull events -> normalize -> hash-chain -> reconcile -> render out/<network>/ledger/  (--network)
bin/verify-ledger   recheck a ledger file (hash chain, split math, totals; --rpc re-fetches from NEAR RPC)
bin/publish         build + verify + upload (mainnet: s3://nearbi-site/ledger/ excluding testnet/*;
                    testnet: s3://nearbi-site/ledger/testnet/) + invalidate
bin/py              Python 3.12 from the rs-repro Docker image (no host Python/node needed)
bin/check-secrets.sh  pre-push secret scan (worktree + full history)
src/build_ledger.py   the builder (stdlib only)
src/verify_ledger.py  the verifier (stdlib only, Python 3.8+); also published next to the ledger
templates/index.html  page template (site.css, nav, footer of nearbi.ai; tiny vanilla JS)
config.json           per network: contracts, token, RPC endpoints, FastNEAR, explorer, badge, URL, S3 prefix
data/<net>/ledger.jsonl  last published ledger (committed; the append-only reference)
data/<net>/seed-txs.txt  optional extra tx hashes (one per line), unioned with the indexer's list
data/cache/<net>/     RPC cache (final txs, blocks, ft_metadata; gitignored)
```

## Event source (and why)

Evaluated in the order requested:

1. **NearBlocks API** (`api-testnet.nearblocks.io/v1/account/<id>/txns|receipts`): reachable (HTTP 200)
   but returns `{"txns":[]}` and `count: 0` for the splitter and even for `nearbi-agent.testnet`, and
   `/v1/txns/<hash>` is empty for known txs. Its testnet indexer does not have these accounts, so it
   is unusable as a source today. The website stays the human-facing explorer for every row's link.
2. **FastNEAR tx API** (`tx.test.fastnear.com`), **chosen**. `POST /v0/account` lists every tx that
   touches the account, *including* txs where the splitter is only reached by a receipt (a sale is
   signed by the customer and sent to the token contract; the splitter runs in `ft_on_transfer`).
   It is free, keyless, paginates with `resume_token`, and found all 10 txs (including both sales).
   `POST /v0/transactions` returns the receipts with logs, used as a cross-check.
3. **Seed list + RPC** is kept as the fallback: `data/seed-txs.txt` and every tx hash already in the
   ledger are always unioned into discovery, and `bin/build-ledger --allow-seed-only` builds without
   FastNEAR.

Discovery comes from the indexer, but **the data comes from NEAR RPC**: every tx is resolved with
`EXPERIMENTAL_tx_status` (`rpc.testnet.near.org`, falling back to `archival-rpc.testnet.near.org` once
the regular node has garbage-collected it), every receipt's block hash is resolved with `block` for its
height and timestamp, and the FastNEAR copy must agree byte for byte (logs, block hash). Only
`EVENT_JSON` logs of standard `nearbi_splitter` from **successful receipts executed by the splitter**
are ledger events (a failed receipt's logs are not state). New sales are found automatically, so the
ledger needs no manual list.

## Mainnet: forwarder events and extra reconciliation

On mainnet, discovery lists the txs of both `splitter.nearbi.near` and `forwarder.nearbi.near` (FastNEAR
`tx.main.fastnear.com`), data comes from `rpc.mainnet.fastnear.com` (archival fallback
`archival-rpc.mainnet.fastnear.com`), and the ledger takes `nearbi_splitter` events from successful splitter
receipts **and** `nearbi_forwarder` events (`init`, `forward_started`, `forwarded`, `forward_failed`,
`received`, `config_change`, `change_proposed/accepted/cancelled`) from successful forwarder receipts, in one
hash chain. Each row carries its `standard`. Extra checks at the same block `H`:

- `forwarded` events (count, sum) == forwarder `get_config()` `forwarded_count` / `forwarded_total`
- orders whose last forwarder event is `forward_started`/`forward_failed` == `get_config().open_orders`
- every `forwarded {order_id, amount}` has a splitter `sale` with the same order id and amount and payer
  `forwarder.nearbi.near`, and vice versa
- the forwarder still points at this splitter and USDC (paused flag and any pending timelocked change are shown)
- the split in effect comes from the splitter's own **successful** `init` call (the failed deploy attempts
  also carry an `init` action and are skipped)

With zero sales the page still renders: "0 sales", an explicit `get_stats()` empty check, the splitter and
forwarder configuration, and the forwarder's `init` event.

## Ledger format

`ledger.jsonl`, one event per line, in chain order (block height, then receipt order in the tx, then
log index):

```
seq, ts (UTC), ts_ns, block, block_hash, tx_hash, receipt_id, log_index, signer,
kind (sale|payout|payout_failed|payout_retry|cost|report_anchor|config_change|refund_paused),
standard, version, order_id, token, unit, decimals,
amounts {name: integer string}, display {name: decimal string}, accounts {payer|recipient|by|signer},
data (the event's data object), raw (the exact log line "EVENT_JSON:{...}"), explorer (testnet.nearblocks.io),
prev_hash, line_hash
```

`line_hash = sha256(canonical_json(line without prev_hash/line_hash) + prev_hash)`, where canonical JSON
is `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False)` in UTF-8 and the first
`prev_hash` is 64 zeros. Changing or dropping any past row breaks every later hash. Cost amounts are
`amount_usd_micros` (unit USD, 6 decimals).

## Reconciliation (the build fails on any mismatch)

All views are read at the same final block `H` (finality minus `LEDGER_CUTOFF_BLOCKS`, default 20,
so the indexer has caught up); only events at or below `H` are included.

- hash chain valid; every row's fields equal its raw event
- per token, totals from events == `get_stats()` exactly: `sales`, `total_received`,
  `contributors_amount`, `treasury_amount`, `pending_failed`
- payouts paid + pending failed == total received
- every sale: `contributors_amount == floor(amount * bps / 10000)`, `treasury = amount - contributors`,
  and `bps` is the split in effect: read from the splitter's own `init` call, then `config_change` events;
  the final value must equal `get_config().split_bps_contributors`
- outstanding failed payouts (`payout_failed` minus `payout_retry`) == `get_failed_payouts()`
- append-only: the previously published ledger is an exact prefix of the new one
- warning only: the splitter's token balance vs pending failed payouts (stray transfers)

A mismatch is retried (`LEDGER_RETRIES`, default 5, 15 s apart) to absorb indexer lag, then fails
with exit 1 and nothing is written or published.

## Run

```
bin/build-ledger                 # -> out/ledger/{index.html, ledger.jsonl, ledger.json, verify_ledger.py}
bin/verify-ledger                # offline check of data/ledger.jsonl
bin/verify-ledger https://nearbi.ai/ledger/ledger.jsonl --rpc
bin/py tests/test_ledger.py
AWS_PROFILE=nearbi bin/publish                     # mainnet -> /ledger/
AWS_PROFILE=nearbi bin/publish --network testnet   # testnet -> /ledger/testnet/
```

Docker image: `rs-repro:0.3.3` (Python 3.12), override with `RS_LEDGER_IMAGE`.

## How the agent refreshes it after each sale

There is no scheduler in this repo; the agent calls publish after anything that emits an event
(a confirmed sale, a `record_cost`, an `anchor_report`):

```
cd ~/projects/research-shop/rs-ledger && AWS_PROFILE=nearbi bin/publish      # mainnet (sales, forwards, costs)
```

(testnet only changes if someone runs the old testnet demo again: `bin/publish --network testnet`.)

### testnet-v2: the `make demo` ledger (v0.3.0)

rs-agent `make demo` runs the whole shop on the v2 testnet contracts (rs-payments `deploy/testnet-v2.json`) and ends
with `bin/publish --network testnet-v2` → **https://nearbi.ai/ledger/testnet-v2/**. It is a separate page and chain
(`data/testnet-v2/`, S3 prefix `ledger/testnet-v2/`), so the published v1 testnet ledger stays untouched and
append-only. Like mainnet it includes the forwarder's events and the forwarder reconciliation; RPC is FastNEAR
(`rpc.testnet.fastnear.com`, archival fallback), because the rate-limited `rpc.testnet.near.org` made a cold build take
over 2 minutes (warm: ~6 s). The demo calls publish with:

- `LEDGER_EXTRA_TXS=<hash,…>`: the txs it just sent are unioned into discovery as seeds, so a cost or anchor row is not
  missed while FastNEAR's index catches up (those rows don't move `get_stats()`, so reconciliation alone would not notice);
- `LEDGER_CUTOFF_BLOCKS=1`: every demo tx is already `FINAL`;
- `PUBLISH_NO_WAIT=1`: the CloudFront invalidation is created but not awaited (files are `max-age=60`).

`verify_ledger.py` infers `testnet-v2` from the `-v2.nearbi-agent.testnet` accounts in the rows (`--network` overrides).
Note: the gateway's TLS-intercepting egress proxy breaks the aws-crt S3 upload (`AWS_IO_TLS_ERROR_NEGOTIATION_FAILURE`);
run publish with `HTTPS_PROXY`/`HTTP_PROXY` unset there (the demo does).

- run it after the sale's tx is final (`demo.sh` and the agent already wait for `FINAL`); the cutoff
  and retries cover indexer lag, so a publish right after a sale may need up to ~1-2 minutes
- exit 0: published (the last lines print the live status codes and the chain head); 1: reconciliation
  or verification failed, nothing was uploaded, report it; 2: upload failed; 3: `SSO expired`, stop and
  ask the operator (never run `aws sso login`)
- optionally commit `data/ledger.jsonl` afterwards (`chore(data): ledger snapshot`) so the git history
  carries the ledger too; publish does not commit or push
- it is idempotent: with no new events it re-uploads the same rows with a new "Last updated" time

## Deployment notes

- `/ledger` and `/ledger/*` are static CloudFront behaviors in `nearbi-infra/tofu/cdn.tf`, placed before
  the app behaviors, so the ledger never reaches the gated Lambda. Files carry
  `Cache-Control: public, max-age=60` and publish invalidates `/ledger/*`.
- `nearbi-infra/bin/sync-site.sh` excludes `ledger/*` from its `--delete` sync; this repo owns that prefix.
- The page's nav/footer are a copy of the site's; keep them in sync with nearbi-site / nearbi-app.

## Limits

- The ledger is as complete as FastNEAR's index plus the seed list; the
  reconciliation proves sales/payout totals, but a missing `cost` or `report_anchor` event would not
  change `get_stats()` (those events carry no contract state). The append-only check catches a
  late-discovered older event (the build fails rather than rewriting history).
- `rpc.testnet.near.org` is rate limited; a full `--rpc` verification takes about a minute.
- The page is a snapshot; its "live check" asks the RPC from the visitor's browser and reports if the
  contract has moved on since the last publish.
- Mainnet relies on the FastNEAR mainnet tx index for discovery; an event it misses is still caught by the
  totals/forwarder reconciliation for sales and forwards (the build fails), not for `cost`/`report_anchor`.
- `bin/publish` treats a live `ledger.jsonl` from another network as no reference (this is how `/ledger/`
  switched from testnet to mainnet in v0.2.0; the old testnet file moved to `/ledger/testnet/` unchanged).

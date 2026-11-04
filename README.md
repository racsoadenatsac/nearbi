# rs-agent

The shop agent: order intake, config.yaml rules (spend cap, min price, split, kill switch), NEAR AI Cloud inference.

Part of the NEAR Hackathon one-agent research shop. See `rs-docs/ARCHITECTURE.md`.

It contains the **operator rules** (`config.yaml`, enforced by every action below), the **forwarding agent**
for live NearBI payments, the **spend ledger** + `bin/record-cost`, and a **NEAR AI Cloud** inference client.

## forwarder-runner (v0.1.0)

NEAR Intents 1Click delivers each subscription payment as a plain `ft_transfer` of USDC to
`forwarder.nearbi.near` (nearbi-app `SETTLEMENT_DELIVERY=transfer`). That contract can only send funds one
way: `forward(order_id, amount)` → `usdc.ft_transfer_call(splitter.nearbi.near, amount, {"order_id"})`, where
the splitter pays 10 % to `contributors.nearbi.near` and 90 % to `nearbi.near` (rs-payments README §7–8).
`bin/forwarder-runner` is the agent that calls `forward` for every settled payment.

```
checkout (nearbi-app) ──1Click SUCCESS──▶ DynamoDB nearbi: FWDQ / PAY#<id> ◀── forwarder-runner (this repo, Mac)
1Click ──ft_transfer USDC──▶ forwarder.nearbi.near ──forward(order_id=<payment id>, amount=<settled amountOut>)──▶ splitter.nearbi.near
```

### Run

```bash
cd ~/projects/research-shop/rs-agent
bin/forwarder-runner --status              # health + queue; never signs
bin/forwarder-runner --once                # one pass, then exit (use this from a scheduler)
bin/forwarder-runner --once --dry-run      # every check, no transaction
bin/forwarder-runner --loop --interval 60  # foreground loop until Ctrl-C or a stop condition
bin/forwarder-runner --order <paymentId> --amount <USDC base units>   # a payment not on the queue
```

Needs: macOS `security` (Keychain item `nearbi-mainnet-fc-forwarder.nearbi.near`), `aws` CLI with the SSO
profile `nearbi` (`AWS_PROFILE`, default `nearbi`), near-cli-rs (`NEAR_CLI`, default
`../rs-payments/.tools/bin/near`), Python ≥ 3.9 (stdlib only). Nothing is installed as a service: no
launchd/cron here, the main agent owns scheduling (e.g. `--once` every 1–5 minutes).

| Exit | Meaning | What to do |
|---:|---|---|
| 0 | done, or nothing to do | |
| 1 | stopped on an error (config mismatch, paused contract, Keychain key mismatch, near-cli gave no tx hash) | read the log; check `get_order` before rerunning |
| 2 | at least one order needs a human (`ATTENTION:` lines); the others were processed | see below |
| 3 | `SSO expired` | the operator runs `aws sso login --profile nearbi` (the agent never does) |
| 4 | **top up forwarder.nearbi.near** (free NEAR < 0.16), or the key allowance is < 0.15 NEAR | send NEAR to `forwarder.nearbi.near` from any account; allowance: see Limits |
| 5 | **refused by config.yaml**: kill switch on, split mismatch (`ALERT:`), `network` not mainnet, invalid config | read the `REFUSED (<rule>)` line; see [Operator rules](#operator-rules-configyaml). `--loop` keeps running and resumes by itself |

### What one pass does

1. **Preflight**: SSO valid; `forwarder.get_config()` has splitter `splitter.nearbi.near`, token USDC, agent
   = itself, not paused (a pending timelocked change is printed as a warning); the splitter accepts USDC and
   isn't paused; the onchain access key `ed25519:5xFkg…wSi` is a function-call key for `[forward]` on the
   forwarder; the Keychain secret's public half equals that key (checked in memory, nothing printed).
2. **Queue**: `Query PK = FWDQ` (written by the app when 1Click reports `SUCCESS`, before the subscription is
   extended), oldest first.
3. **Per order** (any failed check skips the order and prints `ATTENTION`, never guesses):
   - payment `PAY#<id>`: `mode=live`, `status=paid`, `intentsStatus=SUCCESS`, recipient
     `forwarder.nearbi.near`, asset USDC, same deposit address as the queue entry; already has `forwardedTx`
     → just dequeue;
   - amount = the queue's settled `amountOut`, equal to the payment's `settledAmountOut` and ≥ the quoted
     price; a missing amount is never guessed;
   - **1Click cross-check**: `GET /v0/status` for the deposit address must say `SUCCESS`, recipient
     forwarder, asset USDC and the same `amountOut`;
   - **onchain idempotency**: `get_order(id)`: `forwarded` → recover from the local journal (below) or ask
     a human, `in_flight` → wait, `retryable` → retry only with `amount == unused`; `is_forwarded(id)` must
     be false;
   - **balance**: `usdc.ft_balance_of(forwarder) ≥ amount` (else the delivery hasn't landed; retried later);
   - **gas**: forwarder free NEAR (balance − storage) ≥ **0.16**, key allowance ≥ 0.15 NEAR, else stop with
     exit 4 and a "top up forwarder.nearbi.near" message;
   - **sign**: `forward(order_id, amount)`, 150 Tgas, 0 deposit, with the function-call key from the Keychain
     (read into memory, passed to near-cli through an anonymous pipe `/dev/fd/N`; never on disk, argv or
     logs; near-cli output is scrubbed);
   - **verify**: `EXPERIMENTAL_tx_status` (FINAL): no failed tx, a `nearbi_forwarder forwarded {order_id,
     amount}` event from the forwarder and a `nearbi_splitter sale {order_id, amount, token USDC}` event from
     the splitter, both from successful receipts; then `is_forwarded(id) == true`;
   - **mark**: `UpdateItem PAY#<id> SET forwardedTx, forwardedAt, forwardedAmount` (conditional on
     `attribute_not_exists(forwardedTx)`), then delete the queue item.
4. A lock file (`~/.local/state/rs-agent/forwarder-runner.lock`) keeps two runners from overlapping; the
   contract would reject a duplicate anyway (`order already forwarded` / `in flight`).

Journal: `~/.local/state/rs-agent/forwarder-journal.jsonl` (no secrets): `forward_sent`, `forwarded`
(with tx), `forward_problem`, `forward_no_tx`. If the runner dies after sending, the next pass sees the order
`forwarded` onchain, verifies the journaled tx and marks it ("recovered").

### Write path and IAM

The runner uses the operator's SSO session (`AWS_PROFILE=nearbi`, AdministratorAccess). Its only writes
are the conditional `UpdateItem` on `PAY#<id>` (`forwardedTx`, `forwardedAt`, `forwardedAmount`) and
`DeleteItem` on `FWDQ/PAY#<id>`. No long-lived IAM user or access key was created for it, so it stops with
`SSO expired` (exit 3) when the session ends and the operator logs in again. A narrower role
(`dynamodb:Query/GetItem` on the table, `UpdateItem` on `PAY#*`, `DeleteItem` on `FWDQ`) would be the next
step if it runs unattended for long. The journal is the local record if DynamoDB is unreachable.

### Inference / BigQuery cost (`record_cost`)

Costs are booked by `bin/record-cost` and the NEAR AI client, not by the forwarder: see
[Operator rules](#operator-rules-configyaml) → spend ledger and record-cost.

### Limits and risks

- **Forwarder NEAR**: each forward holds 0.15 NEAR of prepaid gas and costs ~0.002 NEAR of storage + ~0.002
  NEAR of gas. With 0.2256 NEAR free now and the 0.16 floor, that is **~17 forwards before a top-up**
  (plain NEAR transfer to `forwarder.nearbi.near`; no key needed). `--status` prints the estimate.
- **Key allowance is not refillable**: 0.5 NEAR on the forwarder's function-call key, ~0.0021 NEAR burnt per
  forward → roughly 150+ forwards in its lifetime. The account has no full-access key, so the key can't be
  replaced; the owner (`nearbi.near`) can `set_agent(<other account>)` and the runner then needs that
  account's key (rs-payments README §8).
- **Order ↔ amount**: the contract can't tell which delivery belongs to which order; the runner's checks
  (1Click status, settled amount, balance) are what ties them together.
- **Admin-confirmed payments** (`POST /billing/confirm`) are not queued; use `--order/--amount`, which still
  requires 1Click `SUCCESS` with that exact `amountOut`.

### Tests

```bash
python3 -m unittest discover -s tests     # offline: validation, 1Click cross-check, tx/event verification,
                                          # dry-run, balance/gas/allowance stops, idempotency, recovery,
                                          # and every operator rule (tests/test_rules.py)
```

## Operator rules (config.yaml)

`config.yaml` at the repo root is the operator's whole control surface (Track 04: "humans only set the
constraints"). The operator edits it; the agent only reads it, **re-reading it at every decision point**, so
an edit applies at the next check without a restart. Every field is commented in the file itself.

```bash
bin/operator-rules validate      # parse + validate; prints the summary or every error (exit 5)
bin/operator-rules status        # summary, today's spend vs cap, NEAR AI Cloud configured?, live split check
bin/forwarder-runner --status    # the same summary + split check, then the forwarder preflight and queue
```

| Field | Meaning |
|---|---|
| `network` | `mainnet` (real money) or `testnet` (demo, `splitter-v2.nearbi-agent.testnet`). Picks the splitter, the key and the spend-ledger file. forwarder-runner is mainnet-only |
| `kill_switch` | `true` = stop acting at the next check |
| `max_inference_usd_per_day` | daily compute budget per UTC day, inference **and** BigQuery |
| `per_report_cost_cap_usd` | max total compute cost of one order/report |
| `min_price_usd.<product>` | floor per product (`subscription` 49, `quick_answer` 29, `deep_dive` 499); unlisted product = refused |
| `settlement_slippage_pct` | how far the *settled* USDC may fall below the floor (1Click spread); the quoted price must still reach it |
| `revenue_split` | `contributors_pct` / `treasury_pct` (sum 100, contributors ≤ 50) + the payout accounts per network |

**Validation** (`src/rs_agent/rules.py`, JSON Schema in `config.schema.json`, generated by
`bin/operator-rules schema` and pinned by a test): stdlib-only strict YAML subset (`src/rs_agent/miniyaml.py`:
mappings and scalars only; lists, flow maps, anchors, tabs, `yes/no` booleans, duplicate keys are errors);
unknown keys are errors, so a typo can't silently disable a rule; money has at most 6 decimals and is handled
as `Decimal`/integer micro-USD, never float. **Fail closed**: a missing or invalid file is treated as
`kill_switch: true`.

### Enforcement points

Each refusal is logged as `REFUSED (<rule>): <why>`; forwarder refusals are also journaled
(`forwarder-journal.jsonl`, `event: refused`).

| Rule | Where | Effect |
|---|---|---|
| kill switch | `forwarder-runner`: before the preflight, before each order, and again right before signing; `rules.check_job` (every paid job); `nearai.Client.chat`; `record-cost --send`; `operator-rules check-price` | nothing is forwarded/started/sent; forwarder exits 5 (`--loop` keeps waiting). Settled USDC stays in `forwarder.nearbi.near` until the switch is off. `record-cost` still books a cost that already happened (bookkeeping) |
| network | `forwarder-runner` | refuses unless `network: mainnet` |
| split check | `forwarder-runner` preflight + `--status`; `operator-rules status/check-split` | reads `splitter.get_config` over NEAR RPC and compares bps and both accounts (and `paused`). Mismatch or unreadable RPC → `ALERT: …` and exit 5. Change the contract first (owner `set_split`/`set_accounts`, rs-payments §8), then the file |
| min price | `forwarder-runner`, per order (`PaymentRecord.product` + `amountUsd` + settled amount); `operator-rules check-price` for the fulfilment side | that order is skipped with `ATTENTION … REFUSED (min_price)` (exit 2), the others proceed |
| daily cap | `rules.check_job` before any paid job: NEAR AI client, `operator-rules check-job` (for the rs-repro BigQuery runner) | refused if today's booked spend + the job's estimate > cap; waits for the next UTC day |
| per-report cap | same | refused if the order's booked costs + estimate > cap; the order needs a human |

### Spend ledger

Append-only JSONL, one file per network: `~/.local/state/rs-agent/spend-ledger.<network>.jsonl`
(`$RS_AGENT_STATE_DIR`, or `$RS_AGENT_SPEND_LEDGER` for the file). Each line: `seq, ts, day (UTC), network,
order_id, kind (inference|bigquery), usd_micros, usd, note, source, meta`, hash-chained exactly like
rs-ledger (`line_hash = sha256(canonical(body) + prev_hash)`, genesis = 64 zeros; a test cross-checks with
rs-ledger's `verify_ledger.py`). Writes take an flock and re-verify the chain. A broken chain refuses every new
job (`REFUSED (spend_ledger)`); `bin/operator-rules verify-spend` checks it. Amounts are rounded **up** to the
micro-dollar. Limit: check-then-book is not a reservation, so two jobs started at the same instant can each
pass the cap check; the agent runs jobs one at a time.

### bin/record-cost

```bash
bin/record-cost --order <id> --usd 0.42 --kind bigquery --note "q1-q4, 84 GB scanned"   # book + DRY RUN of the onchain call
bin/record-cost --order <id> --usd 0.42 --kind bigquery --send                           # book + send record_cost
bin/record-cost --from-line <seq> [--send]        # mirror a line already booked (e.g. by the NEAR AI client)
bin/record-cost --order <id> --usd 0.42 --kind bigquery --dry-run --preflight            # write/send nothing; check key + gas
```

It books the line, then prints the exact `splitter.record_cost(kind, amount_usd_micros, ref)` call (receiver,
args, 30 Tgas, 0 deposit, signer, key source, near-cli network). `ref` = `order:<id> spend:<line_hash[:16]>
<note>` (≤ 256 bytes), so the public onchain `cost` event points at the local ledger line. Only `--send`
broadcasts; the tx is then verified (a `nearbi_splitter` `cost` event with these exact args) and journaled in
`record-cost-onchain.<network>.jsonl`, so the same line is never sent twice. Signing: mainnet uses the
Keychain item `nearbi-mainnet-fc-splitter.nearbi.near` (function-call key `ed25519:HFbAT…DRZS`, methods
`[record_cost, anchor_report]`), testnet the chmod-600 file from rs-payments `deploy-testnet.sh`; either way
the secret is read into memory and passed to near-cli-rs via `/dev/fd/N`, never written, never on argv. The
preflight checks the onchain key permission, that the local secret is its private half, the allowance and the
splitter's free NEAR.

Proven on testnet 2026-11-04: `record_cost(inference, 12500, "order:demo-opsrules-20261104 spend:87532f87…")`,
tx [`4wF4n3vq…`](https://testnet.nearblocks.io/txns/4wF4n3vq9Rb1uXNqoPuRccXQ1sPbyh2J974YPAindyTW); a second
`--send` of the same line was refused as already recorded. Mainnet: dry-run + `--preflight` only (Keychain
key matches the onchain key; nothing sent).

### NEAR AI Cloud client (`src/rs_agent/nearai.py`)

OpenAI-compatible gateway `https://cloud-api.near.ai/v1` (docs.near.ai, checked 2026-11-03). Per call:
kill switch → upper-bound estimate (prompt chars/3 tokens + `max_tokens`, at the public `/v1/model/list`
price) → daily + per-report cap → `POST /v1/chat/completions` → cost = the billed `costNanoUsd` from
`POST /v1/billing/costs` for the `inference-id` header, else usage × list price → booked in the spend ledger
(`kind=inference`, model, tokens, inference id, cost source). A timeout is booked at the estimate; an HTTP
error books nothing; an unpriced model is refused. Default model `zai-org/GLM-5.1-FP8`.
An empty or `finish_reason=length` reply is still booked but flagged (`_rs_result.empty/truncated`, ledger meta, stderr WARNING); report code must use `nearai.text_of()`, which raises `EmptyCompletion` instead of shipping it.

**What the operator must provide**: a NEAR AI Cloud API key (cloud.near.ai → Credits → API Keys; set a
spend limit on the key there as a second cap), stored as a **protected secret**
`NEAR_AI_CLOUD_API_KEY` with allowed host `cloud-api.near.ai` (Control UI → Settings → Secrets, or
the gateway's secrets CLI), with the Gateway egress proxy enabled. The agent process then only sees an opaque
sentinel in `NEAR_AI_CLOUD_API_KEY`; the proxy substitutes the real key on the way out. Never in a file, `.env`
or chat. Until then `chat()` raises `NotConfigured` before anything is spent, and `operator-rules status`
says `UNCONFIGURED`.

**Status (2026-11-04):** configured. The key is held as a protected secret, swapped in by the egress proxy; the
client only sees a sentinel. Live calls are booked with `cost_source=billing` (the billed `costNanoUsd`).

## Report writer (v0.3.0)

`bin/write-report` is the "agent buys its own inference to write the report" step (ARCHITECTURE.md §3.4–3.5). It
writes a report's narrative from a **cached result pack** with paid NEAR AI Cloud inference. It runs no BigQuery query.

```bash
bin/write-report --order <id> --pack ../rs-reports/reports/near-users-vs-bots \
                 [--question "..."] [--model anthropic/claude-haiku-5-5] [--out DIR] \
                 [--max-tokens 8000] [--max-usd 1.00] [--param 30] [--force]
```

A pack is a directory with `manifest.json` (`result_sha256`/`sql_sha256` per query), `results/<q>.csv` and
`queries/<q>.sql` (the `-- question:` header becomes the query's description). The question defaults to the pack's
`REPORT.md` title, and its `params:` front matter declares the query parameters (window length, thresholds) that the
prose may cite.

### What one run does

1. **Pack**: every CSV and SQL file is hashed and must match the manifest. Otherwise the run is refused (exit 1) and nothing is paid.
2. **Rules before any paid call**: `config.yaml` is re-read; kill switch, `per_report_cost_cap_usd` and
   `max_inference_usd_per_day` are checked for the **worst case of both attempts** (prompt estimate + `max_tokens`
   at list price, the retry carrying a full draft back). That worst case must also fit `--max-usd` (default $1).
   `nearai.Client.chat` re-checks before each call.
3. **Prompt = structured data only**: the question, window, params and every result table as JSON. The pack's
   existing prose never reaches the model. The system prompt forbids any number that isn't a cell or a param:
   no sums, ratios, "3x", "million" or approximations.
4. **Sections (Track 02)**: the model writes `Claim · Evidence for · Evidence against · What would change the
   conclusion`. The parser requires exactly these headings, in order, with a bold claim sentence and no sub-headings or
   code. Chatter before the first heading is dropped. **`## Queries` is generated from the pack** (id, question, SQL
   file, rows, result SHA-256), never by the model.
5. **`nearai.text_of()`**: an empty or `finish_reason=length` reply raises `EmptyCompletion`. It is still booked, but it can't ship.
6. **Number post-check**: rs-reports `tools/check_numbers.check_text(..., rounding=True)`. Every number in the prose
   must be a result cell or a declared param. A decimal cell may be rounded to the decimals shown (93.03 → 93), but
   whole-number cells are never rounded. Integers of 5+ digits get thousands separators (the check ignores them).
7. **One regeneration**: if a draft has untraced numbers, bad structure or an empty reply, it is sent back once
   with the problems listed (each offending number and its line). If the second draft fails too, the run exits **6**
   and **nothing is written**. Both paid calls stay in the ledger.
8. **Output** (default `~/.local/state/rs-agent/reports/<order>/`): `report.md` and `meta.json`. `meta.json` has the
   question, claim, model, per-attempt tokens / inference id / billed cost / spend-ledger seq + line hash / outcome,
   totals, the order's ledger total, every result and SQL hash, the number-check result and `report_sha256`. Files
   are written atomically, `report.md` last. An existing `report.md` is never overwritten without `--force`.

All inference is booked under `--order` (`kind=inference`, `source=nearai`). Mirror a line onchain with
`bin/record-cost --from-line <seq> [--send]`.

| Exit | Meaning |
|---:|---|
| 0 | report written |
| 1 | pack/hash error, NEAR AI error, not configured (nothing paid) |
| 5 | refused by config.yaml or `--max-usd` (nothing paid) |
| 6 | paid, but the narrative failed the checks twice: no report |

### Model: `anthropic/claude-haiku-5-5`

Picked from `GET /v1/model/list` (2026-11-04) by sending one sample prompt (the q3 bucket table, "Claim + two
evidence items") to the cheapest chat models:

| model | $/M in · out | sample | verdict |
|---|---|---|---|
| `openai/gpt-5-nano` | 0.05 · 0.40 | 4,000 of 4,000 tokens went to reasoning, **empty reply** ($0.001635) | reasons first, unreliable |
| `google/gemini-2.5-flash-lite` | 0.10 · 0.40 | 157 tokens, $0.000143. Correct numbers, but it calls it "potential bot activity" | cheapest usable; flatter, less careful |
| `anthropic/claude-haiku-5-5` | 0.10 · 0.50 | 950 tokens (~700 hidden reasoning), $0.000572. *"…points to high-frequency, likely automated, signers rather than typical users, but the data cannot confirm which accounts are bots."* | **chosen**: the most careful Track-02 prose |

Haiku 5.5 spends hidden reasoning tokens, so the default `max_tokens` is 8000. A full report costs about **$0.002–0.004**,
under 0.05% of the $10 per-report cap. `--model google/gemini-2.5-flash-lite` is the fallback.

### First real report: `demo-report-1` (2026-11-04)

`bin/write-report --order demo-report-1 --pack ../rs-reports/reports/near-users-vs-bots` produced
[`examples/demo-report-1/report.md`](examples/demo-report-1/report.md) and its
[`meta.json`](examples/demo-report-1/meta.json). Attempt 1 was rejected for text before the first heading (now
dropped instead). Attempt 2 passed the number check: 25 numbers, 0 untraced. In total: 6,868 + 5,168 tokens,
**$0.003272 billed** (spend seq 6 `3bc82be2…`, seq 7 `5a33c2bf…`). The example predates the thousands-separator and
blank-line polish, so it is kept byte-identical to the delivered file (`report_sha256` in meta).

### Tests

`tests/test_report_writer.py` (offline; the real `nearai.Client` behind a scripted fake cloud, so rules and ledger
booking are the real code): pack loading + tamper refusal, prompt = data only, retry feedback, section parsing,
Queries from the pack, pass / fail→regenerate→pass / fail twice (nothing written, both calls booked), bad structure,
dropped preamble, empty and truncated replies, kill switch / per-report cap / daily cap / `--max-usd` refusals with
zero calls, never overwriting, unconfigured key, CLI exit codes. Needs the rs-reports checkout next to this repo
(or `$RS_REPORTS_DIR`) at `tools-v0.3.0` or later.

### Left for the order loop

- `write-report` is a single-order command. The order loop has to call it for a paid order, map the order's product to a pack/question, and deliver `report.md` + the pack.
- Exit 6 should mark the order "needs a human" (escalation, §3.4).
- Mirror the order's cost lines onchain (`record-cost --from-line --send`) and anchor `report_sha256` (`anchor_report`).
- Testnet demo (§3.7): set `network: testnet` so demo spend books in `spend-ledger.testnet.jsonl`.

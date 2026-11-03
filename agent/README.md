# rs-agent

The shop agent: order intake, config.yaml rules (spend cap, min price, split, kill switch), NEAR AI Cloud inference.

Part of the NEAR Hackathon one-agent research shop. See `rs-docs/ARCHITECTURE.md`.

Today it contains one service: the **forwarding agent** for live NearBI payments.

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

### Not wired: inference cost (`record_cost`)

The splitter's `record_cost(kind, amount_usd_micros, ref)` (function-call key
`nearbi-mainnet-fc-splitter.nearbi.near`) is the place for the inference cost of an order. The app does not
report a per-order cost yet (subscriptions have no per-order inference), so the runner does not call it.
When the order loop exists, it should write the cost on the order and the runner should call
`record_cost("inference", <usd micros>, <order id>)` after the forward.

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
                                          # dry-run, balance/gas/allowance stops, idempotency, recovery
```

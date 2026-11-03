# nearbi-app

The dynamic half of **nearbi.ai**: Sign in with NEAR (NEP-413), NEAR Intents subscriptions, gated reports
and container-registry pull tokens. Runs on **AWS Lambda (Node 22)** behind **CloudFront + API Gateway
HTTP API**, with **DynamoDB** (single table) for state and **S3** for private report content. The public
site (`./public`) is plain static files in S3 behind the same CloudFront distribution.

Part of the NEAR Hackathon one-agent research shop. See `rs-docs/ARCHITECTURE.md`.

> Status (v0.5.0): one-off checkout for the **Quick Answer ($29)** and **Deep Dive ($499)** reports next to the
> $49/month subscription, with the customer's brief, an ORDER per paid report and an ops loop to deliver it
> (see [One-off orders](#one-off-orders-quick-answer--deep-dive)).
>
> v0.4.0: deployed at https://nearbi.ai through `../nearbi-infra` (OpenTofu). Payments are
> **LIVE on NEAR mainnet** (`INTENTS_MODE=live`): checkout issues real 1Click deposit addresses, revenue
> settles as USDC on NEAR to `forwarder.nearbi.near` (plain `ft_transfer`), the forwarding agent
> (`rs-agent bin/forwarder-runner`) passes each order into `splitter.nearbi.near`, and every sale is on
> the public ledger (https://nearbi.ai/ledger/). See [Payments](#payments-near-intents-1click).

## What is real and what is stubbed

| Area | Status |
|---|---|
| NEP-413 payload serialization + ed25519 verification | **Real**, unit-tested with local keypairs |
| One-time challenges (nonce burn, 5 min expiry, replay protection) | **Real** (memory + DynamoDB conditional delete) |
| NEAR RPC `view_access_key` check (full-access keys only) | **Real** code; tests use a mocked `fetch` |
| Session cookie (HMAC-SHA256, HttpOnly/Secure/SameSite=Lax, 7 days) | **Real** |
| Subscription period math (calendar month, clamping, stacking) | **Real** |
| Checkout: **NEAR Intents 1Click quote** | **Real** (`src/intents/`): live token list, EXACT_OUTPUT quotes for the price in the settlement asset. Deployed with `INTENTS_MODE=live` (real deposit addresses, recipient `forwarder.nearbi.near`). `dry` uses DRY quotes and shows a "Preview" banner |
| Payment status | **Real** code: `GET /billing/status/:id` (checkout page, every 10 s) and the **scheduled sweep** (EventBridge Scheduler → same Lambda, every minute) poll 1Click and extend the subscription once on `SUCCESS`. Exercised offline; the first real payment is the operator's |
| Forwarding into the splitter | **Real**, outside this app: a 1Click `SUCCESS` is written to the `FWDQ` queue; `rs-agent bin/forwarder-runner` (operator's Mac, Keychain key) calls `forward(order_id, amount)` and marks the payment `forwardedTx` |
| Payment confirmation override | **Manual**: `POST /billing/confirm` with `ADMIN_TOKEN` |
| One-off reports (Quick Answer / Deep Dive) | **Real** checkout (same live 1Click settlement), brief validation, ORDER on `SUCCESS`, members "Your orders". **Fulfilment is manual**: the agent/operator lists open orders (`bin/list-orders`) and sets status + delivery link (`bin/update-order`); no email/Telegram notification is sent to the customer yet |
| Gating (public / session / subscriber) | **Real** |
| Private content: HTML proxied from S3, everything else via presigned S3 GET | **Real** code; presigning is tested offline, S3 reads with a fake client |
| DynamoDB single-table repository | **Real**; passes the shared repository contract against **DynamoDB Local** (`bin/test-dynamo-local.sh`), never against AWS |
| Registry pull tokens (`POST /registry/token`) | **Real** issue/revoke/validate (only sha256 stored) |
| Registry token-auth endpoint for Docker Distribution | **TODO**: contract below, not implemented |
| Frontend wallet sign-in (`public/js/login.js`) | Written, **not tested against a real wallet**. Loads wallet-selector from esm.sh at runtime; a manual paste-the-signature fallback is built in |
| Infra (CloudFront, API Gateway, Lambda, DynamoDB, S3, registry) | **Not in this repo** (operator's step) |

## Layout

```
src/
  core/            framework-agnostic logic, no I/O (all unit-tested directly)
    nep413.ts        NEP-413 borsh payload, sha256, ed25519 verify
    signin.ts        challenge creation + sign-in verification (nonce store and key check injected)
    session.ts       HMAC session token + cookie strings
    subscription.ts  period math and subscription state
    products.ts      product catalog (subscription / quick_answer / deep_dive), brief validation, order types
    gating.ts        path -> required access, access decision, report path parsing
    registry-token.ts token generation, hashing, validity, docker instructions
    account.ts, encoding.ts
  ports/           Repository and ContentStore interfaces
  adapters/        memory-repository, dynamo-repository, memory-content, s3-content, near-rpc
  intents/         NEAR Intents 1Click: typed client (timeouts, retries), adapter (token cache, USD quotes),
                   amounts (BigInt), settlement rules, 1Click status -> payment state
  services/        billing (tokens/checkout/status/confirm), orders (admin update), registry (issue/validate): core + Repository
  app.ts           Hono app; all dependencies injected
  lambda.ts        AWS Lambda entry (hono/aws-lambda), wires DynamoDB + S3; routes scheduler events to scheduled.ts
  scheduled.ts     EventBridge Scheduler tasks ({"nearbiTask":"sweep-payments"} -> background payment sweep)
  dev.ts           local dev server (in-memory storage, serves ./public)
  seed.ts          seed the report catalog into DynamoDB (operator-run)
  config.ts, catalog.ts, pages.ts
public/            static site (copied from ../nearbi-site) + JS/CSS for the dynamic pages
test/              vitest; network is blocked by test/setup/no-network.ts
  fixtures/1click/ responses recorded from the live 1Click API (bin/smoke-1click.sh --record)
```

## Development

Node/npm are not installed on the host; everything runs in Docker (`bin/node.sh` wraps
`docker run --rm -v "$PWD":/app -w /app node:22-slim`).

```bash
bin/node.sh npm ci
bin/node.sh npm test                 # vitest, offline
bin/node.sh npm run typecheck
bin/test-dynamo-local.sh             # repository contract against amazon/dynamodb-local (Docker, no AWS)
bin/smoke-1click.sh                  # opt-in LIVE check: real DRY quotes for $49 from a few assets (network)
bin/smoke-1click.sh --record         # same, and rewrite test/fixtures/1click/*.json
bin/node.sh npm run build            # -> dist/lambda/index.mjs (+ .map)
docker run --rm --network none -v "$PWD":/app -w /app \
  -e SESSION_SECRET=$(openssl rand -hex 32) -e ADMIN_TOKEN=x -e TABLE_NAME=t -e CONTENT_BUCKET=b -e AWS_REGION=us-east-1 \
  node:22-slim node scripts/smoke-lambda.mjs   # offline smoke test of the built bundle

# local dev server on :8787 (in-memory storage; sign-in still calls the real NEAR RPC)
PUBLISH_8787=1 bin/node.sh env SESSION_SECRET=$(openssl rand -hex 32) ADMIN_TOKEN=dev npm run dev
```

The dev server seeds a gated report `dev-premium-sample`. Checkout calls the real 1Click API (DRY quotes in
the default dry mode). To try a subscription locally, sign in, click Subscribe, get a preview quote, then
confirm that payment with the admin override:
`curl -XPOST localhost:8787/billing/confirm -H 'authorization: Bearer dev' -H 'content-type: application/json' -d '{"paymentId":"…","txHash":"dev-1"}'`.

## Configuration (Lambda environment)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SESSION_SECRET` | yes | | ≥ 32 chars. Secret, from SSM SecureString / Secrets Manager |
| `ADMIN_TOKEN` | yes | | Bearer token for `POST /billing/confirm` and `/billing/admin/*`. Secret |
| `TABLE_NAME` | yes (Lambda) | | DynamoDB table |
| `CONTENT_BUCKET` | yes (Lambda) | | private S3 bucket for report content |
| `CONTENT_PREFIX` | no | `""` | key prefix inside the bucket, e.g. `prod/` |
| `APP_ORIGIN` | no | `https://nearbi.ai` | comma-separated browser origins accepted by the CSRF check |
| `STATIC_ORIGIN` | no | | if the free sample ever reaches the Lambda it is redirected here |
| `ORIGIN_VERIFY_SECRET` | no | | if set, every request must carry `x-origin-verify: <secret>` (a CloudFront custom origin header). Secret |
| `PRESIGN_TTL_SECONDS` | no | `300` | max 3600 |
| `NEAR_RPC_URL` | no | `https://rpc.mainnet.near.org` | consider a dedicated RPC provider for production |
| `MONTHLY_PRICE_USD` | no | `49` | subscription price |
| `QUICK_ANSWER_PRICE_USD` | no | `29` | one-off Quick Answer price |
| `DEEP_DIVE_PRICE_USD` | no | `499` | one-off Deep Dive price |
| `AUTH_RECIPIENT` | no | `nearbi.ai` | NEP-413 recipient |
| `REGISTRY_HOST` | no | `registry.nearbi.ai` | |
| `FREE_REPORT_SLUGS` | no | `near-users-vs-bots,near-thesis` | comma-separated public reports (static site); legacy `FREE_REPORT_SLUG` still read |
| `INTENTS_MODE` | no | `dry` | `dry`: real DRY quotes, nothing payable, preview banner. `live`: real deposit addresses. Live **refuses to start** unless `SETTLEMENT_RECIPIENT` is a mainnet account |
| `SETTLEMENT_ASSET` | no | USDC on NEAR (`nep141:17208628…6133a1`) | 1Click asset id revenue settles in; the price is fixed in it (EXACT_OUTPUT) |
| `SETTLEMENT_RECIPIENT` | live only | | mainnet NEAR account receiving revenue (`*.near` or 64-hex implicit). Testnet accounts are rejected by 1Click and by the app |
| `SETTLEMENT_DELIVERY` | no | `transfer` | `transfer` (plain `ft_transfer`, refundable) or `ft_transfer_call` (experimental 1Click `customRecipientMsg` = `{"order_id": <paymentId>}`; **no refund if the receiver fails**; live also needs `SETTLEMENT_ACCEPT_NO_REFUND=yes`) |
| `ONECLICK_JWT` | no | | 1Click partner JWT, sent as `X-API-Key`. Not required; without it 1Click adds 25 bps. Secret |
| `ONECLICK_BASE_URL` | no | `https://1click.chaindefuser.com/v0` | |
| `QUOTE_SLIPPAGE_BPS` | no | `100` | max 500. Applied to the input side under EXACT_OUTPUT |
| `QUOTE_TTL_MINUTES` | no | `30` | quote deadline (60 min minimum for BTC-like chains) |

Lambda reads config once at cold start and fails fast if required variables are missing. Secrets are
injected as environment variables by the deploy (simplest). Reading them from SSM at cold start is not
implemented.

## Request routing (CloudFront)

One distribution for `nearbi.ai` with two origins:

- **static**: S3 bucket with `./public`, private, read through Origin Access Control (OAC).
- **app**: the API Gateway HTTP API default endpoint (`$default` stage, one `$default` route to the Lambda).

Cache behaviors, in precedence order:

| Path pattern | Origin | Methods | Cache | Notes |
|---|---|---|---|---|
| `/reports/near-users-vs-bots/*`, `/reports/near-thesis/*` (+ exact paths) | static | GET, HEAD | CachingOptimized | free reports stay public and cacheable |
| `/reports/*` | app | GET, HEAD | CachingDisabled | gated |
| `/auth/*`, `/api/*`, `/billing/*`, `/registry/*` | app | all | CachingDisabled | |
| `/login`, `/members`, `/members/*` | app | GET, HEAD | CachingDisabled | |
| `*` (default) | static | GET, HEAD | CachingOptimized | landing page, `/assets/*`, `/js/*` |

App behaviors need origin request policy **AllViewerExceptHostHeader** (cookies, query strings and the
`Origin` header must reach the app; the Host header must not, because API Gateway routes on it). Since
the app sees the API Gateway host and the browser sends `Origin: https://nearbi.ai`, `APP_ORIGIN` must
list the public origin(s). Set a custom origin header `x-origin-verify` on the app origin and the same
value in `ORIGIN_VERIFY_SECRET`, so the API Gateway URL cannot be used to bypass CloudFront.

The static origin needs a viewer-request CloudFront Function that maps `/path/` to `/path/index.html`
(S3 REST origins with OAC do not serve directory indexes) and redirects `/reports/near-users-vs-bots`
to the trailing-slash URL. Static files keep the paths used on GitHub Pages today.

Prefer API Gateway over a Lambda Function URL as the origin: a Function URL behind CloudFront OAC
requires viewers to sign POST bodies (`x-amz-content-sha256`), which browsers don't do. A Function URL
with `AuthType NONE` plus `ORIGIN_VERIFY_SECRET` also works; the handler supports both event formats.

## Private content (S3 + presigned URLs)

Bucket layout: `s3://$CONTENT_BUCKET/$CONTENT_PREFIX` + `reports/<slug>/index.html`,
`reports/<slug>/charts/*.png`, `reports/<slug>/<file>.pdf`. Block Public Access on, SSE-S3, no bucket policy for readers.

For an active subscriber:

- `GET /reports/<slug>/` (any `.html`): the Lambda reads the object and returns it with
  `cache-control: private, no-store`. HTML is proxied so its relative chart/PDF links resolve back to
  `/reports/<slug>/…` on nearbi.ai and go through the gate again.
- Any other file: `HeadObject` (clean 404 for missing files), then `302` to a **presigned GET URL** valid
  for `PRESIGN_TTL_SECONDS` (default 300 s) with `response-content-type`, `response-content-disposition`
  (inline for PDFs) and `response-cache-control: private, no-store`.

The Lambda role needs `s3:GetObject` on the content prefix **and `s3:ListBucket`** on the bucket.
Without ListBucket, S3 answers 403 instead of 404 for missing keys and the app returns 500. A presigned
URL also stops working when the role's session credentials expire, which can happen before the TTL on a
long-lived execution environment; with 300 s this is rare, and the browser just requests the page again.

The free reports (`near-users-vs-bots`, `near-thesis`) are never read from the private bucket. It lives in `public/` and is
served by the static origin.

## DynamoDB table design

One table, on-demand billing. Key schema: `PK` (S, partition) + `SK` (S, sort). TTL attribute: `ttl`
(epoch seconds). **No GSIs.** Every item also carries a `type` attribute.

| Entity | PK | SK | Attributes | Access pattern |
|---|---|---|---|---|
| Sign-in challenge | `NONCE#<nonce>` | `CHALLENGE` | `message`, `expiresAt`, `ttl` | Put (`attribute_not_exists`), consumed by conditional `DeleteItem` (`attribute_exists(PK)`, `ALL_OLD`) so only one caller wins |
| Account | `ACCT#<accountId>` | `PROFILE` | `createdAt` (`if_not_exists`), `lastLoginAt` | Update on every login |
| Subscription | `ACCT#<accountId>` | `SUB` | `status`, `currentPeriodEnd`, `lastPaymentTx`, `updatedAt` | Get (consistent) on every gated request |
| Current registry token | `ACCT#<accountId>` | `RTOKEN` | `tokenHash` | pointer used to revoke the previous token |
| Payment | `PAY#<paymentId>` | `PAYMENT` | `accountId`, `amountUsd`, `product` (`subscription` / `quick_answer` / `deep_dive`; absent on pre-v0.5 items = subscription), `brief` (map, one-off only), `token`, `depositAddress`, `status`, `txHash`, `createdAt`, `paidAt`, `quoteJson`, `mode`, `quoteId`, `depositMemo`, `destinationAsset`, `recipient`, `amountIn`, `amountInFormatted`, `minAmountIn`, `amountOut`, `deadline`, `intentsStatus`, `checkedAt`, `settlementTx`, `settledAmountOut`, `forwardedTx` (+ `forwardedAt`, `forwardedAmount`, written by the forwarding agent) | Put on checkout, Get + conditional Update on status poll, Get on confirm. Stub-era items read back with the 1Click fields null |
| Open live payment | `OPENPAY` | `PAY#<paymentId>` | `paymentId`, `createdAt`, `deadline` | Put with the live payment (same `TransactWriteItems`); Query `PK = OPENPAY` by the scheduled sweep; Delete when paid/refunded/failed, or 24 h past the deadline when expired |
| Forward queue | `FWDQ` | `PAY#<paymentId>` | `paymentId`, `amount` (settled `amountOut`, base units, or null), `recipient`, `destinationAsset`, `depositAddress`, `settlementTx`, `enqueuedAt` | Put (`attribute_not_exists`) on 1Click `SUCCESS`, **before** the subscription is extended; read and deleted by the forwarding agent (`rs-agent`) after `forward` is final onchain |
| Order | `ACCT#<accountId>` | `ORDER#<paymentId>` | `paymentId`, `accountId`, `product`, `brief` {`question`, `contact`, `scope`}, `amountUsd`, `status` (`paid` / `in_progress` / `delivered`), `deliveryUrl`, `createdAt`, `updatedAt` | Put with the payment's `paid` transition (one-off products only); Query `begins_with(SK, ORDER#)` for the members page; Update by the admin endpoint |
| Open order | `ORDERQ` | `ORDER#<paymentId>` | `paymentId`, `accountId`, `createdAt` | Put with the order; Query `PK = ORDERQ` by `bin/list-orders` / `GET /billing/admin/orders`; Delete when the order is `delivered` (re-put if it is re-opened) |
| Tx-hash claim | `TX#<txHash>` | `TX` | `paymentId`, `accountId` | makes a tx hash usable once |
| Registry token | `RTOK#<sha256(token)>` | `RTOKEN` | `accountId`, `expiresAt`, `revoked`, `createdAt`, `ttl` (= expiry + 90 days) | Get by hash on validation |
| Catalog entry | `CATALOG` | `REPORT#<slug>` | `slug`, `title`, `summary`, `publishedAt`, `isFree`, `pdfFile` | Query `PK = CATALOG` for the members page |

Atomic operations:

- **Confirm payment** is one `TransactWriteItems`: (1) payment `status IN (preview, pending, processing,
  incomplete, expired)` → `paid` (`refunded`/`failed` can never be paid); (2) put the
  `TX#` claim with `attribute_not_exists`; (3) set the subscription, conditional on `currentPeriodEnd`
  still equal to the value read before computing the new end (or the item not existing). The service
  retries a lost race up to 3 times, so two payments confirmed at once both count, and confirming the
  same payment twice never extends twice.
- **Confirm a one-off payment** (Quick Answer / Deep Dive) is one `TransactWriteItems` too: (1) the same
  payment condition (plus `accountId` match) → `paid`; (2) the `TX#` claim; (3) put the `ORDER` with
  `attribute_not_exists`; (4) put the `ORDERQ` entry. The subscription item is not touched, so a paid report
  never extends a subscription, and polling/sweeping/confirming again returns `alreadyPaid` without a second order.
- **Issue registry token** is one `TransactWriteItems`: put the new token, swap the account pointer
  (conditional on the old hash), mark the old token `revoked`.

Seed the catalog after creating the table: `TABLE_NAME=nearbi npm run seed` (with operator credentials).
`src/adapters/dynamo-repository.ts` exports `tableDefinition()` as the reference CreateTable input.

## Container registry plan (registry.nearbi.ai)

Self-hosted **Docker Distribution (`registry:2`)** with the S3 storage driver and **token auth delegated
to this app**:

- Runs as a container (e.g. ECS Fargate, 1 task) behind a load balancer with TLS for `registry.nearbi.ai`.
  Pulls are layer-heavy; don't route registry traffic through the Lambda or CloudFront.
- Storage: dedicated private bucket (e.g. `nearbi-registry`), `storage.s3` with the task role (no keys).
- `POST /registry/token` (implemented) gives a subscriber their pull credential: username = NEAR account,
  password = `nbr_…` token (256-bit random, only its sha256 stored, expires at the end of the current paid
  period, issuing a new one revokes the old one). After a renewal the subscriber has to issue a new token,
  because the old one keeps the old expiry.

### TODO: registry token-auth contract (not implemented)

Registry config (sketch):

```yaml
auth:
  token:
    realm: https://nearbi.ai/registry/auth
    service: registry.nearbi.ai
    issuer: nearbi.ai
    rootcertbundle: /etc/registry/nearbi-auth.crt
```

Flow the app must implement at **`GET /registry/auth`** (already routed to the app by the `/registry/*`
CloudFront behavior):

1. `docker pull` gets `401` from the registry with
   `WWW-Authenticate: Bearer realm="https://nearbi.ai/registry/auth",service="registry.nearbi.ai",scope="repository:nearbi/<slug>:pull"`.
2. Docker calls `GET /registry/auth?service=registry.nearbi.ai&scope=repository:nearbi/<slug>:pull`
   with `Authorization: Basic base64(<accountId>:<nbr_token>)`. `docker login` makes the same call with no
   `scope` (may include `offline_token=true&client_id=docker`).
3. The app must:
   - reject unless `service` equals `REGISTRY_HOST`;
   - validate the token with `validateRegistryToken()` (`src/services/registry.ts`, already implemented
     and tested), require the Basic username to equal the token's account, and require the account's
     subscription to still be active;
   - grant only `pull`, only on repositories under `nearbi/`, and ignore other requested actions. Push
     credentials for the publishing pipeline are a separate, admin-only path (not designed yet);
   - answer `200 {"token": "<jwt>", "access_token": "<jwt>", "expires_in": 300, "issued_at": "<RFC3339>"}`,
     or `401` with `WWW-Authenticate: Basic realm="registry.nearbi.ai"` on bad credentials.
4. JWT: ES256 (or RS256) signed with a private key held in Secrets Manager. The header carries the signing
   cert in `x5c` (or a `kid` in the libtrust format registry:2 expects) and the cert/CA is mounted into
   the registry as `rootcertbundle`. Claims: `iss` = `nearbi.ai`, `sub` = account id, `aud` =
   `registry.nearbi.ai`, `iat`/`nbf`/`exp` (≤ 5 min), `jti`, and
   `access: [{"type":"repository","name":"nearbi/<slug>","actions":["pull"]}]` (empty array for login).
5. Tests to add: scope parsing (several scopes, malformed ones), username mismatch, revoked/expired token,
   lapsed subscription, JWT verified against the public cert.

## Payments (NEAR Intents 1Click)

Checked against https://docs.near-intents.org (1Click pages, OpenAPI at
`https://1click.chaindefuser.com/docs/v0/openapi.yaml`) and the live API on 2026-11-02.

### Flow

1. `GET /members/checkout?product=subscription|quick_answer|deep_dive` (session; default `subscription`;
   signed-out visitors go to `/login?next=<path+query>`) loads `public/js/checkout.js`, which fetches `GET /billing/tokens`: the
   live `GET /v0/tokens` list (210 tokens on 2026-11-02), cached 5 min per Lambda environment and served
   stale for up to 1 h if 1Click is down. Popular assets first.
2. `POST /billing/checkout {product?, originAsset, refundTo?, brief?}` asks `POST /v0/quote` for
   `swapType: EXACT_OUTPUT`, `amount` = the product's catalog price in the settlement asset's base units
   (49 USD → `49000000` USDC; Quick Answer `29000000`, Deep Dive `499000000`). Any amount in the request body
   is ignored. One-off products need `brief: {question, contact?, scope?}` (see below), `depositType: ORIGIN_CHAIN`, `recipient: SETTLEMENT_RECIPIENT`,
   `recipientType: DESTINATION_CHAIN`, `deadline` = now + 30 min (60 for BTC-like chains),
   `slippageTolerance: 100`, `referral: nearbi`, `dry` = (`INTENTS_MODE` = `dry`). Refunds default to
   `refundType: INTENTS` / `refundTo: <signed-in NEAR account>` (no address to type, and 1Click charged
   no refund fee for it in the dry quotes, vs 2400 base units for an origin-chain refund on Base). Passing
   `refundTo` switches to `refundType: ORIGIN_CHAIN`. The payment is stored with deposit address, quote id
   (1Click `correlationId`), `amountIn`, assets, deadline and the full signed quote; status `pending`
   (live) or `preview` (dry).
3. The page shows amount to send (`amountIn`, which includes the slippage buffer; anything above
   `minAmountIn` that isn't needed is refunded), the deposit address (+ memo for chains that need one), a
   server-rendered QR code and a countdown. Live payments are polled every 10 s via
   `GET /billing/status/:id` (owner only), which calls `GET /v0/status?depositAddress=…` at most every 5 s
   per payment.
4. Status mapping (`src/intents/status-map.ts`): `PENDING_DEPOSIT` → `pending` (also a 404 "address not
   found"), `KNOWN_DEPOSIT_TX` / `PROCESSING` → `processing`, `INCOMPLETE_DEPOSIT` → `incomplete`,
   `SUCCESS` → `paid`, `REFUNDED` → `refunded`, `FAILED` → `failed`; unknown future values leave the
   payment unchanged. `pending` for 15 min past the deadline becomes `expired` (a late `SUCCESS` is still
   honoured). Before confirming, the status payload's embedded quote must match ours (deposit address,
   recipient, destination asset, EXACT_OUTPUT amount, settled `amountOut` ≥ price). `SUCCESS` calls
   `confirmPayment()` with the claim key `1click:<depositAddress>`, so it extends exactly once however
   often it's polled. `POST /billing/confirm` stays as the admin override.

### Findings

- **JWT: not required.** `/tokens`, `/quote` (dry and non-dry), `/status` all work without one
  (unauthenticated rate-limit headers: 1200 req/60 s). The partner JWT (Partner Dashboard,
  partners.near-intents.org) only changes fees: unauthenticated quotes pay an extra 25 bps; authenticated
  20 bps, or 1 bp on stablecoin pairs. In our unauthenticated dry quotes 1Click added
  `appFees: [{fee: 1}]` to the USDC→USDC route. Send it as `X-API-Key` (or `Authorization: Bearer`).
- **EXACT_OUTPUT: supported.** `amount` is the output; the response has `amountIn` (with slippage buffer)
  and `minAmountIn`. Deposit below `minAmountIn` → refunded by the deadline; above `amountIn` → excess
  refunded to `refundTo`.
- **Dry quotes** omit `depositAddress`, `deadline` and `timeWhenInactive`. Quotes answer **HTTP 201**.
  There is no quote id; `correlationId` + `timestamp` + `signature` (ed25519 by 1Click) identify a quote.
- **Recipient** format must match `recipientType`; **testnet accounts are rejected** (HTTP 400 "Internal
  server error" for `splitter.nearbi-agent.testnet`). Dry quotes therefore use the all-zero implicit
  account as an inert placeholder when no mainnet recipient is set. `deadline` in the past → 400
  "deadline is not valid"; a malformed `refundTo` → 400 "refundTo is not valid".
- **Contract delivery with `ft_transfer_call` + msg: yes, but experimental and unrefundable.** The quote
  field `customRecipientMsg` makes the NEAR withdrawal use `ft_transfer_call(msg)` instead of
  `ft_transfer`; the live API accepts it in a dry quote. The spec labels it "HIGHLY EXPERIMENTAL" and
  warns funds are lost for non-NEP-141 tokens, missing `storage_deposit`, or a receiver without
  `ft_on_transfer`. The Verifier docs (Withdrawals → "How msg affects refunds") add that any withdrawal
  with a `msg` gets **no refund** if the receiving call fails. Our splitter hands the tokens back to the sender
  (panic or full refund via `ft_resolve_transfer`) for a non-accepted token, a malformed msg and while
  paused; with 1Click as the sender that "refund" lands with the Verifier and is not credited back, so
  the payment would be lost. Untested end to end: it can only be verified with a real payment.

### Settlement design and trust tradeoff

Default (`SETTLEMENT_DELIVERY=transfer`): 1Click delivers plain `ft_transfer` USDC to a
**NearBI-controlled settlement account** (`SETTLEMENT_RECIPIENT`). A separate step forwards each payment
into the splitter with `ft_transfer_call(splitter, amount, {"order_id": <paymentId>})`. That forwarder is
not built yet; it could be the agent's key on the settlement account, or a small contract that holds the
settlement funds and only calls `ft_transfer_call` into the splitter.

- Trust: between delivery and forwarding, NearBI holds the revenue. The onchain split is enforced only
  once funds reach the splitter, so contributors trust the operator/agent to forward everything, promptly
  and with the right order ids. This is auditable (each 1Click withdrawal and each forward are public
  NEAR txs, matched by order id via the stored quote) but not enforced. A forwarding-only contract (no
  `ft_transfer` out except into the splitter) would remove most of that trust.
- Safety: plain `ft_transfer` withdrawals are refundable by the Verifier if they fail, and a failed
  forward stays in our account where it can be retried.

Opt-in (`SETTLEMENT_DELIVERY=ft_transfer_call`, `SETTLEMENT_RECIPIENT=<mainnet splitter>`): 1Click
calls the splitter directly with `{"order_id": <paymentId>}`, so the split is enforced from the first
block with no custody gap. The cost is the experimental API and **no refund** on failure. Payer
attribution changes too: the splitter's `sale.payer` would be the Verifier/1Click account, not the
customer; the order id is the only link. Live mode requires `SETTLEMENT_ACCEPT_NO_REFUND=yes` for this.

### Switching to `INTENTS_MODE=live` (operator)

1. Choose the settlement account (mainnet `*.near` or implicit) and who controls its keys; for the
   splitter path, deploy the mainnet splitter (owner, treasury, contributors, split bps, accepted token =
   USDC `17208628…6133a1`).
2. `storage_deposit` the recipient (and the splitter, treasury, contributors) on the USDC contract.
3. Decide `SETTLEMENT_DELIVERY` (`transfer` + forwarder, recommended; or `ft_transfer_call`, after a small
   real test payment).
4. Optional: get a partner JWT and store it as the `ONECLICK_JWT` secret.
5. Build the forwarder (for `transfer`) and a scheduled poller (EventBridge → status check for pending
   payments). **Done in v0.4.0**: the sweep below, and `rs-agent bin/forwarder-runner`.
6. Set `INTENTS_MODE=live` + `SETTLEMENT_RECIPIENT`; the Lambda won't start if the recipient isn't a
   mainnet account. Make one small real payment and follow it on explorer.near-intents.org.
   **Done 2026-11-03** (recipient `forwarder.nearbi.near`, delivery `transfer`); the first real payment is
   the operator's.

### Live configuration (since v0.4.0)

| Setting | Value |
|---|---|
| `INTENTS_MODE` | `live` |
| `SETTLEMENT_RECIPIENT` | `forwarder.nearbi.near` (rs-payments forwarder v0.2.0; can only send into `splitter.nearbi.near`) |
| `SETTLEMENT_ASSET` | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (Circle USDC, 6 decimals) |
| `SETTLEMENT_DELIVERY` | `transfer` (plain `ft_transfer`, refundable by the Verifier if it fails) |
| Split | `splitter.nearbi.near`: 10 % `contributors.nearbi.near`, 90 % `nearbi.near` |

The checkout and members pages say, in live mode: "Payments settle as USDC on NEAR into an onchain revenue
splitter; see the public ledger", and name the forwarder and splitter accounts.

### Background confirmation (scheduled sweep)

EventBridge Scheduler (`nearbi-payment-sweep`, `rate(1 minute)`, in `../nearbi-infra/tofu/scheduler.tf`)
invokes the same Lambda with the fixed input `{"nearbiTask":"sweep-payments"}`. `src/lambda.ts` routes that
shape (no `requestContext`, so no HTTP request can produce it) to `sweepOpenPayments()`:

- Query `PK = OPENPAY` (every live payment is indexed there atomically with its creation), then per payment
  the same `refreshPayment()` the checkout page uses: 1Click `/status`, quote match, status mapping,
  once-only `confirmPayment()`. Running it concurrently with the page poller is safe.
- On `SUCCESS` with `SETTLEMENT_DELIVERY=transfer`: store `settledAmountOut` (1Click `swapDetails.amountOut`)
  and put the payment on the `FWDQ` forward queue **before** extending the subscription.
- The index entry is removed once the payment is `paid` / `refunded` / `failed`, or 24 h after the deadline
  for `expired` ones (a late `SUCCESS` inside that window still confirms; later only via the page or the
  admin override).
- 7 s time budget per run (Lambda timeout 10 s), up to 500 open payments, visited in random order with 4 in
  parallel, so a long list can't starve its tail; whatever doesn't fit is picked up next minute.
- 1Click keeps a deposit address open **~72 h past the deadline we request** (we ask for +30 min; the live
  quote on 2026-11-03 came back with `deadline` = request + 72 h, and the page shows that real window). An
  abandoned checkout therefore stays open for days: payments older than 1 h with no deposit seen are
  re-checked at most every 10 min (`SWEEP_FAST_AGE`, `SWEEP_SLOW_RECHECK`), younger ones every minute.
- Each run logs one JSON line: `{"task":"sweep-payments","mode":"live","open":…,"checked":…,"deferred":…,"closed":…,"paid":…,"errors":…,"truncated":…}`.

The admin override (`POST /billing/confirm`) does **not** queue a forward (it has no settled amount);
forward such a payment by hand with `rs-agent bin/forwarder-runner --order <paymentId> --amount <base units>`.

## One-off orders (Quick Answer / Deep Dive)

Since v0.5.0 the two report products can be bought directly, alongside the subscription. Ecosystem Reports
(from $2,500) stay quote-by-email (`mailto:` on the landing page), with no checkout.

| Product id | Price (env, default) | Delivery promised | Effect when paid |
|---|---|---|---|
| `subscription` | `MONTHLY_PRICE_USD` (49) | | extends the subscription by one month (unchanged) |
| `quick_answer` | `QUICK_ANSWER_PRICE_USD` (29) | within 24 h | creates an ORDER, subscription untouched |
| `deep_dive` | `DEEP_DIVE_PRICE_USD` (499) | within 48 h | creates an ORDER, subscription untouched |

**Customer flow.** Landing page `#order` → "Order: $29" / "Order: $499" →
`/members/checkout?product=quick_answer|deep_dive` (sign-in first; `next` keeps the product) → the checkout form
asks for the brief: **question** (required, ≤ 2,000 chars), **contact** (optional email or Telegram handle,
≤ 200), and for Deep Dive an optional **topic/scope** (≤ 2,000). The server validates it
(`validateBrief`, control characters stripped), stores it on the payment, and quotes the product's price with the
same live settlement as the subscription (USDC on NEAR to `forwarder.nearbi.near`). On 1Click `SUCCESS` (page
poll or the minute sweep) the payment is queued on `FWDQ` exactly like a subscription, so the revenue still goes
through the splitter, and the ORDER is created (status `paid`). The members page lists **Your orders**
(product, date, status paid → in progress → delivered, and the delivery link once set).

**Agent / operator fulfilment.**

```bash
AWS_PROFILE=nearbi bin/list-orders            # open orders (paid / in_progress), oldest first, brief + due time
AWS_PROFILE=nearbi bin/list-orders --json     # same, machine-readable (orderId, accountId, product, brief, ...)
AWS_PROFILE=nearbi bin/update-order <orderId> in_progress
AWS_PROFILE=nearbi bin/update-order <orderId> delivered https://nearbi.ai/reports/<slug>/   # or a /path
```

- `bin/list-orders` reads DynamoDB directly (read-only: `ORDERQ` query + `GetItem`), needs `aws` + `jq`.
- `bin/update-order` calls the admin endpoint with the `ADMIN_TOKEN` from SSM `/nearbi/app/ADMIN_TOKEN` (or
  `$NEARBI_ADMIN_TOKEN`). "delivered" needs a link (https URL or a nearbi.ai path) and removes the order from the
  open list.
- HTTP equivalents (bearer `ADMIN_TOKEN`, no session): `GET /billing/admin/orders` (open orders) and
  `POST /billing/admin/orders/<orderId> {status?, deliveryUrl?}`. The signed-in customer sees their own orders at
  `GET /billing/orders` and on `/members`.
- Delivering a private report: upload it to the content bucket under `reports/<slug>/` (as for any gated
  report) and set the delivery link to `/reports/<slug>/` (or `https://nearbi.ai/reports/<slug>/`). Once the order
  is `delivered`, its buyer can open that one report (and its files) without a subscription; everyone else still
  needs a subscription. Use a fresh slug per order if the report is private to that customer.
- Nothing notifies the customer automatically: if they left a contact, message them with the link.
- The admin override `POST /billing/confirm` also works for a one-off payment (it creates the order), but as for
  subscriptions it does not queue a forward.

## Deploy: AWS resources

Everything the operator's infra step needs to create. Region: any for the app; the CloudFront
certificate must be in **us-east-1**.

**Edge / DNS**
- Route 53 hosted zone `nearbi.ai` (or external DNS): `nearbi.ai` (+ optional `www`) ALIAS → CloudFront;
  `registry.nearbi.ai` → registry load balancer.
- ACM certificate for `nearbi.ai` (+ `www`) in **us-east-1** (CloudFront); a second one for
  `registry.nearbi.ai` in the registry's region.
- CloudFront distribution with the two origins, the behaviors above, OAC for the static bucket, the
  `x-origin-verify` custom header on the app origin, and the index-rewrite CloudFront Function.

**Static site**
- S3 bucket `nearbi-site` (private, Block Public Access, bucket policy allowing only the distribution via
  OAC), contents = `./public` synced on deploy (`aws s3 sync public/ s3://nearbi-site/ --delete`).

**App**
- Lambda function `nearbi-app`: runtime `nodejs22.x`, arm64, handler `index.handler`, code =
  `dist/lambda/index.mjs` zipped, 512 MB, 10 s timeout, environment as in the table above.
- API Gateway **HTTP API** `nearbi-app`: `$default` stage with auto-deploy, `$default` route → Lambda
  proxy integration (payload format 2.0), plus a resource-based permission letting it invoke the Lambda.
- CloudWatch log group `/aws/lambda/nearbi-app` (set a retention).
- Lambda execution role:
  - `AWSLambdaBasicExecutionRole` (logs);
  - DynamoDB on the table ARN: `GetItem`, `PutItem`, `UpdateItem`, `DeleteItem`, `Query`,
    `ConditionCheckItem` (`TransactWriteItems` uses these per item);
  - S3: `s3:GetObject` on `arn:aws:s3:::nearbi-content/reports/*` (with the prefix if `CONTENT_PREFIX` is
    set) and `s3:ListBucket` on `arn:aws:s3:::nearbi-content`;
  - if secrets are read at deploy time only, no runtime secrets permissions are needed.

**Data**
- DynamoDB table `nearbi`: `PK` (S) HASH, `SK` (S) RANGE, on-demand, TTL enabled on `ttl`,
  point-in-time recovery on. Seed with `npm run seed`.
- S3 bucket `nearbi-content` (private, Block Public Access, SSE-S3, versioning recommended) for gated reports.

**Secrets** (SSM Parameter Store SecureString or Secrets Manager)
- `SESSION_SECRET` (≥ 32 random bytes), `ADMIN_TOKEN`, `ORIGIN_VERIFY_SECRET`.
- Later: the registry JWT signing key (`nearbi/registry-jwt-key`) and `ONECLICK_JWT` if one is used.

**Registry** (when the token-auth endpoint exists)
- S3 bucket `nearbi-registry` (private) and a task role with `s3:ListBucket`, `s3:GetBucketLocation`,
  `s3:ListBucketMultipartUploads` on the bucket and `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`,
  `s3:ListMultipartUploadParts`, `s3:AbortMultipartUpload` on its objects.
- ECS cluster + Fargate service running `registry:2` (config from the contract above, cert bundle mounted
  from Secrets Manager/SSM), ALB or NLB with the `registry.nearbi.ai` certificate, security groups.

**Later**
- EventBridge Scheduler rule + Lambda for 1Click status polling of payments nobody is watching.

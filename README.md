# nearbi-app

The dynamic half of **nearbi.ai**: Sign in with NEAR (NEP-413), NEAR Intents subscriptions, gated reports
and container-registry pull tokens. Runs on **AWS Lambda (Node 22)** behind **CloudFront + API Gateway
HTTP API**, with **DynamoDB** (single table) for state and **S3** for private report content. The public
site (`./public`) is plain static files in S3 behind the same CloudFront distribution.

Part of the NEAR Hackathon one-agent research shop. See `rs-docs/ARCHITECTURE.md`.

> Status: code and tests only. Nothing has been deployed and no AWS resources exist yet. Infra (IaC) is
> the operator's step; the exact resources are listed under [Deploy: AWS resources](#deploy-aws-resources).

## What is real and what is stubbed

| Area | Status |
|---|---|
| NEP-413 payload serialization + ed25519 verification | **Real**, unit-tested with local keypairs |
| One-time challenges (nonce burn, 5 min expiry, replay protection) | **Real** (memory + DynamoDB conditional delete) |
| NEAR RPC `view_access_key` check (full-access keys only) | **Real** code; tests use a mocked `fetch` |
| Session cookie (HMAC-SHA256, HttpOnly/Secure/SameSite=Lax, 7 days) | **Real** |
| Subscription period math (calendar month, clamping, stacking) | **Real** |
| Checkout: **NEAR Intents 1Click quote** | **STUB**: `src/adapters/intents.ts` returns `STUB-NOT-A-REAL-ADDRESS-…`; the UI shows a "Test mode, do not send funds" banner |
| Payment confirmation | **Manual**: `POST /billing/confirm` with `ADMIN_TOKEN`. 1Click status polling is a TODO |
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
    gating.ts        path -> required access, access decision, report path parsing
    registry-token.ts token generation, hashing, validity, docker instructions
    account.ts, encoding.ts
  ports/           Repository and ContentStore interfaces
  adapters/        memory-repository, dynamo-repository, memory-content, s3-content, near-rpc, intents (STUB)
  services/        billing (checkout/confirm), registry (issue/validate): core + Repository
  app.ts           Hono app; all dependencies injected
  lambda.ts        AWS Lambda entry (hono/aws-lambda), wires DynamoDB + S3
  dev.ts           local dev server (in-memory storage, serves ./public)
  seed.ts          seed the report catalog into DynamoDB (operator-run)
  config.ts, catalog.ts, pages.ts
public/            static site (copied from ../nearbi-site) + JS/CSS for the dynamic pages
test/              vitest; network is blocked by test/setup/no-network.ts
```

## Development

Node/npm are not installed on the host; everything runs in Docker (`bin/node.sh` wraps
`docker run --rm -v "$PWD":/app -w /app node:22-slim`).

```bash
bin/node.sh npm ci
bin/node.sh npm test                 # vitest, offline
bin/node.sh npm run typecheck
bin/test-dynamo-local.sh             # repository contract against amazon/dynamodb-local (Docker, no AWS)
bin/node.sh npm run build            # -> dist/lambda/index.mjs (+ .map)
docker run --rm --network none -v "$PWD":/app -w /app \
  -e SESSION_SECRET=$(openssl rand -hex 32) -e ADMIN_TOKEN=x -e TABLE_NAME=t -e CONTENT_BUCKET=b -e AWS_REGION=us-east-1 \
  node:22-slim node scripts/smoke-lambda.mjs   # offline smoke test of the built bundle

# local dev server on :8787 (in-memory storage; sign-in still calls the real NEAR RPC)
PUBLISH_8787=1 bin/node.sh env SESSION_SECRET=$(openssl rand -hex 32) ADMIN_TOKEN=dev npm run dev
```

The dev server seeds a gated report `dev-premium-sample`. To try a subscription locally, sign in, click
Subscribe, then confirm the stub payment:
`curl -XPOST localhost:8787/billing/confirm -H 'authorization: Bearer dev' -H 'content-type: application/json' -d '{"paymentId":"…","txHash":"dev-1"}'`.

## Configuration (Lambda environment)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SESSION_SECRET` | yes | | ≥ 32 chars. Secret, from SSM SecureString / Secrets Manager |
| `ADMIN_TOKEN` | yes | | Bearer token for `POST /billing/confirm`. Secret |
| `TABLE_NAME` | yes (Lambda) | | DynamoDB table |
| `CONTENT_BUCKET` | yes (Lambda) | | private S3 bucket for report content |
| `CONTENT_PREFIX` | no | `""` | key prefix inside the bucket, e.g. `prod/` |
| `APP_ORIGIN` | no | `https://nearbi.ai` | comma-separated browser origins accepted by the CSRF check |
| `STATIC_ORIGIN` | no | | if the free sample ever reaches the Lambda it is redirected here |
| `ORIGIN_VERIFY_SECRET` | no | | if set, every request must carry `x-origin-verify: <secret>` (a CloudFront custom origin header). Secret |
| `PRESIGN_TTL_SECONDS` | no | `300` | max 3600 |
| `NEAR_RPC_URL` | no | `https://rpc.mainnet.near.org` | consider a dedicated RPC provider for production |
| `MONTHLY_PRICE_USD` | no | `49` | |
| `AUTH_RECIPIENT` | no | `nearbi.ai` | NEP-413 recipient |
| `REGISTRY_HOST` | no | `registry.nearbi.ai` | |
| `FREE_REPORT_SLUG` | no | `near-users-vs-bots` | the only public report |

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
| `/reports/near-users-vs-bots/*` | static | GET, HEAD | CachingOptimized | the free sample stays public and cacheable |
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

The free sample `near-users-vs-bots` is never read from the private bucket. It lives in `public/` and is
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
| Payment | `PAY#<paymentId>` | `PAYMENT` | `accountId`, `amountUsd`, `token`, `depositAddress`, `status`, `txHash`, `createdAt`, `paidAt`, `quoteJson` | Put on checkout, Get on confirm |
| Tx-hash claim | `TX#<txHash>` | `TX` | `paymentId`, `accountId` | makes a tx hash usable once |
| Registry token | `RTOK#<sha256(token)>` | `RTOKEN` | `accountId`, `expiresAt`, `revoked`, `createdAt`, `ttl` (= expiry + 90 days) | Get by hash on validation |
| Catalog entry | `CATALOG` | `REPORT#<slug>` | `slug`, `title`, `summary`, `publishedAt`, `isFree`, `pdfFile` | Query `PK = CATALOG` for the members page |

Atomic operations:

- **Confirm payment** is one `TransactWriteItems`: (1) payment `status = pending` → `paid`; (2) put the
  `TX#` claim with `attribute_not_exists`; (3) set the subscription, conditional on `currentPeriodEnd`
  still equal to the value read before computing the new end (or the item not existing). The service
  retries a lost race up to 3 times, so two payments confirmed at once both count, and confirming the
  same payment twice never extends twice.
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

## Payments TODO (NEAR Intents 1Click)

`src/adapters/intents.ts` is a stub. Real integration: `POST https://1click.chaindefuser.com/v0/quote`
(EXACT_OUTPUT into USDC on NEAR, recipient = treasury account), then poll
`GET /v0/status?depositAddress=…` from a scheduled Lambda (EventBridge Scheduler) and call
`confirmPayment()` on `SUCCESS`, which replaces the manual `POST /billing/confirm`. Check the request shape
against the current 1Click docs before shipping.

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
- Later: the registry JWT signing key (`nearbi/registry-jwt-key`) and the 1Click JWT if one is used.

**Registry** (when the token-auth endpoint exists)
- S3 bucket `nearbi-registry` (private) and a task role with `s3:ListBucket`, `s3:GetBucketLocation`,
  `s3:ListBucketMultipartUploads` on the bucket and `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`,
  `s3:ListMultipartUploadParts`, `s3:AbortMultipartUpload` on its objects.
- ECS cluster + Fargate service running `registry:2` (config from the contract above, cert bundle mounted
  from Secrets Manager/SSM), ALB or NLB with the `registry.nearbi.ai` certificate, security groups.

**Later**
- EventBridge Scheduler rule + Lambda for 1Click status polling.

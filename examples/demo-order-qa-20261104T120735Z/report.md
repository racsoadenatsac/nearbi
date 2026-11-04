---
title: "NEAR activity: real users or bots?"
order: qa-20261104T120735Z
window: 2026-09-08 .. 2026-10-07
dataset: bigquery-public-data.crypto_near_mainnet_us
params: [10, 100, 15, 30, 2, 1000]
narrative_model: anthropic/claude-haiku-5-5
pack: near-users-vs-bots
---

# NEAR activity: real users or bots?

*Research Shop report · order `qa-20261104T120735Z` · narrative written by `anthropic/claude-haiku-5-5` on NEAR AI Cloud from the cached results of pack `near-users-vs-bots`; every number traces to a result cell.*

## Claim

**The window's NEAR transaction volume is concentrated in a few high-frequency signers, most of which look like infrastructure or automated accounts, so the data supports "mostly automated by volume" but does not show that real users are absent.**

Most signers are light, low-frequency accounts, which is consistent with human use. The query results cannot label any account as a bot or a person, so the conclusion rests on activity patterns alone.

## Evidence for

1. **Five-tier activity buckets put 80.7% of transactions in 90 signers.** The industrial bucket (1000+ per day) holds 20,446,122 transactions (q3).
2. **The 266 automated signers (100-1000 per day) account for 4.1% of transactions (q3).** Adding the heavy bucket, 7,510 signers account for 2.9% of transactions (q3).
3. **The top 10 signers account for 69% of transactions on 2026-10-01 and 50.9% on 2026-10-07 (q2).** The top 100 account for 85.6% on 2026-10-01 and 76.5% on 2026-10-07 (q2).
4. **The busiest named accounts are mostly relayers, bridges, or intents contracts.** `sweat-relayer.near` shows 7,429,693 transactions over 30 active days. `intents.near` shows 1,390,976 over 30 active days. Other entries include `bridge-mng.near`, `omni-relayer.bridge.near`, `meteor-relayer.near`, and `relay.aurora` (q4).
5. **Accounts in the top 15 were active on 30 days, or on 28 or 27 days in two cases.** These are steady, daily patterns, not sporadic use (q4).

## Evidence against

1. **Light signers are most of the accounts, at 93.03% of all signers, though they produce only 8.9% of transactions (q3).** Accounts that transact fewer than twice a day are what a broad user base would look like, and the data cannot rule out that these are real users.
2. **Distinct signers rose from 42,517 on 2026-09-16 to 175,774 on 2026-10-07 (q1).** Transactions per signer fell to 3.9 on 2026-10-03 (q1). A broad influx of new signers may be genuine participation, but the results do not show whether these accounts are new users or new scripts.
3. **Concentration varies over the window.** The top-100 share was 65.7% on 2026-10-03, its lowest value here (q2), and the top 10 share was 45.3% on 2026-09-28 (q2). The busiest signers do not dominate every day equally.
4. **One of the top 15 signers is an unlabelled 64-character hex account with 289,300 transactions (q4).** Hex-named accounts can be contracts or individual wallets, and nothing in the results tells them apart.
5. **The data has no labels, contract metadata, method names, or timing intervals.** The buckets measure how often an account signs, not whether it is scripted. Calling any account a bot would need more than this data (all queries).

## What would change the conclusion

- **Operator or contract labels for the top 100 signers.** If most of the 90 industrial and 266 automated accounts are confirmed as bridges, relayers, or protocol contracts, the "automated" reading holds. If many are known end-user wallets, it weakens.
- **A first-seen date query for signers active after 2026-10-02.** If the jump in distinct signers (q1) comes from accounts with a few transactions each and no regular timing, it points toward broad user participation. If it comes from new high-frequency accounts, it points toward automation.
- **An inter-transaction interval distribution for light and regular signers (q3 buckets).** Very regular intervals across many accounts would suggest scripting even in the lower buckets. Irregular, human-like gaps would support real users.
- **Transaction counts split by method or contract for `sweat-relayer.near` and `intents.near` (q4).** If those transactions are initiated by end users through a front end, the relayer-as-bot reading would be wrong.

## Queries

| id | question | file | rows | result SHA-256 |
|---|---|---|---|---|
| q1 | Daily transactions, distinct signers and transactions per signer. | `queries/q1_daily_activity.sql` | 30 | `0c049f8f929b60160c457391317c81d574d82305f170932338c050853254fe57` |
| q2 | What share of each day's transactions comes from the 10 / 100 busiest signers? | `queries/q2_concentration.sql` | 30 | `e7efbd908266179b0a7608bfc60e147882a853330cc05c5090d4eeebac0397a6` |
| q3 | Over the whole window, how are signers and transactions split by how active a signer is? | `queries/q3_signer_buckets.sql` | 5 | `2133327d741d455519e1058ba68b194f64a83446232e2e6ec9ca1cb2ab541e53` |
| q4 | Who are the 15 busiest signers over the window, and how many days were they active? | `queries/q4_top_signers.sql` | 15 | `2233ef9483e1f6670ea41c2afd4c598a2fb1e02a3021951122f19849d889cd06` |

Every result above is a cached, canonical CSV from the pack; its SHA-256 is checked against the pack's `manifest.json` before the narrative is written. Every number in the sections above was checked against these results (rs-reports `tools/check_numbers.py`, rounding allowed).

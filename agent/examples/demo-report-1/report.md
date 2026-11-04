---
title: "NEAR activity: real users or bots?"
order: demo-report-1
window: 2026-09-08 .. 2026-10-07
dataset: bigquery-public-data.crypto_near_mainnet_us
params: [10, 100, 15, 30, 2, 1000]
narrative_model: anthropic/claude-haiku-5-5
pack: near-users-vs-bots
---

# NEAR activity: real users or bots?

*Research Shop report · order `demo-report-1` · narrative written by `anthropic/claude-haiku-5-5` on NEAR AI Cloud from the cached results of pack `near-users-vs-bots`; every number traces to a result cell.*

## Claim

**Activity is concentrated in a small set of very high-volume signers that look automated, while most signers are light users; the data does not show that any specific account is a bot.**
The volume pattern points toward automation, but the query results contain only counts and rate buckets, not labels or behavioral evidence. The bucket thresholds are a rate heuristic, so the split is an inference from activity level.

## Evidence for

1. **The 90 signers above 1000 transactions per day account for 80.7% of the window's transactions.** Those signers made 20446122 transactions in total, while the 795727 light signers made 8.9% of transactions (q3).
2. **One signer dominates the top of the ranking.** `sweat-relayer.near` made 7429693 transactions across 30 active days, a tx_per_active_day value of 247656 (q4). Every account listed in the top-signer query was active on at least 27 of the 30 days, which is consistent with scheduled or programmatic activity (q4).
3. **The top 100 signers' share of daily transactions stayed high for most of the window.** It ranged from 65.7% on 2026-10-03 to 91.5% on 2026-09-16 (q2).
4. **Transactions per signer swung widely, which fits a shift between a steady high-volume base and a broad, thin layer.** Daily transactions per signer ranged from 3.9 on 2026-10-03 to 19.1 on 2026-09-27 (q1).

## Evidence against

1. **Most signers are light users.** 795727 signers (93.03%) made fewer than 2 transactions per day over the window (q3). That is a large base that does not fit a bot-only story, although the data does not show what those transactions are.
2. **Distinct signers rose sharply in the last week of the window.** Distinct signers went from 42517 on 2026-09-16 to 176719 on 2026-10-03 and were 175774 on 2026-10-07 (q1). A new broad cohort of signers could be real users, but the data does not show their behavior or whether they persist.
3. **Several of the busiest accounts have infrastructure-style names.** `intents.near`, `relay.aurora`, `omni-relayer.bridge.near`, `bridge-mng.near`, and `meteor-relayer.near` appear among the top signers (q4). Shared relayers or bridges can generate high volume on behalf of many end users, so volume from them does not identify bots. The names are not labels, though, and the data does not confirm their roles.
4. **The top-10 share has fallen since the start of the window.** It was 69 on 2026-09-08 and 50.9 on 2026-10-07 (q2), so concentration is not fixed.
5. **The data has no contract, method, or timing fields.** The results contain counts per signer and per day only, so they cannot show whether transactions are user-initiated, how regular the timing is, or what the transactions do (q1, q3, q4).

## What would change the conclusion

- **Method or contract labels for the top signers.** If `sweat-relayer.near`, `intents.near`, and the other high-volume accounts are shown to be protocol or bridge infrastructure, the high volume reflects shared services rather than bot-like accounts, which weakens the claim.
- **Inter-transaction timing for the top 100 signers.** Very regular intervals across many accounts would strengthen the automation reading; irregular, human-scale timing would weaken it.
- **A query tracking the signers first seen after 2026-10-02 over a longer period.** If that cohort stays active and its transactions per signer stay low, that supports real broad usage; if it disappears within days, the spike looks like a short-lived event.
## Queries

| id | question | file | rows | result SHA-256 |
|---|---|---|---|---|
| q1 | Daily transactions, distinct signers and transactions per signer. | `queries/q1_daily_activity.sql` | 30 | `0c049f8f929b60160c457391317c81d574d82305f170932338c050853254fe57` |
| q2 | What share of each day's transactions comes from the 10 / 100 busiest signers? | `queries/q2_concentration.sql` | 30 | `e7efbd908266179b0a7608bfc60e147882a853330cc05c5090d4eeebac0397a6` |
| q3 | Over the whole window, how are signers and transactions split by how active a signer is? | `queries/q3_signer_buckets.sql` | 5 | `2133327d741d455519e1058ba68b194f64a83446232e2e6ec9ca1cb2ab541e53` |
| q4 | Who are the 15 busiest signers over the window, and how many days were they active? | `queries/q4_top_signers.sql` | 15 | `2233ef9483e1f6670ea41c2afd4c598a2fb1e02a3021951122f19849d889cd06` |

Every result above is a cached, canonical CSV from the pack; its SHA-256 is checked against the pack's `manifest.json` before the narrative is written. Every number in the sections above was checked against these results (rs-reports `tools/check_numbers.py`, rounding allowed).

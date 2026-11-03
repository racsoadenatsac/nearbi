# COSTS

BigQuery on-demand, billed to the operator's project at $6.25/TB. Budget: **$8** (≈1.28 TB). Dry runs are free and were run before every job; the runner refuses a step whose dry-run total would push this ledger over the budget (`MAX_USD_TOTAL`).

| # | when (UTC) | step | job | GB billed | USD | running USD | note |
|---|---|---|---|---:|---:|---:|---|
| 1 | 2026-11-02 22:23 | probe | `p1_delegate_semantics` | 2.19 | 0.0137 | 0.0137 | 1 day receipt_actions: how DELEGATE_ACTION rows are recorded |
| 2 | 2026-11-02 22:23 | probe | `p2_intents_ft_shape` | 0.10 | 0.0006 | 0.0143 | 1 day ft_events touching intents.near |
| 3 | 2026-11-02 22:23 | probe | `p3_ft_standards` | 0.04 | 0.0003 | 0.0145 | 1 day ft_events: which token standards appear (nep141 only) |
| 4 | 2026-11-02 22:25 | probe | `p4_nep245_logs` | 2.09 | 0.0130 | 0.0276 | 1 day execution_outcomes logs of intents.near: NEP-245 present? |
| 5 | 2026-11-02 22:25 | probe | `p5_intents_token_list` | 12.69 | 0.0793 | 0.1069 | 24 sampled days: which token contracts move through intents.near |
| 6 | 2026-11-02 22:33 | stage | `s1_tx_accounts` | 149.54 | 0.9346 | 1.0415 |  |
| 7 | 2026-11-02 22:33 | stage | `s2_receipt_roles` | 395.91 | 2.4744 | 3.5159 |  |
| 8 | 2026-11-02 22:34 | stage | `s3_intents_token_flows` | 168.52 | 1.0533 | 4.5692 |  |
| 9 | 2026-11-02 22:34 | stage | `s4_nep245_sample` | 88.46 | 0.5528 | 5.1221 |  |
| 10 | 2026-11-02 22:36 | run | `q1_weekly_usage` | 65.20 | 0.4075 | 5.5295 |  |
| 11 | 2026-11-02 22:36 | run | `q2_intents_flows` | 0.01 | 0.0001 | 5.5296 |  |
| 12 | 2026-11-02 22:36 | run | `q3_nep245_sample` | 0.08 | 0.0005 | 5.5301 |  |
| 13 | 2026-11-02 22:36 | probe | `p6_relayed_families` | 0.46 | 0.0029 | 5.5330 | 1% TABLESAMPLE of stage s2: which account suffixes are the relayed users |
| 14 | 2026-11-02 22:39 | probe | `p7_delegate_coverage` | 1.14 | 0.0071 | 5.5401 | 2 days receipt_actions: is is_delegate_action populated before 2025-02-24 (no) |
| 15 | 2026-11-02 22:41 | stage | `s5_relayed_gapfill` | 163.83 | 1.0239 | 6.5640 |  |
| 16 | 2026-11-02 22:42 | run | `q1_weekly_usage` | 76.90 | 0.4806 | 7.0446 |  |
| 17 | 2026-11-02 22:42 | run | `q2_intents_flows` | 0.01 | 0.0001 | 7.0447 |  |
| 18 | 2026-11-02 22:43 | run | `q3_nep245_sample` | 0.08 | 0.0005 | 7.0452 |  |
| 19 | 2026-11-02 22:48 | verify | `q1_weekly_usage` | 76.90 | 0.4806 | 7.5258 |  |
| 20 | 2026-11-02 22:48 | verify | `q2_intents_flows` | 0.01 | 0.0001 | 7.5259 |  |
| 21 | 2026-11-02 22:48 | verify | `q3_nep245_sample` | 0.08 | 0.0005 | 7.5264 |  |

**Total: 1,204.2 GB billed = $7.53 of $8 (94% of budget).**

| step | USD |
|---|---:|
| probe | 0.1169 |
| stage | 6.0391 |
| run | 0.8892 |
| verify | 0.4812 |

Steps: `probe` = one-off exploratory queries (SQL in `probes/`), `stage` = heavy raw scans run once into small tables, `run` = weekly aggregates read from the stage tables, `verify` = live re-run of the aggregates.
Not billed: dry runs, table metadata reads, the Binance price fetch, analysis and charts.

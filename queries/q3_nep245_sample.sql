-- name: q3_nep245_sample
-- question: On the 26 sampled days, how many distinct accounts appear in NEAR Intents'
--           internal NEP-245 ledger (mt_mint / mt_transfer / mt_burn), and how many events?
-- reads: {stage}.s4_nep245_sample (tiny; one day every 4 weeks, see stage/s4)
-- window: 2024-10-28 .. 2026-10-25 (sampled days only)
SELECT
  block_date,
  COUNT(DISTINCT account_id)                                       AS ledger_accounts,
  COUNT(DISTINCT IF(event = 'mt_transfer', account_id, NULL))      AS transfer_accounts,
  COUNT(DISTINCT IF(event = 'mt_mint', account_id, NULL))          AS mint_accounts,
  COUNT(DISTINCT IF(event = 'mt_burn', account_id, NULL))          AS burn_accounts,
  SUM(IF(event = 'mt_transfer', n_items, 0))                       AS transfer_items,
  SUM(IF(event = 'mt_mint', n_items, 0))                           AS mint_items,
  SUM(IF(event = 'mt_burn', n_items, 0))                           AS burn_items,
  BIT_XOR(FARM_FINGERPRINT(FORMAT('%t|%s|%s|%d', block_date, event, account_id, n_items))) AS fp
FROM `{stage}.s4_nep245_sample`
WHERE block_date BETWEEN '2024-10-28' AND '2026-10-25'
GROUP BY block_date

-- name: s1_tx_accounts  (HEAVY, run once)
-- One row per (ISO week, signing account): how many transactions it signed that
-- week, how many of them went straight to intents.near, and on how many days it was active.
-- Columns read: block_date, signer_account_id, receiver_account_id (no args/payloads).
-- window: 2024-10-28 .. 2026-10-25 = 104 full ISO weeks (Monday .. Sunday)
CREATE OR REPLACE TABLE `{stage}.s1_tx_accounts` AS
SELECT
  DATE_TRUNC(block_date, ISOWEEK)            AS week,
  signer_account_id                          AS account_id,
  COUNT(*)                                   AS n_tx,
  COUNTIF(receiver_account_id = 'intents.near') AS n_tx_to_intents,
  COUNT(DISTINCT block_date)                 AS active_days
FROM `bigquery-public-data.crypto_near_mainnet_us.transactions`
WHERE block_date BETWEEN '2024-10-28' AND '2026-10-25'
GROUP BY week, account_id

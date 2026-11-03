-- name: q1_daily_activity
-- question: Daily transactions, distinct signers and transactions per signer.
-- window: 2026-09-08 .. 2026-10-07 (30 days, fixed)
SELECT
  block_date,
  COUNT(*)                                                  AS tx_count,
  COUNT(DISTINCT signer_account_id)                         AS distinct_signers,
  ROUND(COUNT(*) / COUNT(DISTINCT signer_account_id), 1)    AS tx_per_signer
FROM `bigquery-public-data.crypto_near_mainnet_us.transactions`
WHERE block_date BETWEEN '2026-09-08' AND '2026-10-07'
GROUP BY block_date

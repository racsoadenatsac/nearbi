-- name: daily_activity
-- question: How many transactions and distinct signers did NEAR mainnet have per day?
-- window: 2026-10-01 .. 2026-10-07 (fixed, so results are deterministic)
SELECT
  block_date,
  COUNT(*)                          AS tx_count,
  COUNT(DISTINCT signer_account_id) AS distinct_signers
FROM `bigquery-public-data.crypto_near_mainnet_us.transactions`
WHERE block_date BETWEEN '2026-10-01' AND '2026-10-07'
GROUP BY block_date
ORDER BY block_date

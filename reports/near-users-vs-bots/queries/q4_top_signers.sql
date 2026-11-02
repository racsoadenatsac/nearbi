-- name: q4_top_signers
-- question: Who are the 15 busiest signers over the window, and how many days were they active?
-- window: 2026-09-08 .. 2026-10-07 (30 days, fixed)
SELECT
  signer_account_id,
  COUNT(*)                                       AS tx,
  COUNT(DISTINCT block_date)                     AS active_days,
  ROUND(COUNT(*) / COUNT(DISTINCT block_date))   AS tx_per_active_day
FROM `bigquery-public-data.crypto_near_mainnet_us.transactions`
WHERE block_date BETWEEN '2026-09-08' AND '2026-10-07'
GROUP BY signer_account_id
ORDER BY tx DESC, signer_account_id
LIMIT 15

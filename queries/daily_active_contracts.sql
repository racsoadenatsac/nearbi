-- name: daily_active_contracts
-- question: How many distinct contracts received function calls per day?
-- window: 2026-10-01 .. 2026-10-07 (fixed, so results are deterministic)
SELECT
  block_date,
  COUNT(DISTINCT receipt_receiver_account_id) AS active_contracts,
  COUNT(*)                                    AS function_calls
FROM `bigquery-public-data.crypto_near_mainnet_us.receipt_actions`
WHERE block_date BETWEEN '2026-10-01' AND '2026-10-07'
  AND action_kind = 'FUNCTION_CALL'
GROUP BY block_date
ORDER BY block_date

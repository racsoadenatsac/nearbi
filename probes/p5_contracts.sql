SELECT contract_account_id, cause, affected_account_id='intents.near' AS aff_int, COUNT(*) n, COUNT(DISTINCT block_date) days, COUNTIF(involved_account_id IS NULL) inv_null
FROM `bigquery-public-data.crypto_near_mainnet_us.ft_events`
WHERE block_date IN ('2024-11-15','2024-12-15','2025-01-15','2025-02-15','2025-03-15','2025-04-15','2025-05-15','2025-06-15','2025-07-15','2025-08-15','2025-09-15','2025-10-15','2025-11-15','2025-12-15','2026-01-15','2026-02-15','2026-03-15','2026-04-15','2026-05-15','2026-06-15','2026-07-15','2026-08-15','2026-09-15','2026-10-15')
  AND (affected_account_id = 'intents.near' OR involved_account_id = 'intents.near')
GROUP BY 1,2,3 ORDER BY n DESC

-- name: q3_signer_buckets
-- question: Over the whole window, how are signers and transactions split by how active a signer is?
-- A signer's bucket is its average transactions per active day.
-- window: 2026-09-08 .. 2026-10-07 (30 days, fixed)
WITH per_signer AS (
  SELECT signer_account_id,
         COUNT(*) AS n,
         COUNT(DISTINCT block_date) AS active_days
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions`
  WHERE block_date BETWEEN '2026-09-08' AND '2026-10-07'
  GROUP BY 1
), bucketed AS (
  SELECT *,
    CASE
      WHEN n / active_days < 2     THEN '1_light (<2/day)'
      WHEN n / active_days < 10    THEN '2_regular (2-10/day)'
      WHEN n / active_days < 100   THEN '3_heavy (10-100/day)'
      WHEN n / active_days < 1000  THEN '4_automated (100-1000/day)'
      ELSE                              '5_industrial (1000+/day)'
    END AS bucket
  FROM per_signer
)
SELECT
  bucket,
  COUNT(*)                                                    AS signers,
  SUM(n)                                                      AS tx,
  ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 2)            AS pct_signers,
  ROUND(100 * SUM(n) / SUM(SUM(n)) OVER (), 1)                AS pct_tx
FROM bucketed
GROUP BY bucket

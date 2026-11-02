-- name: q2_concentration
-- question: What share of each day's transactions comes from the 10 / 100 busiest signers?
-- window: 2026-09-08 .. 2026-10-07 (30 days, fixed)
WITH per_signer AS (
  SELECT block_date, signer_account_id, COUNT(*) AS n
  FROM `bigquery-public-data.crypto_near_mainnet_us.transactions`
  WHERE block_date BETWEEN '2026-09-08' AND '2026-10-07'
  GROUP BY 1, 2
), ranked AS (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY block_date ORDER BY n DESC, signer_account_id) AS rk
  FROM per_signer
)
SELECT
  block_date,
  SUM(n)                                                         AS tx_count,
  SUM(IF(rk <= 10, n, 0))                                        AS tx_top10,
  SUM(IF(rk <= 100, n, 0))                                       AS tx_top100,
  ROUND(100 * SUM(IF(rk <= 10, n, 0)) / SUM(n), 1)               AS pct_top10,
  ROUND(100 * SUM(IF(rk <= 100, n, 0)) / SUM(n), 1)              AS pct_top100
FROM ranked
GROUP BY block_date

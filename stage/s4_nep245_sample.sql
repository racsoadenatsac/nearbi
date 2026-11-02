-- name: s4_nep245_sample  (HEAVY, run once; SAMPLED)
-- NEAR Intents keeps user balances inside intents.near as NEP-245 multi-tokens. Those
-- events are NOT in ft_events (which only carries nep141); they exist only as
-- EVENT_JSON log lines in execution_outcomes. A full-window log scan dry-runs at about
-- 2.4 TB (over budget), so we sample one day every 4 weeks: the Wednesday of every
-- 4th ISO week, 26 days. One row per (day, event, account) with the number of
-- event entries naming that account (owner_id, old_owner_id or new_owner_id).
-- window: 2024-10-28 .. 2026-10-25, sampled days listed below
CREATE OR REPLACE TABLE `{stage}.s4_nep245_sample` AS
WITH ev AS (
  SELECT block_date, SAFE.PARSE_JSON(SUBSTR(l.element, 12)) AS j
  FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes`, UNNEST(logs.list) AS l
  WHERE block_date BETWEEN '2024-10-28' AND '2026-10-25'
    AND block_date IN ('2024-10-30','2024-11-27','2024-12-25','2025-01-22','2025-02-19','2025-03-19','2025-04-16','2025-05-14','2025-06-11','2025-07-09','2025-08-06','2025-09-03','2025-10-01','2025-10-29','2025-11-26','2025-12-24','2026-01-21','2026-02-18','2026-03-18','2026-04-15','2026-05-13','2026-06-10','2026-07-08','2026-08-05','2026-09-02','2026-09-30')
    AND executor_account_id = 'intents.near'
    AND STARTS_WITH(l.element, 'EVENT_JSON:')
    AND l.element LIKE '%"nep245"%'
), items AS (
  SELECT block_date, LAX_STRING(j.event) AS event, d
  FROM ev, UNNEST(JSON_QUERY_ARRAY(j, '$.data')) AS d
)
SELECT block_date, event, account_id, COUNT(*) AS n_items
FROM items,
  UNNEST(ARRAY_CONCAT(
    IF(LAX_STRING(d.owner_id)     IS NULL, [], [LAX_STRING(d.owner_id)]),
    IF(LAX_STRING(d.old_owner_id) IS NULL, [], [LAX_STRING(d.old_owner_id)]),
    IF(LAX_STRING(d.new_owner_id) IS NULL, [], [LAX_STRING(d.new_owner_id)]))) AS account_id
GROUP BY block_date, event, account_id

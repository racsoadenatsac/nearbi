-- name: s5_relayed_gapfill  (HEAVY, run once)
-- Data-quality fix found by probe p7: before late February 2025 the public dataset has
-- DELEGATE_ACTION rows whose is_delegate_action flag is FALSE (on 2025-01-15 every one of
-- them; on 2025-03-15 flag and action_kind agree exactly). s2 keys on the flag, so it
-- misses relayed users in the early weeks. This table re-derives relayed end users from
-- action_kind = 'DELEGATE_ACTION' for the first 18 ISO weeks (through the week in which the
-- flag starts). q1 takes relayed users from s5 for weeks <= 2025-02-24 and from s2 after,
-- so no week is counted from both tables.
-- Columns read: block_date, action_kind, receipt_receiver_account_id.
-- window: 2024-10-28 .. 2025-03-02 (18 ISO weeks)
CREATE OR REPLACE TABLE `{stage}.s5_relayed_gapfill` AS
SELECT
  DATE_TRUNC(block_date, ISOWEEK) AS week,
  receipt_receiver_account_id     AS account_id,
  COUNT(*)                        AS n_actions,
  COUNT(DISTINCT block_date)      AS active_days
FROM `bigquery-public-data.crypto_near_mainnet_us.receipt_actions`
WHERE block_date BETWEEN '2024-10-28' AND '2025-03-02'
  AND action_kind = 'DELEGATE_ACTION'
GROUP BY week, account_id

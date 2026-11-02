-- name: s2_receipt_roles  (HEAVY, run once)
-- From receipt-level actions, two things in a single scan:
--   role 'relayed_user'   : DELEGATE_ACTION rows (is_delegate_action = TRUE). On NEAR a
--                           meta-transaction's delegate receipt is addressed to the end
--                           user (receiver); signer/predecessor are the relayer. So the
--                           relayed end user is receipt_receiver_account_id.
--   role 'intents_action' : every action executed on intents.near (all callers: solvers,
--                           relayers, users, token contracts forwarding deposits).
-- Columns read: block_date, is_delegate_action, receipt_receiver_account_id.
-- window: 2024-10-28 .. 2026-10-25 = 104 full ISO weeks
CREATE OR REPLACE TABLE `{stage}.s2_receipt_roles` AS
SELECT
  DATE_TRUNC(block_date, ISOWEEK) AS week,
  IF(is_delegate_action, 'relayed_user', 'intents_action') AS role,
  receipt_receiver_account_id     AS account_id,
  COUNT(*)                        AS n_actions,
  COUNT(DISTINCT block_date)      AS active_days
FROM `bigquery-public-data.crypto_near_mainnet_us.receipt_actions`
WHERE block_date BETWEEN '2024-10-28' AND '2026-10-25'
  AND (is_delegate_action OR receipt_receiver_account_id = 'intents.near')
GROUP BY week, role, account_id

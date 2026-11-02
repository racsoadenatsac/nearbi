-- probe: is the delegate-action flag populated before 2025-02-24? (two single days)
SELECT block_date, action_kind = 'DELEGATE_ACTION' AS is_delegate_kind, is_delegate_action, COUNT(*) AS n
FROM `bigquery-public-data.crypto_near_mainnet_us.receipt_actions`
WHERE block_date BETWEEN '2025-01-15' AND '2025-03-15' AND block_date IN ('2025-01-15', '2025-03-15')
GROUP BY 1, 2, 3 ORDER BY 1, 2, 3

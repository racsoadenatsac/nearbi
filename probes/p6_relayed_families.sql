-- probe: which account suffixes make up relayed users (1% block sample of the stage table)
SELECT FORMAT_DATE('%Y-%m', week) AS month,
  IF(REGEXP_CONTAINS(account_id, r'^[0-9a-f]{64}$'), '<implicit>', REGEXP_EXTRACT(account_id, r'([^.]+\.[^.]+)$')) AS suffix,
  COUNT(*) AS n, ANY_VALUE(account_id) AS example
FROM `triple-router-448011-f7.rs_thesis_stage.s2_receipt_roles` TABLESAMPLE SYSTEM (1 PERCENT)
WHERE week BETWEEN '2024-10-28' AND '2026-10-25' AND role = 'relayed_user'
GROUP BY month, suffix
QUALIFY ROW_NUMBER() OVER (PARTITION BY month ORDER BY n DESC) <= 4
ORDER BY month, n DESC

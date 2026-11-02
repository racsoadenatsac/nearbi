-- probe: how delegate actions look on one day
SELECT action_kind, is_delegate_action,
  signer_account_id = receipt_predecessor_account_id AS signer_is_pred,
  COUNT(*) n, COUNT(DISTINCT signer_account_id) signers, COUNT(DISTINCT receipt_predecessor_account_id) preds,
  ANY_VALUE(signer_account_id) ex_signer, ANY_VALUE(receipt_predecessor_account_id) ex_pred, ANY_VALUE(receipt_receiver_account_id) ex_recv
FROM `bigquery-public-data.crypto_near_mainnet_us.receipt_actions`
WHERE block_date BETWEEN '2026-10-15' AND '2026-10-15'
  AND (is_delegate_action OR action_kind = 'DELEGATE_ACTION')
GROUP BY 1,2,3 ORDER BY n DESC

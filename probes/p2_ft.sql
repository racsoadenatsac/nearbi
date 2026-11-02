SELECT standard, cause, contract_account_id = 'intents.near' AS c_int, affected_account_id='intents.near' a_int, involved_account_id='intents.near' i_int,
  COUNT(*) n, ANY_VALUE(contract_account_id) ex_c, ANY_VALUE(token_id) ex_tok, ANY_VALUE(affected_account_id) ex_aff
FROM `bigquery-public-data.crypto_near_mainnet_us.ft_events`
WHERE block_date BETWEEN '2026-10-15' AND '2026-10-15'
  AND (contract_account_id = 'intents.near' OR affected_account_id = 'intents.near' OR involved_account_id = 'intents.near')
GROUP BY 1,2,3,4,5 ORDER BY n DESC

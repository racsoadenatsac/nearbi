SELECT standard, COUNT(*) n, COUNT(DISTINCT contract_account_id) contracts
FROM `bigquery-public-data.crypto_near_mainnet_us.ft_events`
WHERE block_date BETWEEN '2026-10-15' AND '2026-10-15' GROUP BY 1

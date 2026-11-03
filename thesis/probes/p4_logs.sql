SELECT COUNTIF(l.element LIKE 'EVENT_JSON%nep245%') nep245, COUNTIF(l.element LIKE 'EVENT_JSON%') ev, COUNT(*) logs,
  ANY_VALUE(IF(l.element LIKE 'EVENT_JSON%nep245%', SUBSTR(l.element,1,300), NULL)) ex
FROM `bigquery-public-data.crypto_near_mainnet_us.execution_outcomes`, UNNEST(logs.list) l
WHERE block_date BETWEEN '2026-10-15' AND '2026-10-15' AND executor_account_id = 'intents.near'

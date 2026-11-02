-- name: s3_intents_token_flows  (HEAVY, run once)
-- Fungible-token (NEP-141) balance changes of the intents.near account, per week.
-- Cross-chain assets on NEAR Intents are the PoA-bridge tokens *.omft.near (one per
-- source-chain asset). ft_events is clustered on contract_account_id, so the scan is
-- pruned with STARTS_WITH on the chain prefixes seen in a 24-day sample, then filtered
-- exactly with ENDS_WITH('.omft.near'). Prefixes not in the list are missed (see THESIS.md).
-- direction: 'in' = intents.near balance increased, 'out' = decreased (burn = bridge-out).
-- Amounts are raw integer token units (no decimals, no prices).
-- window: 2024-10-28 .. 2026-10-25 = 104 full ISO weeks
CREATE OR REPLACE TABLE `{stage}.s3_intents_token_flows` AS
SELECT
  DATE_TRUNC(block_date, ISOWEEK)                          AS week,
  contract_account_id                                      AS token,
  cause,
  IF(STARTS_WITH(delta_amount, '-'), 'out', 'in')          AS direction,
  involved_account_id                                      AS counterparty,
  COUNT(*)                                                 AS n_events,
  SUM(ABS(CAST(delta_amount AS BIGNUMERIC)))               AS raw_amount
FROM `bigquery-public-data.crypto_near_mainnet_us.ft_events`
WHERE block_date BETWEEN '2024-10-28' AND '2026-10-25'
  AND affected_account_id = 'intents.near'
  AND ENDS_WITH(contract_account_id, '.omft.near')
  AND (   STARTS_WITH(contract_account_id, 'eth')   OR STARTS_WITH(contract_account_id, 'base')
       OR STARTS_WITH(contract_account_id, 'sol')   OR STARTS_WITH(contract_account_id, 'gnosis')
       OR STARTS_WITH(contract_account_id, 'arb')   OR STARTS_WITH(contract_account_id, 'hood')
       OR STARTS_WITH(contract_account_id, 'sui')   OR STARTS_WITH(contract_account_id, 'aptos')
       OR STARTS_WITH(contract_account_id, 'aleo')  OR STARTS_WITH(contract_account_id, 'tron')
       OR STARTS_WITH(contract_account_id, 'bera')  OR STARTS_WITH(contract_account_id, 'plasma')
       OR STARTS_WITH(contract_account_id, 'zec')   OR STARTS_WITH(contract_account_id, 'btc')
       OR STARTS_WITH(contract_account_id, 'xrp')   OR STARTS_WITH(contract_account_id, 'ltc')
       OR STARTS_WITH(contract_account_id, 'qtc')   OR STARTS_WITH(contract_account_id, 'doge')
       OR STARTS_WITH(contract_account_id, 'bch')   OR STARTS_WITH(contract_account_id, 'cardano')
       OR STARTS_WITH(contract_account_id, 'starknet') OR STARTS_WITH(contract_account_id, 'dash')
       OR STARTS_WITH(contract_account_id, 'bsc')   OR STARTS_WITH(contract_account_id, 'avax')
       OR STARTS_WITH(contract_account_id, 'pol')   OR STARTS_WITH(contract_account_id, 'op')
       OR STARTS_WITH(contract_account_id, 'ton')   OR STARTS_WITH(contract_account_id, 'stellar'))
GROUP BY week, token, cause, direction, counterparty

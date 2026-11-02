-- name: q2_intents_flows
-- question: Per ISO week, how many cross-chain (PoA-bridge *.omft.near) token movements
--           touched intents.near, in which direction, and from how many counterparties?
-- reads: {stage}.s3_intents_token_flows (tiny). chain = asset prefix before '-' or '.'
--        (eth, sol, btc, tron, ...). Burns (cause ft_burn) are withdrawals back to the
--        source chain. Amounts stay in raw token units (no decimals, no prices).
-- window: 2024-10-28 .. 2026-10-25
SELECT
  week,
  REGEXP_EXTRACT(token, r'^([a-z0-9]+)')                  AS chain,
  COUNT(DISTINCT token)                                   AS tokens,
  SUM(IF(direction = 'in', n_events, 0))                  AS events_in,
  SUM(IF(direction = 'out', n_events, 0))                 AS events_out,
  SUM(IF(cause = 'ft_burn', n_events, 0))                 AS events_burn,
  COUNT(DISTINCT IF(direction = 'in', counterparty, NULL)) AS counterparties_in,
  BIT_XOR(FARM_FINGERPRINT(FORMAT('%t|%s|%s|%s|%s|%d|%t', week, token, cause, direction,
          IFNULL(counterparty, ''), n_events, raw_amount)))  AS fp
FROM `{stage}.s3_intents_token_flows`
WHERE week BETWEEN '2024-10-28' AND '2026-10-25'
GROUP BY week, chain

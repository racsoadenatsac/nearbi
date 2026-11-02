-- name: q1_weekly_usage
-- question: Per ISO week, how many accounts used NEAR, split by account family, and how
--           many of them look like real users rather than automation?
-- reads: {stage}.s1_tx_accounts (tx signers), {stage}.s2_receipt_roles (relayed end users
--        + actions on intents.near) and {stage}.s5_relayed_gapfill (relayed end users for
--        the weeks before the dataset's is_delegate_action flag is populated). s2 is ~60 GB,
--        so it is read ONCE, here.
-- relayed source: s5 (action_kind = DELEGATE_ACTION) for weeks <= 2025-02-24, s2 (flag)
--        from 2025-03-03; flagged_relayed_week shows what the flag alone would give.
-- definitions (per week, per account):
--   signer        signed >= 1 transaction
--   relayed       was the end user of >= 1 meta-transaction (DELEGATE_ACTION receiver)
--   users_any     signer OR relayed (distinct accounts; an account counted once)
--   heavy         >= 1000 signed tx + relayed actions in the week (relayers, solvers, bots)
--   users_real    users_any minus heavy
--   users_engaged users_real active on >= 2 distinct days of the week
--   new_users     users_real whose first appearance in the 104-week window is this week
--   retained      users_real that were also active (signer or relayed) the previous week
-- family: account-name pattern (implicit 64-hex, EVM-style 0x, *.tg = HOT, *.sweat = Sweat,
--         *.users.kaiching = KaiChing app sub-accounts (largest relayed suffix, probe p6),
--         other *.near, other). Families partition accounts, so totals = sum over families.
-- fp_*: order-independent content fingerprints of the stage rows read (detects drift).
-- window: 2024-10-28 .. 2026-10-25 (104 ISO weeks)
WITH tx AS (
  SELECT week, account_id, n_tx, n_tx_to_intents, active_days,
         FARM_FINGERPRINT(FORMAT('%t|%s|%d|%d|%d', week, account_id, n_tx, n_tx_to_intents, active_days)) AS fp
  FROM `{stage}.s1_tx_accounts`
  WHERE week BETWEEN '2024-10-28' AND '2026-10-25'
), s2 AS (
  SELECT week, role, account_id, n_actions, active_days,
         FARM_FINGERPRINT(FORMAT('%t|%s|%s|%d|%d', week, role, account_id, n_actions, active_days)) AS fp
  FROM `{stage}.s2_receipt_roles`
  WHERE week BETWEEN '2024-10-28' AND '2026-10-25'
), s5 AS (
  SELECT week, account_id, n_actions, active_days,
         FARM_FINGERPRINT(FORMAT('%t|%s|%d|%d', week, account_id, n_actions, active_days)) AS fp
  FROM `{stage}.s5_relayed_gapfill`
  WHERE week BETWEEN '2024-10-28' AND '2025-02-24'
), intents AS (
  SELECT week,
         SUM(IF(role = 'intents_action', n_actions, 0)) AS intents_actions,
         COUNTIF(role = 'relayed_user')                 AS flagged_relayed,
         BIT_XOR(fp)                                    AS fp_s2
  FROM s2 GROUP BY week
), rel AS (
  SELECT week, account_id, n_actions, active_days, fp FROM s2
  WHERE role = 'relayed_user' AND week >= '2025-03-03'
  UNION ALL
  SELECT week, account_id, n_actions, active_days, fp FROM s5
), acct AS (
  SELECT
    week,
    COALESCE(tx.account_id, rel.account_id)               AS account_id,
    tx.account_id IS NOT NULL                             AS is_signer,
    rel.account_id IS NOT NULL                            AS is_relayed,
    IFNULL(tx.n_tx, 0)                                    AS n_tx,
    IFNULL(tx.n_tx_to_intents, 0)                         AS n_tx_to_intents,
    IFNULL(rel.n_actions, 0)                              AS n_relayed,
    GREATEST(IFNULL(tx.active_days, 0), IFNULL(rel.active_days, 0)) AS days,
    tx.fp AS fp_tx, rel.fp AS fp_rel
  FROM tx FULL OUTER JOIN rel USING (week, account_id)
), first_seen AS (
  SELECT account_id, MIN(week) AS first_week FROM acct
  WHERE n_tx + n_relayed < 1000 GROUP BY account_id
), labeled AS (
  SELECT a.*, f.first_week,
    LAG(a.week) OVER (PARTITION BY a.account_id ORDER BY a.week) = DATE_SUB(a.week, INTERVAL 7 DAY) AS was_active_prev,
    a.n_tx + a.n_relayed >= 1000 AS heavy,
    CASE
      WHEN REGEXP_CONTAINS(a.account_id, r'^[0-9a-f]{64}$') THEN 'implicit'
      WHEN STARTS_WITH(a.account_id, '0x')                 THEN 'evm_0x'
      WHEN ENDS_WITH(a.account_id, '.tg')                  THEN 'hot_tg'
      WHEN ENDS_WITH(a.account_id, '.sweat')               THEN 'sweat'
      WHEN REGEXP_CONTAINS(a.account_id, r'\.users\.(preprod-)?kaiching(\.near)?$') THEN 'kaiching'
      WHEN ENDS_WITH(a.account_id, '.near')                THEN 'named_near'
      ELSE 'other'
    END AS family
  FROM acct a LEFT JOIN first_seen f USING (account_id)
)
SELECT
  l.week,
  l.family,
  COUNT(*)                                                    AS users_any,
  COUNTIF(is_signer)                                          AS signers,
  COUNTIF(is_relayed)                                         AS relayed_users,
  COUNTIF(is_signer AND is_relayed)                           AS signer_and_relayed,
  COUNTIF(heavy)                                              AS heavy_accounts,
  COUNTIF(NOT heavy)                                          AS users_real,
  COUNTIF(NOT heavy AND days >= 2)                            AS users_engaged,
  COUNTIF(NOT heavy AND first_week = l.week)                  AS new_users,
  COUNTIF(NOT heavy AND IFNULL(was_active_prev, FALSE))       AS retained,
  SUM(n_tx)                                                   AS tx_signed,
  SUM(n_relayed)                                              AS relayed_actions,
  COUNTIF(n_tx_to_intents > 0)                                AS intents_tx_signers,
  COUNTIF(n_tx_to_intents > 0 AND NOT heavy)                  AS intents_tx_signers_real,
  SUM(n_tx_to_intents)                                        AS intents_tx,
  ANY_VALUE(i.intents_actions)                                AS intents_actions_week,
  ANY_VALUE(i.flagged_relayed)                                AS flagged_relayed_week,
  BIT_XOR(fp_tx)                                              AS fp_tx,
  BIT_XOR(fp_rel)                                             AS fp_rel,
  ANY_VALUE(i.fp_s2)                                          AS fp_s2_week
FROM labeled l LEFT JOIN intents i USING (week)
GROUP BY l.week, l.family

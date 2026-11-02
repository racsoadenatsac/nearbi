-- Accounts, subscriptions, payments and container-registry tokens.
-- All timestamps are unix seconds (UTC).

CREATE TABLE IF NOT EXISTS accounts (
  account_id     TEXT PRIMARY KEY,            -- NEAR account id, e.g. alice.near
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);

CREATE TABLE IF NOT EXISTS subscriptions (
  account_id          TEXT PRIMARY KEY REFERENCES accounts(account_id),
  status              TEXT NOT NULL DEFAULT 'none' CHECK (status IN ('none', 'active', 'canceled')),
  current_period_end  INTEGER,                -- access is granted while now < current_period_end
  last_payment_tx     TEXT,
  updated_at          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id                       TEXT PRIMARY KEY,  -- uuid
  account_id               TEXT NOT NULL REFERENCES accounts(account_id),
  amount_usd               REAL NOT NULL,
  token                    TEXT NOT NULL,     -- asset the user pays with / settles in (1Click asset id)
  intents_deposit_address  TEXT,             -- from the 1Click quote
  tx_hash                  TEXT,
  status                   TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
  created_at               INTEGER NOT NULL,
  paid_at                  INTEGER,
  quote_json               TEXT              -- raw quote response, for audit
);
CREATE INDEX IF NOT EXISTS idx_payments_account ON payments(account_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_tx ON payments(tx_hash) WHERE tx_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS registry_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id  TEXT NOT NULL REFERENCES accounts(account_id),
  token_hash  TEXT NOT NULL UNIQUE,           -- hex sha256 of the token; the token itself is never stored
  expires_at  INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_registry_tokens_account ON registry_tokens(account_id);

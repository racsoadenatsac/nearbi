-- One-time sign-in challenges for NEP-413. A nonce is deleted the moment it is presented.
CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce       TEXT PRIMARY KEY,          -- base64 of 32 random bytes
  message     TEXT NOT NULL,             -- exact message the wallet must sign
  expires_at  INTEGER NOT NULL           -- unix seconds
);
CREATE INDEX IF NOT EXISTS idx_auth_nonces_expires ON auth_nonces(expires_at);

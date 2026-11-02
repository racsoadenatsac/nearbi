-- Catalog of published reports (what the members page lists). Content itself lives in R2 under
-- reports/<slug>/index.html, reports/<slug>/charts/*, reports/<slug>/<pdf_file>.
-- The free sample is served from public/ (static assets), not from R2.
CREATE TABLE IF NOT EXISTS reports (
  slug          TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  summary       TEXT NOT NULL DEFAULT '',
  published_at  TEXT NOT NULL,              -- YYYY-MM-DD
  is_free       INTEGER NOT NULL DEFAULT 0,
  pdf_file      TEXT                        -- file name inside reports/<slug>/
);

INSERT OR IGNORE INTO reports (slug, title, summary, published_at, is_free, pdf_file) VALUES
  ('near-users-vs-bots', 'NEAR activity: real users or bots?',
   '90 signers (0.01%) produced 80.7% of NEAR transactions over 30 days. Evidence for, against, and how to check it yourself.',
   '2026-11-02', 1, 'NEAR-real-users-or-bots.pdf');

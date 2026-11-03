# Paid reports are not in this repository

Only free material ships in the submission monorepo: the sample report `reports/near-users-vs-bots`
(report-001), the report tooling (`tools/`) and the NEAR investment thesis (`../thesis/`).

Reports produced for paying customers (one-off Quick Answer / Deep Dive orders) are delivered gated
through nearbi.ai and kept out of this repository and its history. `tooling/bin/sync-monorepo.sh`
pulls `reports/` through a filter that drops every report pack not on its free allowlist.

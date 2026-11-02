# rs-repro

The reproducibility container for research-shop reports. Each report ships its SQL, its results and a `manifest.json` of SHA-256 hashes. Anyone can rebuild the numbers and check that they match.

## Quick start

```bash
make check          # the safeguards check every query (no GCP needed)
make verify-cached  # re-hash the shipped results against the manifest (no GCP needed)

# Live reproduction with your own Google credentials (you pay BigQuery costs):
gcloud auth application-default login
make verify PROJECT=<your-gcp-project>
make notebook       # JupyterLab on http://localhost:8888
```

## Safeguards
- Every query must bound `block_date` with a fixed `BETWEEN '<date>' AND '<date>'`, once per dataset table. Relative dates (`CURRENT_DATE`, ...) are blocked.
- A dry run happens before each execution. The runner prints the GB scanned and the cost, and aborts above `MAX_GB_PER_QUERY` (default 25 GB).
- Credentials are mounted read-only at runtime and never copied into the image.

## Pipeline steps (v0.3)
A report pack (mounted at `REPRO_ROOT`) can use any of these folders; all are optional except `queries/`:

| Step | Input | Output | Notes |
|---|---|---|---|
| `stage` | `stage/*.sql` | tables in `$BQ_PROJECT.$BQ_STAGE_DATASET` | heavy raw scans run **once**; each file must be exactly `CREATE OR REPLACE TABLE \`{stage}.<file name>\` AS SELECT …` with fixed `block_date` bounds; cap `MAX_GB_PER_STAGE` (default 500) |
| `run` | `queries/*.sql` | `results/*.csv` | read-only (no DDL/DML); may read `{stage}` tables, so a live verify is cheap |
| `fetch` | `fetch/*.json` | `raw/*.json` | public HTTPS data (e.g. prices): allow-listed hosts, fixed numeric time bounds, no keys; sources tried in order and the one used is recorded |
| `analyze` | `analysis.py` | derived `results/*.csv` | runs with `ROOT` and `OUT`; must be deterministic |
| `verify-cached` | everything shipped | — | offline: re-hashes results and raw files **and re-runs `analysis.py`** |
| `verify` | — | — | live: re-runs `queries/` and re-fetches; `VERIFY_STAGE=1` also re-runs the stage scans |

**Budget.** Every executed job is appended to a cost ledger (`costs.jsonl`). Set `MAX_USD_TOTAL` and a step whose dry-run total would push the ledger past it is aborted before anything executes.

## Demo use case
NEAR mainnet daily activity for 1–7 Oct 2026: transactions, distinct signers, active contracts and function calls.

Part of the NEAR Hackathon one-agent research shop. See `rs-docs/ARCHITECTURE.md`.

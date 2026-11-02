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

## Demo use case
NEAR mainnet daily activity for 1–7 Oct 2026: transactions, distinct signers, active contracts and function calls.

Part of the NEAR Hackathon one-agent research shop. See `rs-docs/ARCHITECTURE.md`.

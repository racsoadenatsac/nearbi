# rs-thesis

NEAR investment thesis (NEAR Hackathon, Track 02): **is cross-chain volume through NEAR Intents a better leading indicator of real network usage than the NEAR token price?** Evidence-first and reproducible.

**Answer from the data: no.** Neither Intents activity nor the price leads weekly real-user growth. Intents grew while NEAR's own (non-KaiChing) user base shrank. Read [`THESIS.md`](THESIS.md) or open [`dashboard/index.html`](dashboard/index.html).

## Reproduce

Everything runs in the pinned `rs-repro:0.3.3` image (`make image` builds it from `../rs-repro` at tag `v0.3.3`). Python isn't needed on the host.

```bash
make verify-cached                  # offline: hashes of results/ + raw/, re-run analysis.py
make verify  BQ_PROJECT=<project>   # live: re-run the weekly aggregates (~77 GB) + re-fetch prices
make numbers                        # every number in THESIS.md traces to results/*.csv
make all     BQ_PROJECT=<project>   # from raw data: stage scans (~966 GB, run once) -> ... -> dashboard
```

`make all` creates the stage dataset `rs_thesis_stage` in your project, in the public dataset's location (`us-east1`). It is guarded by `BUDGET` (default 8 USD), checked against the cost ledger `costs.jsonl`. **That ledger holds this pack's own spend, so delete it before rebuilding in your own project.**

## Layout

| path | what |
|---|---|
| `stage/*.sql` | heavy raw scans, run once into small tables (fixed `block_date` windows, needed columns only) |
| `queries/*.sql` | weekly aggregates read from the stage tables -> `results/q*.csv` |
| `fetch/near_usdt_weekly.json` | public price source (Binance klines, CoinGecko fallback) -> `raw/` |
| `analysis.py` | growth rates, lead/lag cross-correlation, out-of-sample test -> `results/a_*.csv` |
| `charts.py`, `charts/` | house-style charts, titles computed from the data |
| `dashboard/` | static page: every chart, its queries, one plain sentence |
| `manifest.json` | SHA-256 of every query result, fetched file and derived file |
| `probes/` | exploratory SQL + outputs that shaped the design (billed, in COSTS.md) |
| `COSTS.md`, `costs.jsonl` | every billed BigQuery job and the running total |
| `runs/` | recorded verification outputs |

Part of the NEAR Hackathon one-agent research shop. See `rs-docs/ARCHITECTURE.md`.

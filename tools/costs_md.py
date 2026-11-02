"""Write COSTS.md from the append-only cost ledger costs.jsonl (one line per billed BigQuery job).

Probes were run by hand while designing the pack; every other line was appended by the
rs-repro runner itself after the job finished (bytes_billed from the BigQuery job).
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUDGET = 8.0
USD_PER_TB = 6.25
rows = [json.loads(l) for l in (ROOT / "costs.jsonl").read_text().splitlines() if l.strip()]
out = ["# COSTS", "",
       f"BigQuery on-demand, billed to the operator's project at ${USD_PER_TB}/TB. Budget: **${BUDGET:g}** "
       f"(≈{BUDGET / USD_PER_TB:.2f} TB). Dry runs are free and were run before every job; the runner refuses a step "
       "whose dry-run total would push this ledger over the budget (`MAX_USD_TOTAL`).", "",
       "| # | when (UTC) | step | job | GB billed | USD | running USD | note |", "|---|---|---|---|---:|---:|---:|---|"]
total = 0.0
by_step = {}
for i, r in enumerate(rows, 1):
    usd = r["bytes_billed"] / 1e12 * USD_PER_TB
    total += usd
    by_step[r["step"]] = by_step.get(r["step"], 0) + usd
    out.append(f"| {i} | {r['at'][:16].replace('T', ' ')} | {r['step']} | `{r['name']}` | {r['bytes_billed'] / 1e9:,.2f} | "
               f"{usd:.4f} | {total:.4f} | {r.get('note', '')} |")
gb = sum(r["bytes_billed"] for r in rows) / 1e9
out += ["", f"**Total: {gb:,.1f} GB billed = ${total:.2f} of ${BUDGET:g} ({100 * total / BUDGET:.0f}% of budget).**", "",
        "| step | USD |", "|---|---:|"] + [f"| {k} | {v:.4f} |" for k, v in by_step.items()] + ["",
        "Steps: `probe` = one-off exploratory queries (SQL in `probes/`), `stage` = heavy raw scans run once into "
        "small tables, `run` = weekly aggregates read from the stage tables, `verify` = live re-run of the aggregates.",
        "Not billed: dry runs, table metadata reads, the Binance price fetch, analysis and charts.", ""]
(ROOT / "COSTS.md").write_text("\n".join(out))
print(f"COSTS.md: {len(rows)} jobs, {gb:,.1f} GB, ${total:.2f}")

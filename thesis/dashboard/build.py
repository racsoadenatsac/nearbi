"""Build dashboard/index.html: each chart, its queries (collapsible) and one plain sentence.

Static page, same look as nearbi-site (site.css vendored next to this file). Sentences are
filled from results/a_facts.csv so the page never states a number the data doesn't hold.
Run inside the rs-repro image: `make dashboard`.
"""
import html
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
F = pd.read_csv(ROOT / "results" / "a_facts.csv").set_index("key").value
oos = pd.read_csv(ROOT / "results" / "a_oos.csv")
chains = pd.read_csv(ROOT / "results" / "a_chains.csv")
manifest = json.loads((ROOT / "manifest.json").read_text())


def f(k):
    v = F[k]
    try:
        x = float(v)
        return f"{int(x):,}" if x.is_integer() and abs(x) >= 1000 else (str(int(x)) if x.is_integer() else f"{x:g}")
    except ValueError:
        return v


def sql(path):
    return (ROOT / path).read_text()


CARDS = [
    ("c1_real_users_by_family.png",
     f"Real users (signers plus relayed end users, minus accounts with 1,000+ actions a week) were dominated by one app: "
     f"KaiChing sub-accounts were {f('kc_share_users_real_pct')}% of all account-weeks and disappeared in April 2026; "
     f"outside KaiChing, weekly real users fell from {f('users_core_first')} to {f('users_core_last')} ({f('users_core_fall_pct')}% lower).",
     ["stage/s1_tx_accounts.sql", "stage/s2_receipt_roles.sql", "stage/s5_relayed_gapfill.sql", "queries/q1_weekly_usage.sql"]),
    ("c2_levels.png",
     f"Intents cross-chain token movements rose from about {f('xchain_mean_first_quarter')} a week (first quarter) to "
     f"{f('xchain_mean_last_quarter')} (last quarter) while non-KaiChing users shrank; in levels the two are negatively correlated "
     f"({f('level_corr_xchain_core')}, n = {f('level_corr_n_xchain')} weeks), so they are not measuring the same thing.",
     ["stage/s3_intents_token_flows.sql", "queries/q2_intents_flows.sql", "queries/q1_weekly_usage.sql", "fetch/near_usdt_weekly.json"]),
    ("c3_xcorr.png",
     f"Week-to-week growth in Intents activity or in the NEAR price does not predict growth in real users 1–8 weeks later: "
     f"{f('lead_tests_significant')} of {f('lead_tests')} lead correlations clear the 95% band, about the {f('lead_tests_expected_by_chance')} "
     f"you would expect from noise alone.",
     ["analysis.py", "queries/q1_weekly_usage.sql", "queries/q2_intents_flows.sql"]),
    ("c4_out_of_sample.png",
     f"Trained on the first {f('n_fit_weeks')} weeks and tested on the last {f('n_test_weeks')}, adding Intents activity or price to a "
     f"simple autoregression never helps consistently: forecast error ranges from {100 * (1 - oos.rmse_ratio.min()):.0f}% better to "
     f"{100 * (oos.rmse_ratio.max() - 1):.0f}% worse (RMSE ratios {oos.rmse_ratio.min():g} to {oos.rmse_ratio.max():g}), and most cases are within 3%.",
     ["analysis.py"]),
    ("c5_nep245_vs_signers.png",
     f"Intents keeps balances in its own NEP-245 ledger: on {F['nep245_last_day']} {f('nep245_ledger_last')} accounts appeared in it in a single day, "
     f"while only a few hundred to a few thousand accounts a week sign transactions to intents.near themselves.",
     ["stage/s4_nep245_sample.sql", "queries/q3_nep245_sample.sql"]),
    ("c6_chains.png",
     f"Cross-chain movements came from {f('n_chains')} source chains; {F['top_chain'].upper()} assets alone were {f('top_chain_share_pct')}%.",
     ["stage/s3_intents_token_flows.sql", "queries/q2_intents_flows.sql"]),
]


def card(png, sentence, files):
    blocks = "".join(
        f'<details><summary><code>{html.escape(p)}</code></summary><pre>{html.escape(sql(p))}</pre></details>' for p in files)
    return (f'<div class="card chart"><img src="../charts/{png}" alt="{html.escape(sentence)}">'
            f'<p class="say">{html.escape(sentence)}</p>{blocks}</div>')


q = manifest.get("queries", {})
hashes = "".join(f"<tr><td><code>{n}</code></td><td>{r['rows']}</td><td><code>{r['result_sha256'][:16]}…</code></td></tr>"
                 for n, r in q.items())
page = f"""<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>NEAR thesis: is Intents volume a leading indicator of real usage?</title>
<link rel="stylesheet" href="site.css">
<style>
.chart img {{ width:100%; border-radius:8px; border:1px solid #e3e2da; background:#fff }}
.chart .say {{ color:var(--ink); font-size:16px; margin:12px 0 8px }}
details {{ margin:6px 0 }} summary {{ cursor:pointer; color:var(--muted); font-size:14px }}
details pre {{ max-height:420px; font-size:12px }}
.stack {{ display:grid; gap:22px }}
table {{ border-collapse:collapse; font-size:14px }} td {{ padding:4px 12px 4px 0 }}
</style>
</head><body>
<div class="hero">
  <header class="nav" style="padding-left:20px;padding-right:20px"><a class="brand" href="#" style="color:#eef3ec">NearBI</a><a href="#charts" style="color:#b9c7bd">Charts</a><a href="#repro" style="color:#b9c7bd">Reproduce</a></header>
  <div class="in">
    <h1>Is NEAR Intents volume a <em>leading indicator</em> of real usage?</h1>
    <p>We tested it on {f('weeks')} weeks of on-chain data. Neither Intents activity nor the NEAR price leads real-user growth. Intents grew while NEAR's own user base shrank: it measures a different population.</p>
  </div>
</div>
<section id="charts"><div class="wrap stack">
{''.join(card(*c) for c in CARDS)}
</div></section>
<section id="repro" style="background:#fff"><div class="wrap">
  <h2 class="sec">Reproduce</h2>
  <p class="sub">Every query has a fixed date window and a SHA-256 fingerprint. <code>make verify-cached</code> re-checks everything offline; <code>make verify</code> re-runs the aggregates on BigQuery.</p>
  <table><tr><td><b>query</b></td><td><b>rows</b></td><td><b>result sha256</b></td></tr>{hashes}</table>
</div></section>
<footer class="foot">NearBI research shop · data: bigquery-public-data.crypto_near_mainnet_us + Binance NEARUSDT weekly klines · window 2024-10-28 to 2026-10-25</footer>
</body></html>
"""
(ROOT / "dashboard" / "index.html").write_text(page)
print("wrote dashboard/index.html")

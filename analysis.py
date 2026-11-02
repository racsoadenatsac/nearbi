"""Thesis model: is NEAR Intents cross-chain activity a better leading indicator of real
network usage than the NEAR price?

Run by `run.py analyze` (and re-run by `verify-cached`) inside the rs-repro image with
ROOT (the pack) and OUT (where derived CSVs go). Inputs are only results/q*.csv (weekly
aggregates from BigQuery) and raw/near_usdt_weekly.json (public price series). Pure
pandas/numpy, no randomness, fixed rounding -> byte-identical outputs.

Outputs (OUT/):
  a_weekly.csv     the 104-week panel: levels and weekly log growth of every series
  a_xcorr.csv      lead/lag cross-correlations, lags -8..+8, with n and a 95% band
  a_oos.csv        out-of-sample test: AR(1) baseline vs AR(1) + lagged indicator
  a_families.csv   real users by account family, per week (for the stacked chart)
  a_chains.csv     cross-chain events by source chain, whole window
  a_nep245.csv     sampled-day NEP-245 ledger accounts next to same-week Intents signers
  a_facts.csv      every number quoted in THESIS.md / the dashboard, as displayed
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(globals().get("ROOT", Path(__file__).resolve().parent))
OUT = Path(globals().get("OUT", ROOT / "results"))
R = ROOT / "results"

# ---- parameters (also declared in THESIS.md front matter) ---------------------------
WEEKS = 104                 # 2024-10-28 .. 2026-10-25
LAGS = range(-8, 9)         # k > 0: indicator leads usage by k weeks
FIT_END = "2026-02-22"      # first 69 weeks (~16 months) fit, last 35 weeks (~8 months) test
BREAK = 0.5                 # |weekly log growth| above this marks a regime-break week
Z95 = 1.96

# ---- load ----------------------------------------------------------------------------
q1 = pd.read_csv(R / "q1_weekly_usage.csv")
q2 = pd.read_csv(R / "q2_intents_flows.csv")
q3 = pd.read_csv(R / "q3_nep245_sample.csv")
kl = json.loads((ROOT / "raw" / "near_usdt_weekly.json").read_text())

if isinstance(kl, list):        # Binance klines: [open_ms, open, high, low, close, ...]
    price = pd.DataFrame({"week": pd.to_datetime([k[0] for k in kl], unit="ms").strftime("%Y-%m-%d"),
                          "price_close": [float(k[4]) for k in kl]})
else:                           # CoinGecko fallback: {"prices": [[ms, usd], ...]} daily
    p = pd.DataFrame(kl["prices"], columns=["ms", "usd"])
    p["day"] = pd.to_datetime(p.ms, unit="ms")
    p["week"] = (p.day - pd.to_timedelta(p.day.dt.weekday, unit="D")).dt.strftime("%Y-%m-%d")
    price = p.sort_values("ms").groupby("week", as_index=False).usd.last().rename(columns={"usd": "price_close"})

usage_cols = ["users_any", "signers", "relayed_users", "heavy_accounts", "users_real", "users_engaged",
              "new_users", "retained", "tx_signed", "relayed_actions", "intents_tx_signers",
              "intents_tx_signers_real", "intents_tx"]
w = q1.groupby("week")[usage_cols].sum()
w["intents_actions"] = q1.groupby("week").intents_actions_week.first()
core = q1[q1.family != "kaiching"].groupby("week")[["users_real", "users_engaged"]].sum()
w["users_core"] = core.users_real          # real users excluding KaiChing app sub-accounts
w["engaged_core"] = core.users_engaged
xc = q2.groupby("week")[["events_in", "events_out", "events_burn"]].sum()
w = w.join(xc, how="left").fillna({"events_in": 0, "events_out": 0, "events_burn": 0})
w["xchain_events"] = w.events_in + w.events_out
w = w.join(price.set_index("week"), how="left").reset_index()
assert len(w) == WEEKS and w.price_close.notna().all(), "panel must cover all 104 weeks"
w = w.sort_values("week").reset_index(drop=True)


def glog(s):
    s = s.where(s > 0)
    return np.log(s).diff()


SERIES = {  # name -> (column, label)
    "users_real": ("users_real", "Real users (signers + relayed, minus heavy)"),
    "users_core": ("users_core", "Real users excluding KaiChing sub-accounts"),
    "users_engaged": ("users_engaged", "Engaged real users (>= 2 active days)"),
    "xchain_events": ("xchain_events", "Intents cross-chain token movements"),
    "intents_actions": ("intents_actions", "Actions executed on intents.near"),
    "price_close": ("price_close", "NEAR/USDT weekly close"),
}
for name, (col, _) in SERIES.items():
    w[f"g_{name}"] = glog(w[col]).round(6)
TARGETS = ("users_real", "users_core", "users_engaged")
for t in TARGETS:  # regime breaks are flagged per usage series, from that series' own growth
    w[f"break_{t}"] = (w[f"g_{t}"].abs() > BREAK).astype(int)
w["break_week"] = w.break_users_real
w["sample"] = np.where(w.week <= FIT_END, "fit", "test")


# ---- lead/lag cross-correlation --------------------------------------------------------
def xcorr(x, y, k):
    """corr(x[t-k], y[t]); k > 0 means x leads y."""
    a = pd.concat([x.shift(k), y], axis=1).dropna()
    n = len(a)
    if n < 10:
        return np.nan, np.nan, n
    # Spearman = Pearson on average ranks (no scipy in the image)
    rx, ry = a.iloc[:, 0].rank(), a.iloc[:, 1].rank()
    return a.iloc[:, 0].corr(a.iloc[:, 1]), rx.corr(ry), n


rows = []
for target in ("users_real", "users_core", "users_engaged"):
    for ind in ("xchain_events", "intents_actions", "price_close"):
        for drop_breaks in (0, 1):
            y = w[f"g_{target}"].where(w[f"break_{target}"] == 0) if drop_breaks else w[f"g_{target}"]
            for k in LAGS:
                r, rho, n = xcorr(w[f"g_{ind}"], y, k)
                rows.append({"target": target, "indicator": ind, "drop_breaks": drop_breaks, "lag": k,
                             "n": n, "pearson": round(r, 2), "spearman": round(rho, 2),
                             "band95": round(Z95 / np.sqrt(n), 2),
                             "significant": int(abs(r) > Z95 / np.sqrt(n))})
xc = pd.DataFrame(rows)


# ---- out-of-sample test ----------------------------------------------------------------
def ols(X, y):
    X1 = np.column_stack([np.ones(len(X)), X])
    beta, *_ = np.linalg.lstsq(X1, y, rcond=None)
    return beta


def predict(beta, X):
    return np.column_stack([np.ones(len(X)), X]) @ beta


oos = []
for target in ("users_real", "users_core", "users_engaged"):
    for ind in ("xchain_events", "intents_actions", "price_close"):
        for drop_breaks in (0, 1):
            d = pd.DataFrame({"week": w.week, "y": w[f"g_{target}"], "y1": w[f"g_{target}"].shift(1),
                              "brk": w[f"break_{target}"], "x": w[f"g_{ind}"]})
            if drop_breaks:
                d = d[(d.brk == 0) & (d.brk.shift(1).fillna(0) == 0)]
            fit = d[d.week <= FIT_END]
            # lag chosen on the fit sample only: best |corr| among leads 1..8
            cands = []
            for k in range(1, 9):
                f = pd.DataFrame({"y": fit.y, "x": d.x.shift(k).reindex(fit.index)}).dropna()
                cands.append((abs(f.x.corr(f.y)), k))
            best_k = max(cands)[1]
            d = d.assign(xk=w[f"g_{ind}"].shift(best_k).reindex(d.index)).dropna()
            fit, test = d[d.week <= FIT_END], d[d.week > FIT_END]
            b0 = ols(fit[["y1"]].values, fit.y.values)
            b1 = ols(fit[["y1", "xk"]].values, fit.y.values)
            e0 = test.y.values - predict(b0, test[["y1"]].values)
            e1 = test.y.values - predict(b1, test[["y1", "xk"]].values)
            rm0, rm1 = np.sqrt(np.mean(e0 ** 2)), np.sqrt(np.mean(e1 ** 2))
            oos.append({"target": target, "indicator": ind, "drop_breaks": drop_breaks, "lag": best_k,
                        "n_fit": len(fit), "n_test": len(test), "coef_x": round(b1[2], 3),
                        "rmse_ar1": round(rm0, 4), "rmse_with_x": round(rm1, 4),
                        "rmse_ratio": round(rm1 / rm0, 3),
                        "improves": int(rm1 < rm0)})
oos = pd.DataFrame(oos)

# ---- families, chains, NEP-245 ------------------------------------------------------------
fam = q1.pivot(index="week", columns="family", values="users_real").fillna(0).astype(int).reset_index()
chains = (q2.groupby("chain")[["events_in", "events_out", "events_burn"]].sum()
          .assign(events=lambda t: t.events_in + t.events_out).sort_values(["events", "chain"], ascending=[False, True])
          .reset_index())
chains["share_pct"] = (100 * chains.events / chains.events.sum()).round(1)
q3 = q3.copy()
q3["week"] = (pd.to_datetime(q3.block_date) - pd.to_timedelta(pd.to_datetime(q3.block_date).dt.weekday, unit="D")).dt.strftime("%Y-%m-%d")
nep = q3.merge(w[["week", "intents_tx_signers_real", "users_real", "users_core"]], on="week", how="left")
nep["ledger_per_tx_signer"] = (nep.ledger_accounts / nep.intents_tx_signers_real).round(1)
nep = nep[["block_date", "week", "ledger_accounts", "transfer_accounts", "mint_accounts", "burn_accounts",
           "transfer_items", "intents_tx_signers_real", "users_real", "users_core", "ledger_per_tx_signer"]]

# ---- facts quoted in prose ----------------------------------------------------------------
F = {}


def fact(key, value):
    F[key] = value


def row(week):
    return w[w.week == week].iloc[0]


first, last = w.iloc[0], w.iloc[-1]
peak = w.loc[w.users_real.idxmax()]
fact("weeks", len(w))
fact("n_fit_weeks", int((w.week <= FIT_END).sum()))
fact("n_test_weeks", int((w.week > FIT_END).sum()))
fact("users_real_first", int(first.users_real)); fact("users_real_last", int(last.users_real))
fact("users_real_peak", int(peak.users_real)); fact("users_real_peak_week", peak.week)
fact("users_real_fall_x_from_peak", round(peak.users_real / last.users_real, 1))
fact("users_core_first", int(first.users_core)); fact("users_core_last", int(last.users_core))
fact("users_core_fall_pct", round(100 * (1 - last.users_core / first.users_core), 1))
fact("signers_first", int(first.signers)); fact("signers_last", int(last.signers))
fact("price_first", round(first.price_close, 3)); fact("price_last", round(last.price_close, 3))
fact("price_change_pct", round(100 * (last.price_close / first.price_close - 1), 1))
fact("price_min", round(w.price_close.min(), 3)); fact("price_min_week", w.loc[w.price_close.idxmin()].week)
fact("price_max", round(w.price_close.max(), 3)); fact("price_max_week", w.loc[w.price_close.idxmax()].week)
fs = w[w.xchain_events > 0].iloc[0]
fact("xchain_first_week", fs.week)
x_early = w[(w.week >= "2024-11-04") & (w.week <= "2025-01-26")].xchain_events.mean()
x_late = w[w.week >= "2026-08-03"].xchain_events.mean()
fact("xchain_mean_first_quarter", int(round(x_early))); fact("xchain_mean_last_quarter", int(round(x_late)))
fact("xchain_growth_x", round(x_late / x_early, 1))
u_early = w[(w.week >= "2024-11-04") & (w.week <= "2025-01-26")].users_core.mean()
u_late = w[w.week >= "2026-08-03"].users_core.mean()
fact("core_mean_first_quarter", int(round(u_early))); fact("core_mean_last_quarter", int(round(u_late)))
fact("xchain_total", int(w.xchain_events.sum())); fact("xchain_burn_total", int(w.events_burn.sum()))
fact("xchain_peak", int(w.xchain_events.max())); fact("xchain_peak_week", w.loc[w.xchain_events.idxmax()].week)
fact("intents_actions_peak", int(w.intents_actions.max())); fact("intents_actions_peak_week", w.loc[w.intents_actions.idxmax()].week)
fact("n_chains", int(len(chains))); fact("top_chain", chains.iloc[0].chain); fact("top_chain_share_pct", chains.iloc[0].share_pct)
fact("n_break_weeks", int(w.break_week.sum()))
for t in TARGETS:
    fact(f"n_break_weeks|{t}", int(w[f"break_{t}"].sum()))
for wk in w[w.break_week == 1].week:
    fact(f"break_{wk}", round(float(row(wk).g_users_real), 2))
# regime artifacts of the KaiChing app (sub-accounts *.users.kaiching)
kc = q1[q1.family == "kaiching"].set_index("week").reindex(w.week).fillna(0)
for wk in ("2024-10-28", "2025-02-10", "2025-02-17", "2025-02-24", "2026-03-23", "2026-03-30", "2026-04-06",
           "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12"):
    fact(f"kc_signers_{wk}", int(kc.loc[wk].signers)); fact(f"kc_relayed_{wk}", int(kc.loc[wk].relayed_users))
    fact(f"kc_real_{wk}", int(kc.loc[wk].users_real))
fact("kc_new_2026-09-28", int(kc.loc["2026-09-28"].new_users))
fact("kc_share_users_real_pct", round(100 * kc.users_real.sum() / w.users_real.sum(), 1))
fact("kc_peak_real", int(kc.users_real.max())); fact("kc_peak_week", kc.users_real.idxmax())
kc_weeks = kc[kc.users_real > 0]
fact("kc_weeks_present", int(len(kc_weeks)))
fact("kc_share_peak_week_pct", round(100 * kc.loc[kc.users_real.idxmax()].users_real / w.set_index("week").loc[kc.users_real.idxmax()].users_real, 1))
ov = q1[q1.week == "2025-02-24"]
fact("overlap_s5_relayed", int(ov.relayed_users.sum())); fact("overlap_flag_relayed", int(ov.flagged_relayed_week.iloc[0]))
fact("relayed_first_week", int(first.relayed_users)); fact("relayed_share_first_pct", round(100 * first.relayed_users / first.users_any, 1))
fact("users_any_first", int(first.users_any))
fact("signers_2026-09-21", int(row("2026-09-21").signers)); fact("signers_2026-09-28", int(row("2026-09-28").signers))
fact("signers_2026-10-19", int(row("2026-10-19").signers))
fact("heavy_median", int(w.heavy_accounts.median()))
fact("engaged_share_last_pct", round(100 * last.users_engaged / last.users_real, 1))
# cross-correlation summaries (primary = Pearson, all weeks, k = 1..8 leads)
for target in ("users_real", "users_core", "users_engaged"):
    for ind in ("xchain_events", "intents_actions", "price_close"):
        for db in (0, 1):
            s = xc[(xc.target == target) & (xc.indicator == ind) & (xc.drop_breaks == db)]
            lead = s[s.lag > 0]
            best = lead.loc[lead.pearson.abs().idxmax()]
            tag = f"{target}|{ind}|{'nobreak' if db else 'all'}"
            fact(f"xc_best_lag|{tag}", int(best.lag)); fact(f"xc_best_r|{tag}", best.pearson)
            fact(f"xc_best_n|{tag}", int(best.n)); fact(f"xc_band|{tag}", best.band95)
            fact(f"xc_sig_leads|{tag}", int(lead.significant.sum()))
            fact(f"xc_lag0_r|{tag}", s[s.lag == 0].pearson.iloc[0])
            fact(f"xc_lag0_n|{tag}", int(s[s.lag == 0].n.iloc[0])); fact(f"xc_lag0_band|{tag}", s[s.lag == 0].band95.iloc[0])
            fact(f"xc_lag0_sig|{tag}", int(s[s.lag == 0].significant.iloc[0]))
            fact(f"xc_best_spearman|{tag}", best.spearman)
            fact(f"xc_sig_lags_any|{tag}", int(s.significant.sum()))
for _, o in oos.iterrows():
    tag = f"{o.target}|{o.indicator}|{'nobreak' if o.drop_breaks else 'all'}"
    fact(f"oos_ratio|{tag}", o.rmse_ratio); fact(f"oos_lag|{tag}", int(o.lag))
    fact(f"oos_ntest|{tag}", int(o.n_test)); fact(f"oos_nfit|{tag}", int(o.n_fit))
lead_tests = xc[xc.lag > 0]
fact("lead_tests", int(len(lead_tests)))
fact("lead_tests_significant", int(lead_tests.significant.sum()))
fact("lead_tests_expected_by_chance", round(0.05 * len(lead_tests), 1))
for ind in ("xchain_events", "intents_actions", "price_close"):
    li = lead_tests[lead_tests.indicator == ind]
    fact(f"lead_tests|{ind}", int(len(li))); fact(f"lead_sig|{ind}", int(li.significant.sum()))
    fact(f"lead_sig_pos|{ind}", int(((li.significant == 1) & (li.pearson > 0)).sum()))
    fact(f"lead_max_abs_r|{ind}", float(li.pearson.abs().max()))
fact("oos_improves_xchain", int(oos[oos.indicator == "xchain_events"].improves.sum()))
fact("oos_improves_actions", int(oos[oos.indicator == "intents_actions"].improves.sum()))
fact("oos_improves_price", int(oos[oos.indicator == "price_close"].improves.sum()))
fact("oos_cases_per_indicator", int((oos.indicator == "price_close").sum()))
fact("oos_fits", int(len(oos))); fact("oos_within_3pct", int(((oos.rmse_ratio - 1).abs() <= 0.03).sum()))
fact("oos_best_gain_xchain_pct", round(100 * (1 - oos[oos.indicator == "xchain_events"].rmse_ratio.min()), 1))
fact("oos_ratio_min", float(oos.rmse_ratio.min())); fact("oos_ratio_max", float(oos.rmse_ratio.max()))
lvl = w[w.xchain_events > 0]
fact("level_corr_xchain_core", round(np.log(lvl.xchain_events).corr(np.log(lvl.users_core)), 2))
fact("level_corr_price_core", round(np.log(w.price_close).corr(np.log(w.users_core)), 2))
fact("level_corr_n_xchain", int(len(lvl)))
fact("nep245_days", int(len(q3))); fact("nep245_sample_days_planned", 26)
fact("nep245_ledger_max", int(nep.ledger_accounts.max())); fact("nep245_ledger_max_day", nep.loc[nep.ledger_accounts.idxmax()].block_date)
fact("nep245_ledger_last", int(nep.iloc[-1].ledger_accounts)); fact("nep245_last_day", nep.iloc[-1].block_date)
fact("nep245_ratio_median", round(float(nep.ledger_per_tx_signer.median()), 1))
fact("intents_tx_signers_real_last", int(last.intents_tx_signers_real))

facts = pd.DataFrame({"key": list(F), "value": [F[k] for k in F]})
facts["abs_value"] = [abs(v) if isinstance(v, (int, float, np.integer, np.floating)) else "" for v in facts.value]

# ---- write ------------------------------------------------------------------------------------
OUT.mkdir(parents=True, exist_ok=True)
fmt = dict(index=False, lineterminator="\n", float_format="%.10g")
keep = ["week", "sample", "break_week", "price_close", "users_any", "signers", "relayed_users", "heavy_accounts",
        "users_real", "users_core", "users_engaged", "engaged_core", "new_users", "retained",
        "break_users_core", "break_users_engaged", "intents_tx_signers_real",
        "intents_actions", "xchain_events", "events_in", "events_out", "events_burn"] + [f"g_{n}" for n in SERIES]
w[keep].to_csv(OUT / "a_weekly.csv", **fmt)
xc.to_csv(OUT / "a_xcorr.csv", **fmt)
oos.to_csv(OUT / "a_oos.csv", **fmt)
fam.to_csv(OUT / "a_families.csv", **fmt)
chains.to_csv(OUT / "a_chains.csv", **fmt)
nep.to_csv(OUT / "a_nep245.csv", **fmt)
facts.to_csv(OUT / "a_facts.csv", **fmt)
print(f"analysis: {len(w)} weeks, {len(xc)} correlations, {len(oos)} out-of-sample fits, {len(facts)} facts")

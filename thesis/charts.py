"""Designed charts for the NEAR Intents leading-indicator thesis.

Run by `run.py charts` inside the rs-repro image (house style applied first). Every value
drawn, every annotation and every number in a title is read from results/*.csv.
"""
from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import matplotlib.ticker as mtick
import numpy as np
import pandas as pd

import style
from style import ACCENT, ACCENT_2, INK, MUTED, SOFT, WARN, human
from style import GRID as GRID_C

ROOT = Path(globals().get("ROOT", Path(__file__).resolve().parent))
R, C = ROOT / "results", ROOT / "charts"
C.mkdir(exist_ok=True)
SRC = ("Source: bigquery-public-data.crypto_near_mainnet_us (on-chain) + Binance NEARUSDT 1w klines · "
       "104 ISO weeks 2024-10-28 to 2026-10-25 · Research Shop")
humanf = mtick.FuncFormatter(lambda v, _: human(v))

w = pd.read_csv(R / "a_weekly.csv", parse_dates=["week"])
fam = pd.read_csv(R / "a_families.csv", parse_dates=["week"])
xc = pd.read_csv(R / "a_xcorr.csv")
oos = pd.read_csv(R / "a_oos.csv")
chains = pd.read_csv(R / "a_chains.csv")
nep = pd.read_csv(R / "a_nep245.csv", parse_dates=["block_date", "week"])
F = pd.read_csv(R / "a_facts.csv").set_index("key").value


def f(key, cast=float):
    return cast(F[key])


def save(fig, name):
    style.source(fig, SRC)
    fig.savefig(C / f"{name}.png")
    plt.close(fig)
    print(f"wrote charts/{name}.png")


def months(ax):
    ax.xaxis.set_major_locator(mdates.MonthLocator(bymonth=(1, 4, 7, 10)))
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %Y"))


def note(ax, text, xy, xytext, **kw):
    ax.annotate(text, xy=xy, xytext=xytext, textcoords="offset points", fontsize=9, color=INK,
                bbox=dict(boxstyle="round,pad=0.35", fc="white", ec=GRID_C, lw=0.8),
                arrowprops=dict(arrowstyle="-", color=MUTED, lw=0.8), **kw)


# 1. Real users by account family ---------------------------------------------------------------
order = [("kaiching", "KaiChing sub-accounts", WARN), ("hot_tg", "HOT (*.tg)", ACCENT),
         ("implicit", "Implicit (64-hex)", ACCENT_2), ("named_near", "Named *.near", "#7048e8"),
         ("other", "Other", MUTED), ("evm_0x", "EVM 0x", "#adb5bd"), ("sweat", "Sweat", "#ced4da")]
order = [o for o in order if o[0] in fam.columns]
fig, ax = plt.subplots(figsize=(10, 4.8))
ax.stackplot(fam.week, *[fam[k] for k, _, _ in order], labels=[l for _, l, _ in order],
             colors=[c for _, _, c in order], alpha=0.9, lw=0)
ax.yaxis.set_major_formatter(humanf)
months(ax)
exit_wk = pd.Timestamp("2026-04-06")
note(ax, f"KaiChing gone by {exit_wk:%d %b %Y}\n(from {human(f('kc_real_2026-03-23'))} accounts two weeks earlier)",
     (exit_wk, f("kc_real_2026-03-30")), (-330, 60))
surge = pd.Timestamp("2026-09-28")
note(ax, f"{human(f('kc_signers_2026-09-28'))} KaiChing accounts sign directly\nfor two weeks, then vanish",
     (surge, w.set_index("week").loc[surge].users_real), (-120, 150))
ax.set_title(f"One app was {f('kc_share_users_real_pct'):g}% of NEAR's real users; without it usage fell {f('users_core_fall_pct'):g}%")
style.subtitle(ax, "Weekly real users (signers + relayed end users, minus accounts with ≥1,000 actions/week), by account family")
ax.legend(loc="upper right", ncol=4, fontsize=8)
save(fig, "c1_real_users_by_family")

# 2. Levels: Intents cross-chain activity vs real users vs price ------------------------------------
fig, axes = plt.subplots(3, 1, figsize=(10, 7.2), sharex=True, gridspec_kw={"hspace": 0.35})
ax = axes[0]
ax.bar(w.week, w.xchain_events, width=5, color=ACCENT)
ax.yaxis.set_major_formatter(humanf); ax.set_ylabel("cross-chain token\nmovements / week")
pk = w.loc[w.xchain_events.idxmax()]
note(ax, f"peak {human(pk.xchain_events)} ({pk.week:%d %b %Y})", (pk.week, pk.xchain_events), (-190, -18))
ax.set_title(f"Intents cross-chain activity grew {f('xchain_growth_x'):g}x while non-KaiChing users shrank "
             f"(level correlation {f('level_corr_xchain_core'):g})")
style.subtitle(ax, "Weekly *.omft.near token movements in/out of intents.near (top) · real users (middle) · NEAR price (bottom)")
ax = axes[1]
ax.plot(w.week, w.users_real, color=MUTED, lw=1.4, label="Real users (all)")
ax.plot(w.week, w.users_core, color=ACCENT_2, lw=2.4, label="Real users excl. KaiChing")
ax.yaxis.set_major_formatter(humanf); ax.set_ylabel("accounts / week"); ax.legend(loc="upper right")
ax = axes[2]
ax.plot(w.week, w.price_close, color=INK, lw=2)
ax.yaxis.set_major_formatter(mtick.StrMethodFormatter("${x:,.0f}")); ax.set_ylabel("NEAR/USDT close")
lo = w.loc[w.price_close.idxmin()]
note(ax, f"low ${lo.price_close:.2f} ({lo.week:%d %b %Y})", (lo.week, lo.price_close), (30, 25))
months(ax)
save(fig, "c2_levels")

# 3. Lead/lag cross-correlations ------------------------------------------------------------------
fig, axes = plt.subplots(1, 2, figsize=(11, 4.4), sharey=True)
for ax, ind, label, color in ((axes[0], "xchain_events", "Intents cross-chain movements", ACCENT),
                              (axes[1], "price_close", "NEAR price", INK)):
    s_all = xc[(xc.target == "users_real") & (xc.indicator == ind) & (xc.drop_breaks == 0)]
    s_nb = xc[(xc.target == "users_real") & (xc.indicator == ind) & (xc.drop_breaks == 1)]
    ax.fill_between(s_nb.lag, -s_nb.band95, s_nb.band95, color=GRID_C, alpha=0.6, lw=0, label="95% noise band", zorder=0)
    ax.bar(s_nb.lag, s_nb.pearson, color=[color if g else "#b9c2bd" for g in s_nb.significant], width=0.7,
           label="excl. regime-break weeks (dark = outside band)", zorder=2)
    ax.plot(s_all.lag, s_all.pearson, "o", color=WARN, ms=4, label="all weeks", zorder=3)
    ax.axvline(0, color=MUTED, lw=0.8)
    ax.set_xticks(range(-8, 9, 2)); ax.set_xlabel("lag k (weeks) · k > 0: indicator leads usage")
    ax.text(0.02, 0.96, label, transform=ax.transAxes, fontsize=10.5, weight="bold", va="top")
    ax.set_ylim(-0.6, 0.6)
axes[0].legend(loc="lower left", fontsize=8)
axes[0].set_title(f"Neither series leads real-usage growth: {f('lead_tests_significant', int)} of {f('lead_tests', int)} "
                  f"lead tests clear the band, ~{f('lead_tests_expected_by_chance'):g} expected by chance")
style.subtitle(axes[0], "Pearson correlation of weekly log growth, corr(indicator[t−k], real users[t]), lags −8..+8, "
                        f"n = {int(xc.n.min())}–{int(xc.n.max())} weeks per lag")
save(fig, "c3_xcorr")

# 4. Out-of-sample test ---------------------------------------------------------------------------
lab = {"users_real": "Real users", "users_core": "excl. KaiChing", "users_engaged": "Engaged (≥2 days)"}
ind_c = {"xchain_events": (ACCENT, "Intents cross-chain"), "intents_actions": (ACCENT_2, "intents.near actions"),
         "price_close": (INK, "NEAR price")}
fig, ax = plt.subplots(figsize=(10, 4.4))
xt, xl = [], []
for i, (t, db) in enumerate([(t, db) for t in lab for db in (0, 1)]):
    for j, ind in enumerate(ind_c):
        r = oos[(oos.target == t) & (oos.indicator == ind) & (oos.drop_breaks == db)].iloc[0]
        ax.bar(i * 4 + j, r.rmse_ratio - 1, bottom=1, color=ind_c[ind][0], width=0.85,
               label=ind_c[ind][1] if i == 0 else None)
    xt.append(i * 4 + 1); xl.append(f"{lab[t]}\n{'excl. breaks' if db else 'all weeks'}")
ax.axhline(1, color=WARN, lw=1.2)
ax.text(-0.6, 0.995, "1.0 = no better than AR(1)", color=WARN, fontsize=8.5, ha="left", va="top")
ax.set_xticks(xt); ax.set_xticklabels(xl, fontsize=8)
ax.set_ylabel("test RMSE ÷ AR(1) RMSE")
ax.set_ylim(min(0.85, oos.rmse_ratio.min() - 0.03), max(1.2, oos.rmse_ratio.max() + 0.03))
ax.legend(loc="upper left", ncol=3)
ax.set_title(f"Out of sample, no indicator reliably beats a plain autoregression "
             f"(RMSE ratios {oos.rmse_ratio.min():g}–{oos.rmse_ratio.max():g})")
style.subtitle(ax, f"Fit on the first {f('n_fit_weeks', int)} weeks, test on the last {f('n_test_weeks', int)}; "
                   "lag chosen on the fit sample only; below 1 = the indicator helped")
save(fig, "c4_out_of_sample")

# 5. NEP-245 ledger accounts vs direct Intents signers ---------------------------------------------
fig, ax = plt.subplots(figsize=(10, 4.4))
ax.bar(nep.block_date, nep.ledger_accounts, width=16, color=ACCENT, label="Accounts in Intents' NEP-245 ledger (one sampled day)")
ax.plot(nep.block_date, nep.intents_tx_signers_real, color=ACCENT_2, lw=2.2, marker="o", ms=3.5,
        label="Accounts signing a tx to intents.near (that whole week)")
ax.set_yscale("log"); ax.yaxis.set_major_formatter(humanf)
last = nep.iloc[-2]
note(ax, f"{last.block_date:%d %b %Y}: {human(last.ledger_accounts)} ledger accounts in one day\nvs {int(last.intents_tx_signers_real)} direct signers all week",
     (last.block_date, last.ledger_accounts), (-280, -150))
months(ax)
ax.set_title("Since late 2025 most Intents users never sign a NEAR transaction, so signer counts miss them")
style.subtitle(ax, f"{f('nep245_days', int)} sampled days (one Wednesday every 4 weeks), from EVENT_JSON logs of intents.near · log scale")
ax.legend(loc="upper left", fontsize=8.5)
save(fig, "c5_nep245_vs_signers")

# 6. Which chains ----------------------------------------------------------------------------------
top = chains.head(10).iloc[::-1]
fig, ax = plt.subplots(figsize=(9, 4.2))
ax.barh(top.chain, top.share_pct, color=[ACCENT if i >= len(top) - 2 else SOFT for i in range(len(top))])
for y, (v, n) in enumerate(zip(top.share_pct, top.events)):
    ax.text(v + 0.4, y, f"{v:g}%  ({human(n)})", va="center", fontsize=8.5, color=INK)
ax.xaxis.set_major_formatter(mtick.PercentFormatter(decimals=0)); ax.grid(axis="x"); ax.grid(axis="y", visible=False)
two = chains.head(2)
ax.set_title(f"{two.chain.iloc[0].upper()} and {two.chain.iloc[1].upper()} assets are {two.share_pct.sum():g}% of Intents' cross-chain movements")
style.subtitle(ax, f"Share of all *.omft.near token movements through intents.near by source chain, {f('n_chains', int)} chains, whole window")
save(fig, "c6_chains")

"""Designed charts for 'NEAR activity: real users or bots?'.

Run by `run.py charts` inside the rs-repro image (house style already applied).
Every value drawn or annotated is read from results/*.csv, so nothing is typed in by hand.
"""
import re
from pathlib import Path

import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import matplotlib.ticker as mtick
import pandas as pd

import style
from matplotlib.patches import Patch
from style import ACCENT, ACCENT_2, INK, MUTED, SOFT, WARN, human
from style import GRID as GRID_C

ROOT = Path(globals().get("ROOT", Path(__file__).resolve().parent))
R, C = ROOT / "results", ROOT / "charts"
C.mkdir(exist_ok=True)
SRC = "Source: bigquery-public-data.crypto_near_mainnet_us · window 2026-09-08 to 2026-10-07 · Research Shop"
thousands = mtick.FuncFormatter(lambda v, _: human(v))


def save(fig, name):
    style.source(fig, SRC)
    fig.savefig(C / f"{name}.png")
    plt.close(fig)
    print(f"wrote charts/{name}.png")


# 1. Daily activity: signers vs transactions -----------------------------------
d = pd.read_csv(R / "q1_daily_activity.csv", parse_dates=["block_date"]).sort_values("block_date")
fig, ax = plt.subplots(figsize=(10, 4.6))
ax2 = ax.twinx()
ax.bar(d.block_date, d.tx_count, color=SOFT, width=0.8, label="Transactions (left)")
ax2.plot(d.block_date, d.distinct_signers, color=ACCENT, lw=2.6, marker="o", ms=3.5, label="Distinct signers (right)")
surge = d[d.block_date >= "2026-10-02"]
ax2.axvspan(surge.block_date.min() - pd.Timedelta(hours=12), surge.block_date.max() + pd.Timedelta(hours=12),  # noqa
            color=ACCENT, alpha=0.06, lw=0)
before = d[d.block_date == "2026-10-01"].iloc[0]
peak = d.loc[d.distinct_signers.idxmax()]
ax2.annotate(f"{human(before.distinct_signers)} → {human(peak.distinct_signers)} signers\n"
             f"tx per signer {before.tx_per_signer:g} → {d.tx_per_signer.min():g}",
             xy=(peak.block_date, peak.distinct_signers), xytext=(-250, -95), textcoords="offset points",
             fontsize=9.5, color=INK, weight="bold",
             bbox=dict(boxstyle="round,pad=0.4", fc="white", ec=GRID_C, lw=0.8),
             arrowprops=dict(arrowstyle="-", color=MUTED, lw=0.8))
for a in (ax, ax2):
    a.yaxis.set_major_formatter(thousands)
    a.set_ylim(0, None)
ax2.grid(False); ax2.spines["right"].set_visible(False); ax2.tick_params(axis="y", colors=ACCENT)
ax.xaxis.set_major_locator(mdates.WeekdayLocator(byweekday=mdates.MO))
ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
ax.set_title("Signers nearly tripled in early October; transactions didn't")
style.subtitle(ax, "Daily NEAR mainnet transactions (bars) and distinct signing accounts (line)")
h1, l1 = ax.get_legend_handles_labels(); h2, l2 = ax2.get_legend_handles_labels()
ax.legend(h1 + h2, l1 + l2, loc="upper left", ncol=2)
save(fig, "q1_daily_activity")

# 2. Concentration over time -------------------------------------------------------
c = pd.read_csv(R / "q2_concentration.csv", parse_dates=["block_date"]).sort_values("block_date")
fig, ax = plt.subplots(figsize=(10, 4.4))
ax.fill_between(c.block_date, 0, c.pct_top100, color=SOFT, lw=0, label="Top 100 signers")
ax.fill_between(c.block_date, 0, c.pct_top10, color=ACCENT, alpha=0.85, lw=0, label="Top 10 signers")
ax.set_ylim(0, 100)
ax.yaxis.set_major_formatter(mtick.PercentFormatter(decimals=0))
lo10, hi10 = c.pct_top10.min(), c.pct_top10.max()
ax.text(c.block_date.iloc[1], 25, f"Top 10: {lo10:g}%–{hi10:g}% of daily tx", color="white",
        fontsize=10, weight="bold")
ax.text(c.block_date.iloc[1], c.pct_top100.max() - 4, f"Top 100: {c.pct_top100.min():g}%–{c.pct_top100.max():g}%",
        color=INK, fontsize=10, weight="bold", va="top")
ax.xaxis.set_major_locator(mdates.WeekdayLocator(byweekday=mdates.MO))
ax.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
ax.set_title("A handful of accounts send most of NEAR's transactions, every day")
style.subtitle(ax, "Share of each day's transactions signed by the busiest 10 and 100 accounts")
ax.legend(loc="lower right", ncol=2)
save(fig, "q2_concentration")

# 3. Hero: share of signers vs share of transactions -----------------------------
b = pd.read_csv(R / "q3_signer_buckets.csv").sort_values("bucket")
labels = [re.sub(r"^\d_", "", s).replace(" (", "\n(") for s in b.bucket]
fig, ax = plt.subplots(figsize=(10, 4.8))
y = range(len(b))
h = 0.38
ax.barh([i + h / 2 for i in y], b.pct_signers, height=h, color=MUTED, label="% of signers")
ax.barh([i - h / 2 for i in y], b.pct_tx, height=h, color=ACCENT, label="% of transactions")
for i, (ps, pt, n) in enumerate(zip(b.pct_signers, b.pct_tx, b.signers)):
    ax.text(ps + 1, i + h / 2, f"{ps:g}%  ({n:,} signers)", va="center", fontsize=8.5, color=MUTED)
    ax.text(pt + 1, i - h / 2, f"{pt:g}%", va="center", fontsize=9.5, color=ACCENT, weight="bold")
ax.set_yticks(list(y)); ax.set_yticklabels(labels, fontsize=9)
ax.invert_yaxis()
ax.set_xlim(0, 112)
ax.xaxis.set_major_formatter(mtick.PercentFormatter(decimals=0))
ax.grid(axis="x"); ax.grid(axis="y", visible=False)
top = b.iloc[-1]
ax.set_title(f"{top.pct_signers:g}% of signers produced {top.pct_tx:g}% of transactions")
style.subtitle(ax, "Signers grouped by average transactions per active day, 30 days")
ax.legend(loc="lower right")
save(fig, "q3_signer_buckets")

# 4. Top 15 signers, coloured by name pattern -------------------------------------
t = pd.read_csv(R / "q4_top_signers.csv").sort_values("tx")


def kind(acct):
    if "relay" in acct:
        return "Relayer-style name"
    if re.fullmatch(r"[a-z]+\d+\.near", acct):
        return "Generated-looking name"
    return "Other"


colors = {"Relayer-style name": ACCENT, "Generated-looking name": WARN, "Other": ACCENT_2}
t["kind"] = t.signer_account_id.map(kind)
names = [a if len(a) <= 28 else a[:12] + "…" + a[-8:] for a in t.signer_account_id]
fig, ax = plt.subplots(figsize=(10, 5.6))
ax.barh(names, t.tx, color=[colors[k] for k in t.kind], height=0.7)
for i, (v, perday) in enumerate(zip(t.tx, t.tx_per_active_day)):
    ax.text(v, i, f"  {human(v)}  ({human(perday)}/day)", va="center", fontsize=8.5, color=INK)
ax.set_xscale("log")
ax.set_xlim(t.tx.min() * 0.7, t.tx.max() * 6)
ax.xaxis.set_major_formatter(thousands)
ax.grid(axis="x"); ax.grid(axis="y", visible=False)
ax.tick_params(axis="y", labelsize=9, colors=INK)
ax.legend(handles=[Patch(color=col, label=k) for k, col in colors.items()], loc="lower right")
ax.set_title("The busiest signers are relayers and generated-looking accounts")
style.subtitle(ax, "Transactions per account over 30 days (log scale). Colour = name pattern only, not verified identity")
save(fig, "q4_top_signers")

"""Research Shop house chart style (matplotlib). Import and call apply()."""
import matplotlib as mpl
from matplotlib import font_manager

INK = "#1b1d1f"
MUTED = "#8a8f94"
GRID = "#e6e6e1"
ACCENT = "#00b37a"      # NEAR-ish green: the series the story is about
ACCENT_2 = "#1f6feb"    # secondary series
WARN = "#e8590c"        # call-outs
SOFT = "#cfe9df"        # context fills
PALETTE = [ACCENT, ACCENT_2, WARN, "#7048e8", MUTED]


def _font():
    names = {f.name for f in font_manager.fontManager.ttflist}
    for cand in ("Inter", "Helvetica Neue", "Arial", "DejaVu Sans"):
        if cand in names:
            return cand
    return "sans-serif"


def apply():
    mpl.rcParams.update({
        "font.family": _font(),
        "font.size": 10.5,
        "axes.titlesize": 14, "axes.titleweight": "bold", "axes.titlelocation": "left", "axes.titlepad": 26,
        "axes.labelcolor": MUTED, "axes.labelsize": 9.5,
        "axes.edgecolor": GRID, "axes.spines.top": False, "axes.spines.right": False, "axes.spines.left": False,
        "axes.grid": True, "axes.grid.axis": "y", "grid.color": GRID, "grid.linewidth": 0.8,
        "axes.prop_cycle": mpl.cycler(color=PALETTE),
        "xtick.color": MUTED, "ytick.color": MUTED, "xtick.labelsize": 9, "ytick.labelsize": 9,
        "ytick.left": False, "xtick.major.size": 0,
        "legend.frameon": False, "legend.fontsize": 9,
        "figure.dpi": 100, "savefig.dpi": 200, "savefig.bbox": "tight", "savefig.pad_inches": 0.25,
        "figure.facecolor": "white", "axes.facecolor": "white",
        "text.color": INK,
    })


def subtitle(ax, text):
    """Grey one-line subtitle under the left-aligned title."""
    ax.text(0, 1.035, text, transform=ax.transAxes, fontsize=9.5, color=MUTED, va="bottom")


def source(fig, text):
    fig.text(0.01, -0.02, text, fontsize=7.5, color=MUTED, ha="left", va="top")


def human(n):
    n = float(n)
    for div, suf in ((1e9, "B"), (1e6, "M"), (1e3, "k")):
        if abs(n) >= div:
            return f"{n / div:.1f}{suf}".replace(".0" + suf, suf)
    return f"{n:.0f}"

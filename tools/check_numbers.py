"""No-invented-numbers check.

Every number in a report's prose must appear verbatim (after removing thousands
separators and a trailing % or x) as a value in one of the pack's results/*.csv files,
or be declared in the report's `params:` front-matter line (query parameters such
as window length or bucket thresholds).

With --rounding, a number may also be a result cell rounded to the number of
decimals the prose shows (half-up or half-even): 93.03 may be written 93 or 93.0,
9.8 may be written 10. Only cells with MORE decimals than the prose number are
rounded, so whole-number cells are never rounded (1,036,408 can't become 1,000,000)
and scaled forms ("1.2 million") never trace. Params always match exactly.

Skipped: fenced code blocks, inline `code`, ISO dates, the "## Reproduce" and
"## Queries" sections, and the front matter itself.

Usage: python check_numbers.py [--rounding] <report-pack-dir> [REPORT.md]
       (the optional second argument names the document, e.g. THESIS.md)
Exit 0 = every number traced; 1 = untraced numbers listed.

Library use (rs-agent bin/write-report): check_text(text, pack, rounding=True)
returns (checked, [(lineno, token, context), ...]).
"""
import csv
import re
import sys
from decimal import ROUND_HALF_EVEN, ROUND_HALF_UP, Decimal, InvalidOperation
from pathlib import Path

NUM = re.compile(r"(?<![\w.\-])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?(?:%|x)?(?![\w\-])")  # "3x" multipliers count too
ISO_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
SKIP_SECTIONS = ("## reproduce", "## queries")


def norm(s: str):
    try:
        return Decimal(s.replace(",", "").rstrip("%x")).normalize()
    except InvalidOperation:
        return None


def decimals(token: str) -> int:
    t = token.replace(",", "").rstrip("%x")
    return len(t.split(".", 1)[1]) if "." in t else 0


def raw_cells(pack: Path):
    """Every numeric cell of the pack's results, as exact Decimals (not normalized)."""
    out = []
    for f in sorted((Path(pack) / "results").glob("*.csv")):
        with f.open() as fh:
            for row in csv.reader(fh):
                for cell in row:
                    try:
                        d = Decimal(cell.strip().replace(",", ""))
                    except InvalidOperation:
                        continue
                    if d.is_finite():
                        out.append(d)
    return out


def known_values(pack: Path):
    return {d.normalize() for d in raw_cells(pack)}


def rounded_values(cells, places: int):
    """Cells with more than `places` decimals, rounded to `places` (both half-up and half-even)."""
    q = Decimal(1).scaleb(-places)
    vals = set()
    for d in cells:
        if -d.as_tuple().exponent > places:
            vals.add(d.quantize(q, rounding=ROUND_HALF_UP).normalize())
            vals.add(d.quantize(q, rounding=ROUND_HALF_EVEN).normalize())
    return vals


def prose_lines(text: str):
    in_fence = in_front = skip = False
    for i, line in enumerate(text.splitlines(), 1):
        if i == 1 and line.strip() == "---":
            in_front = True
            continue
        if in_front:
            if line.strip() == "---":
                in_front = False
            continue
        if line.startswith("```"):
            in_fence = not in_fence
            continue
        if line.startswith("## "):
            skip = line.lower().startswith(SKIP_SECTIONS)
        if in_fence or skip:
            continue
        line = re.sub(r"^\s*\d+\.\s", "", line)  # ordered-list markers
        line = re.sub(r"`[^`]*`", "", line)
        line = ISO_DATE.sub("", line)
        yield i, line


def params(text: str):
    m = re.search(r"^params:\s*\[([^\]]*)\]", text, re.MULTILINE)
    return {norm(p.strip()) for p in m.group(1).split(",") if p.strip()} if m else set()


def check_text(text: str, pack: Path, rounding: bool = False, extra_params=()):
    """(numbers checked, untraced [(lineno, token, context)]) for one document against one pack."""
    cells = raw_cells(pack)
    allowed = {d.normalize() for d in cells} | params(text) | {norm(str(p)) for p in extra_params}
    by_places = {}
    bad, checked = [], 0
    for lineno, line in prose_lines(text):
        for m in NUM.finditer(line):
            tok = m.group(0)
            v = norm(tok)
            checked += 1
            if v in allowed:
                continue
            if rounding:
                places = decimals(tok)
                if places not in by_places:
                    by_places[places] = rounded_values(cells, places)
                if v in by_places[places]:
                    continue
            bad.append((lineno, tok, line.strip()[:90]))
    return checked, bad


def main(argv) -> int:
    rounding = "--rounding" in argv
    args = [a for a in argv if a != "--rounding"]
    if not args:
        print(__doc__, file=sys.stderr)
        return 2
    pack = Path(args[0])
    doc = args[1] if len(args) > 1 else "REPORT.md"
    checked, bad = check_text((pack / doc).read_text(), pack, rounding=rounding)
    for lineno, tok, ctx in bad:
        print(f"❌ line {lineno}: {tok!r} not found in results  | {ctx}")
    print(f"{checked} numbers checked, {len(bad)} untraced{' (rounding allowed)' if rounding else ''}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

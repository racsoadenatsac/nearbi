"""No-invented-numbers check.

Every number in a report's prose must appear verbatim (after removing thousands
separators and a trailing %) as a value in one of the pack's results/*.csv files,
or be declared in the report's `params:` front-matter line (query parameters such
as window length or bucket thresholds).

Skipped: fenced code blocks, inline `code`, ISO dates, the "## Reproduce" and
"## Queries" sections, and the front matter itself.

Usage: python check_numbers.py <report-pack-dir>
Exit 0 = every number traced; 1 = untraced numbers listed.
"""
import csv
import re
import sys
from decimal import Decimal, InvalidOperation
from pathlib import Path

NUM = re.compile(r"(?<![\w.\-])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?%?(?![\w\-])")
ISO_DATE = re.compile(r"\b\d{4}-\d{2}-\d{2}\b")
SKIP_SECTIONS = ("## reproduce", "## queries")


def norm(s: str):
    try:
        return Decimal(s.replace(",", "").rstrip("%")).normalize()
    except InvalidOperation:
        return None


def known_values(pack: Path):
    vals = set()
    for f in (pack / "results").glob("*.csv"):
        with f.open() as fh:
            for row in csv.reader(fh):
                for cell in row:
                    v = norm(cell)
                    if v is not None:
                        vals.add(v)
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
    return {norm(p.strip()) for p in m.group(1).split(",")} if m else set()


def main(pack: Path) -> int:
    text = (pack / "REPORT.md").read_text()
    allowed = known_values(pack) | params(text)
    bad = []
    checked = 0
    for lineno, line in prose_lines(text):
        for m in NUM.finditer(line):
            v = norm(m.group(0))
            checked += 1
            if v not in allowed:
                bad.append((lineno, m.group(0), line.strip()[:90]))
    for lineno, tok, ctx in bad:
        print(f"❌ line {lineno}: {tok!r} not found in results  | {ctx}")
    print(f"{checked} numbers checked, {len(bad)} untraced")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1])))

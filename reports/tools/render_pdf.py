"""Render a report pack's REPORT.md (+ charts, + manifest hashes) to HTML and PDF.

Usage: python render_pdf.py <report-pack-dir> [out.pdf]
Requires: `markdown` (pip) and Google Chrome (headless print-to-pdf).
"""
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path

import markdown

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

CSS = """
@page { size: A4; margin: 16mm 15mm 18mm; }
body { font: 10.5pt/1.5 -apple-system, 'Helvetica Neue', Arial, sans-serif; color:#1b1b1b; }
h1 { font-size: 22pt; margin: 0 0 4pt; } h2 { font-size: 13.5pt; margin: 16pt 0 6pt; border-bottom: 1.5px solid #00b37a; padding-bottom: 2pt; }
em:first-child { color:#555; }
code { font: 9pt Menlo, monospace; background:#f2f2ee; padding: 0 2px; border-radius: 3px; }
pre { background:#f2f2ee; padding: 8px 10px; border-radius: 5px; } pre code { background:none; }
table { border-collapse: collapse; width: 100%; font-size: 9.5pt; } td, th { border: 1px solid #ddd; padding: 4px 6px; vertical-align: top; }
img { width: 100%; } li { margin-bottom: 4pt; }
.brand { color:#00b37a; font-weight:700; letter-spacing:.06em; font-size:9pt; }
.hash td { font: 8pt Menlo, monospace; word-break: break-all; }
h2, table, img { break-inside: avoid; } h2 { break-after: avoid; }
"""


def main(pack: Path, out: Path):
    text = (pack / "REPORT.md").read_text()
    text = re.sub(r"\A---\n.*?\n---\n", "", text, flags=re.S)  # drop front matter
    body = markdown.markdown(text, extensions=["tables", "fenced_code"])
    manifest = json.loads((pack / "manifest.json").read_text())
    rows = "".join(
        f"<tr><td>{n}</td><td>{q['rows']}</td><td>{q['result_sha256']}</td></tr>"
        for n, q in sorted(manifest["queries"].items())
    )
    appendix = (
        "<h2>Appendix: result fingerprints (SHA-256)</h2>"
        f"<p>Generated {manifest['generated_at']} from <code>{manifest['dataset']}</code>. "
        "<code>make verify</code> re-runs each query and must reproduce these exactly.</p>"
        f"<table class='hash'><tr><th>query</th><th>rows</th><th>result sha256</th></tr>{rows}</table>"
    )
    html = (
        f"<!doctype html><html><head><meta charset='utf-8'><style>{CSS}</style></head><body>"
        f"<div class='brand'>RESEARCH SHOP · BUILT AT NEAR HACKATHON</div>{body}{appendix}</body></html>"
    )
    html_path = pack / "REPORT.html"
    html_path.write_text(html)
    with tempfile.TemporaryDirectory() as profile:
        subprocess.run(
            [CHROME, "--headless=new", "--disable-gpu", f"--user-data-dir={profile}",
             "--no-pdf-header-footer", "--allow-file-access-from-files",
             f"--print-to-pdf={out}", html_path.resolve().as_uri()],
            check=True, capture_output=True, timeout=120,
        )
    print(f"wrote {out}")


if __name__ == "__main__":
    pack = Path(sys.argv[1])
    main(pack, Path(sys.argv[2]) if len(sys.argv) > 2 else pack / "REPORT.pdf")

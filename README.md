# rs-reports

Report templates and published reports, each with its query pack and result hashes.

Part of the NEAR Hackathon one-agent research shop. See `rs-docs/ARCHITECTURE.md`.

## Tools

- `tools/check_numbers.py [--rounding] <pack> [REPORT.md]` is the no-invented-numbers check. Every prose number must be a
  result cell or a declared `params:` value. `--rounding` also accepts a decimal cell rounded to the decimals shown
  (93.03 → 93), but never rounds whole numbers. `Nx` multipliers are checked too. rs-agent's `bin/write-report` uses
  `check_text(text, pack, rounding=True)` as its post-check. Tests: `python3 -m unittest discover -s tests`.
- `tools/render_pdf.py` renders REPORT.md to HTML/PDF.

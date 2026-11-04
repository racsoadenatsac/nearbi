"""report.md (bin/write-report output) -> one self-contained, escaped HTML page for the customer.

Stdlib only. Supports exactly what write-report emits: YAML front matter (dropped), # / ## headings, paragraphs,
*italic*, **bold**, `code`, numbered and bulleted lists, and pipe tables. Every piece of text is HTML-escaped
before inline markup is applied, so nothing in a report (or in the customer's own question, shown above it) can
inject markup or script. No external assets: the app serves this file from the private bucket as-is.
"""
from __future__ import annotations

import html
import re
from typing import Optional

CSS = """
body{font:16px/1.55 -apple-system,'Helvetica Neue',Arial,sans-serif;color:#1b1b1b;max-width:760px;margin:32px auto;padding:0 18px}
h1{font-size:28px;line-height:1.25;margin:8px 0 6px}h2{font-size:19px;margin:28px 0 8px;border-bottom:2px solid #00b37a;padding-bottom:3px}
code{font:13px Menlo,monospace;background:#f2f2ee;padding:0 3px;border-radius:3px;word-break:break-all}
table{border-collapse:collapse;width:100%;font-size:13px;margin:8px 0}td,th{border:1px solid #ddd;padding:4px 6px;vertical-align:top;text-align:left}
li{margin-bottom:6px}.brand{color:#00b37a;font-weight:700;letter-spacing:.06em;font-size:12px}
.ask{background:#f6f6f2;border-left:4px solid #00b37a;padding:10px 14px;margin:18px 0;white-space:pre-wrap}
.note{color:#555;font-size:14px}.files li{margin-bottom:2px}
"""

_FM = re.compile(r"\A---\n.*?\n---\n", re.S)


def inline(text: str) -> str:
    """Escape, then apply `code`, **bold**, *italic* (code spans are protected from the other two)."""
    out, parts = [], re.split(r"(`[^`]*`)", text)
    for p in parts:
        if len(p) >= 2 and p.startswith("`") and p.endswith("`"):
            out.append(f"<code>{html.escape(p[1:-1])}</code>")
            continue
        e = html.escape(p)
        e = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", e)
        e = re.sub(r"(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?![*\w])", r"<em>\1</em>", e)
        out.append(e)
    return "".join(out)


def _table(rows: list[str]) -> str:
    cells = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows]
    head, body = cells[0], [r for r in cells[1:] if not all(re.fullmatch(r":?-{3,}:?", c) for c in r)]
    th = "".join(f"<th>{inline(c)}</th>" for c in head)
    trs = "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body)
    return f"<table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>"


def markdown_to_html(md: str) -> str:
    lines = _FM.sub("", md).splitlines()
    out: list[str] = []
    para: list[str] = []
    i = 0

    def flush() -> None:
        if para:
            out.append(f"<p>{inline(' '.join(para))}</p>")
            para.clear()

    while i < len(lines):
        line = lines[i]
        s = line.strip()
        if not s:
            flush()
            i += 1
            continue
        m = re.match(r"^(#{1,3})\s+(.*)$", s)
        if m:
            flush()
            n = len(m.group(1))
            out.append(f"<h{n}>{inline(m.group(2))}</h{n}>")
            i += 1
            continue
        if s.startswith("|"):
            flush()
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                rows.append(lines[i])
                i += 1
            out.append(_table(rows))
            continue
        lm = re.match(r"^(\d+)\.\s+(.*)$|^[-*]\s+(.*)$", s)
        if lm:
            flush()
            ordered = lm.group(1) is not None
            items = []
            while i < len(lines):
                cur = lines[i].strip()
                m2 = re.match(r"^\d+\.\s+(.*)$", cur) if ordered else re.match(r"^[-*]\s+(.*)$", cur)
                if not m2:
                    break
                items.append(m2.group(1))
                i += 1
            tag = "ol" if ordered else "ul"
            out.append(f"<{tag}>" + "".join(f"<li>{inline(t)}</li>" for t in items) + f"</{tag}>")
            continue
        para.append(s)
        i += 1
    flush()
    return "\n".join(out)


def page(report_md: str, *, title: str, customer_question: Optional[str], pack_title: str, order_id: str,
         files: list[tuple[str, str]]) -> str:
    """The customer's delivery page: their question (verbatim, escaped), what it was answered from, the report,
    and the downloadable pack files with their SHA-256."""
    ask = ""
    if customer_question:
        ask = (f"<p class='note'>Your question</p><div class='ask'>{html.escape(customer_question)}</div>"
               f"<p class='note'>Answered automatically from our cached study <strong>{html.escape(pack_title)}</strong>, "
               "the closest match in our library. The narrative below was written by the shop's agent from that study's "
               "query results; every number in it traces to a result cell listed at the end. If it doesn't answer what you "
               "asked, reply through the contact you gave us and a human will follow up.</p>")
    flist = "".join(f"<li><a href='{html.escape(rel, quote=True)}'>{html.escape(rel)}</a> <code>{h}</code></li>" for h, rel in files)
    return (f"<!doctype html><html lang='en'><head><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>"
            f"<meta name='robots' content='noindex'><title>{html.escape(title)}</title><style>{CSS}</style></head><body>"
            f"<div class='brand'>NEARBI · RESEARCH SHOP · ORDER {html.escape(order_id[:8])}</div>{ask}"
            f"{markdown_to_html(report_md)}"
            f"<h2>Files</h2><p class='note'>The report and the query pack it was written from, with SHA-256 checksums "
            f"(<a href='checksums.sha256'>checksums.sha256</a>). The agent anchors report.md's hash onchain "
            f"(<code>anchor_report</code> on <code>splitter.nearbi.near</code>, under this order's id) right after delivery.</p><ul class='files'>{flist}</ul></body></html>\n")

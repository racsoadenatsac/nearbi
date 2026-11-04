"""A strict loader for the YAML subset config.yaml uses (stdlib only; rs-agent has no dependencies).

Supported: block mappings nested by spaces, `key: scalar`, `# comments` (full-line or after a space),
scalars: integers, decimals (returned as decimal.Decimal, never float), true/false, null/~, 'single' and
"double" quoted strings, bare strings. Everything else (lists, flow {} [] collections, anchors/aliases,
tags, multi-line strings, tabs, multiple documents, duplicate keys) is a ParseError: the operator file
must mean exactly one thing.
"""
from __future__ import annotations

import re
from decimal import Decimal
from typing import Any

KEY_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(?:\s+(.*))?$")
INT_RE = re.compile(r"^[-+]?(0|[1-9][0-9_]*)$")
DEC_RE = re.compile(r"^[-+]?(0|[1-9][0-9_]*)\.[0-9]+$")


class ParseError(ValueError):
    def __init__(self, line: int, msg: str):
        super().__init__(f"line {line}: {msg}")
        self.line = line


def _strip_comment(s: str, ln: int) -> str:
    out, quote = [], None
    for i, c in enumerate(s):
        if quote:
            out.append(c)
            if c == quote:
                quote = None
            continue
        if c in "'\"" and s[:i].rstrip().endswith(":"):  # a quote only opens at the start of a value
            quote = c
        elif c == "#" and (i == 0 or s[i - 1] in " \t"):
            break
        out.append(c)
    if quote:
        raise ParseError(ln, "unterminated quoted string")
    return "".join(out).rstrip()


def _scalar(raw: str, ln: int) -> Any:
    v = raw.strip()
    if v[:1] in ("'", '"'):
        q, body = v[0], v[1:-1]
        inner = body.replace("''", "") if q == "'" else body.replace("\\\\", "").replace('\\"', "")
        if len(v) < 2 or v[-1] != q or q in inner:
            raise ParseError(ln, f"bad quoted string {v!r}")
        return body.replace("''", "'") if q == "'" else body.replace('\\"', '"').replace("\\\\", "\\")
    if v[:1] in "[{&*!|>%@`" or (v[:1] == "-" and not INT_RE.match(v) and not DEC_RE.match(v)):
        raise ParseError(ln, f"unsupported YAML construct {v!r} (only plain key: value mappings are allowed)")
    low = v.lower()
    if low in ("true", "false"):
        return low == "true"
    if low in ("yes", "no", "on", "off", "y", "n"):
        raise ParseError(ln, f"ambiguous boolean {v!r}: write true or false")
    if low in ("null", "~"):
        return None
    if INT_RE.match(v):
        return int(v.replace("_", ""))
    if DEC_RE.match(v):
        return Decimal(v.replace("_", ""))
    if re.match(r"^[-+]?(\.[0-9]+|[0-9]+e[0-9]+|\.inf|\.nan)$", low):
        raise ParseError(ln, f"unsupported number {v!r}: write e.g. 0.5 or 50")
    if ": " in v:
        raise ParseError(ln, f"unexpected ': ' in value {v!r} (quote it)")
    return v


def loads(text: str) -> dict:
    root: dict = {}
    stack: list[tuple[int, dict]] = [(0, root)]  # open mappings: (indent of their keys, dict)
    pending: tuple[int, dict, str] | None = None  # a `key:` with no value, waiting for a nested block
    for ln, line in enumerate(text.splitlines(), 1):
        if "\t" in line[: len(line) - len(line.lstrip())]:
            raise ParseError(ln, "tab in indentation; use spaces")
        body = _strip_comment(line, ln)
        if not body.strip():
            continue
        if body.strip() in ("---", "..."):
            if body.strip() == "---" and not root and pending is None:
                continue
            raise ParseError(ln, "multiple YAML documents are not allowed")
        indent = len(body) - len(body.lstrip(" "))
        content = body.strip()
        if content.startswith("- ") or content == "-":
            raise ParseError(ln, "lists are not supported in config.yaml")
        m = KEY_RE.match(content)
        if not m:
            raise ParseError(ln, f"expected 'key: value', got {content!r}")
        key, val = m.group(1), m.group(2)
        if pending is not None:
            p_indent, p_parent, p_key = pending
            pending = None
            if indent > p_indent:
                child: dict = {}
                p_parent[p_key] = child
                stack.append((indent, child))
        while len(stack) > 1 and indent < stack[-1][0]:
            stack.pop()
        if indent != stack[-1][0]:
            raise ParseError(ln, f"indentation of {indent} spaces does not match any open block")
        parent = stack[-1][1]
        if key in parent:
            raise ParseError(ln, f"duplicate key {key!r}")
        if val is None or val == "":
            parent[key] = None
            pending = (indent, parent, key)
        else:
            parent[key] = _scalar(val, ln)
    return root

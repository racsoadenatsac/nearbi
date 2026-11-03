#!/usr/bin/env python3
"""List the host-function imports of a NEAR contract WASM (no dependencies).

    bin/wasm-imports.py res/nearbi_splitter.wasm            # print "module.name" per import
    bin/wasm-imports.py --deny res/near-imports-p88.txt res/*.wasm   # exit 1 if any listed import is used

The deny list holds host functions that mainnet does not provide yet (one name per
line, '#' comments). See README "Protocol compatibility".
"""
import sys


def leb(b, i):
    r = s = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 0x7F) << s
        s += 7
        if x < 0x80:
            return r, i


def imports(path):
    b = open(path, "rb").read()
    if b[:4] != b"\0asm":
        raise SystemExit(f"{path}: not a wasm module")
    i, out = 8, []
    while i < len(b):
        sid = b[i]
        size, i = leb(b, i + 1)
        end = i + size
        if sid == 2:
            n, i = leb(b, i)
            for _ in range(n):
                ml, i = leb(b, i); mod = b[i:i + ml].decode(); i += ml
                nl, i = leb(b, i); name = b[i:i + nl].decode(); i += nl
                kind = b[i]; i += 1
                if kind == 0:
                    _, i = leb(b, i)
                elif kind == 1:
                    i += 1; fl, i = leb(b, i); _, i = leb(b, i)
                    if fl & 1: _, i = leb(b, i)
                elif kind == 2:
                    fl, i = leb(b, i); _, i = leb(b, i)
                    if fl & 1: _, i = leb(b, i)
                elif kind == 3:
                    i += 2
                out.append((mod, name, kind))
        i = end
    return out


def main(argv):
    deny = None
    if argv[:1] == ["--deny"]:
        deny = {l.split("#")[0].strip() for l in open(argv[1]) if l.split("#")[0].strip()}
        argv = argv[2:]
    bad = 0
    for p in argv:
        imps = imports(p)
        print(f"== {p}: {len(imps)} imports")
        for mod, name, kind in imps:
            flag = ""
            if deny is not None and name in deny:
                flag, bad = "   <-- NOT on mainnet protocol 86", bad + 1
            if deny is None or flag:
                print(f"   {mod}.{name}{flag}")
    if deny is not None:
        print("unsupported imports:", bad)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

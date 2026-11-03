#!/usr/bin/env bash
# Pre-push secret scan. Run before every push (also usable as .git/hooks/pre-push).
# Scans the working tree AND every blob in the full git history (all refs) for:
#   * NEAR ed25519 private keys / keypairs (ed25519:<~88 base58 chars>; public keys are ~44)
#   * private_key / secret_key / seed phrase fields
#   * AWS access keys / secret keys and the CloudFront x-origin-verify value
#   * 12/15/18/21/24-word runs where every word is in the BIP-39 English list
# Exits 1 on any hit. Usage: bin/check-secrets.sh [repo-dir]  (default: this repo)
set -euo pipefail
SELF="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "${1:-$SELF}" && pwd)"   # optional: scan another repo
cd "$ROOT"
WL="$SELF/.tools/bip39-english.txt"
WL_SHA=2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda
if [ ! -f "$WL" ]; then
  mkdir -p "$SELF/.tools"
  curl -fsSL -o "$WL.tmp" https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt \
    && echo "$WL_SHA  $WL.tmp" | shasum -a 256 -c - >/dev/null && mv "$WL.tmp" "$WL" \
    || { rm -f "$WL.tmp"; echo "warning: BIP-39 wordlist unavailable; seed-phrase word check skipped" >&2; }
fi

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
# working tree (tracked + untracked, not ignored)
git ls-files -co --exclude-standard -z | xargs -0 -I{} sh -c '[ -f "{}" ] && printf "== worktree:%s\n" "{}" && cat "{}"' > "$TMP/all.txt" 2>/dev/null || true
# every blob reachable from any ref
git rev-list --objects --all | while read -r obj path; do
  [ "$(git cat-file -t "$obj")" = blob ] || continue
  printf '== %s:%s\n' "$obj" "${path:-?}"; git cat-file -p "$obj"
done >> "$TMP/all.txt"

python3 - "$TMP/all.txt" "$WL" <<'PY'
import re, sys, os
data = open(sys.argv[1], "rb").read().decode("utf-8", "replace")
words = set(open(sys.argv[2]).read().split()) if os.path.exists(sys.argv[2]) else None
hits, where = [], "?"
pk = re.compile(r"ed25519:[1-9A-HJ-NP-Za-km-z]{70,}")
field = re.compile(r"(private_key|secret_key|master_seed_phrase|seed_phrase)[\"']?\s*[:=]\s*[\"'][^\"'\s]{20,}", re.I)
aws = re.compile(r"\b(AKIA|ASIA)[0-9A-Z]{16}\b|aws_secret_access_key\s*[:=]\s*\S{20,}|x-origin-verify[\"']?\s*[:=]\s*[\"'][^\"'\s]{16,}", re.I)
for line in data.splitlines():
    if line.startswith("== "):
        where = line[3:]; continue
    if pk.search(line): hits.append((where, "ed25519 private key", pk.search(line).group(0)[:16] + "…"))
    if aws.search(line): hits.append((where, "AWS credential / origin secret", aws.search(line).group(0)[:12] + "…"))
    if field.search(line): hits.append((where, "secret field", field.search(line).group(1)))
    if words:
        toks = re.findall(r"[a-z]+", line)
        run = 0
        for t in toks:
            run = run + 1 if t in words else 0
            if run >= 12:
                hits.append((where, "possible BIP-39 seed phrase", " ".join(toks[:3]) + " …")); break
for h in hits: print("SECRET? %s: %s (%s)" % h)
print(f"scanned {len(data)//1024} KiB: {'FAIL' if hits else 'clean'} ({len(hits)} hits)")
sys.exit(1 if hits else 0)
PY

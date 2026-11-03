#!/usr/bin/env bash
# Download near-cli-rs as a single pinned, checksum-verified binary into
# .tools/bin/near (gitignored). No global install.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION=0.30.1
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  T=aarch64-apple-darwin;      SUM=46015e2fe2fddb49116ee4d256c70f6cf96123cff0cb9fd5683b2623228acebb ;;
  *) echo "add the sha256 for $(uname -s)-$(uname -m) from the v$VERSION release's sha256.sum" >&2; exit 1 ;;
esac
F="near-cli-rs-$T.tar.gz"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$F" "https://github.com/near/near-cli-rs/releases/download/v$VERSION/$F"
echo "$SUM  $TMP/$F" | shasum -a 256 -c -
tar -xzf "$TMP/$F" -C "$TMP"
mkdir -p "$ROOT/.tools/bin"
install -m 0755 "$TMP/near-cli-rs-$T/near" "$ROOT/.tools/bin/near"
"$ROOT/.tools/bin/near" --version

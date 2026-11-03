#!/usr/bin/env bash
# Reproducible release build of both contracts.
#
# Exports the committed HEAD (uncommitted changes are NOT included), then runs
# the `container_build_command` from each crate's
# [package.metadata.near.reproducible_build] inside the exact image pinned there
# by digest (sourcescan/cargo-near, linux/amd64). This is the same thing
# `cargo near build reproducible-wasm` does, minus the need for cargo-near on
# the host. Output: res/<crate>.wasm + res/<crate>.wasm.sha256
#
#   bin/build.sh            # both contracts
#   bin/build.sh splitter   # one
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IMAGE_TAG="sourcescan/cargo-near:0.22.0-rust-1.97.1"
IMAGE_DIGEST="sha256:7467038bdddc86484b73b416eeadce926ff59013e128e53dec5a19e1cb4b2234"
IMAGE="${IMAGE_TAG%%:*}@${IMAGE_DIGEST}"

# keep the pin in one place: refuse to run if Cargo.toml metadata drifted
for c in contracts/splitter contracts/mock-ft; do
  grep -q "image_digest = \"$IMAGE_DIGEST\"" "$c/Cargo.toml" \
    || { echo "image digest in $c/Cargo.toml != $IMAGE_DIGEST" >&2; exit 1; }
done

if [ -n "$(git status --porcelain -- contracts Cargo.toml Cargo.lock)" ]; then
  echo "warning: uncommitted changes under contracts/ are ignored; building HEAD $(git rev-parse --short HEAD)" >&2
fi

TARGETS=("${@:-splitter mock-ft}")
# shellcheck disable=SC2206
TARGETS=(${TARGETS[*]})

SRC="$ROOT/target-repro/src"
rm -rf "$ROOT/target-repro"
mkdir -p "$SRC" res
git archive --format=tar HEAD | tar -x -C "$SRC"
chmod -R a+rwX "$ROOT/target-repro"
COMMIT="$(git rev-parse HEAD)"

for t in "${TARGETS[@]}"; do
  case "$t" in
    splitter) crate=nearbi_splitter ;;
    mock-ft)  crate=usdc_mock ;;
    *) echo "unknown target $t" >&2; exit 1 ;;
  esac
  echo "==> building contracts/$t at $COMMIT in $IMAGE"
  docker run --rm --platform linux/amd64 \
    -v "$SRC":/home/near/code \
    -w "/home/near/code/contracts/$t" \
    "$IMAGE" \
    cargo near build non-reproducible-wasm --locked
  wasm="$(find "$SRC/target/near" -name "$crate.wasm" | head -1)"
  [ -f "$wasm" ] || { echo "no wasm produced for $crate" >&2; exit 1; }
  cp "$wasm" "res/$crate.wasm"
  (cd res && shasum -a 256 "$crate.wasm" > "$crate.wasm.sha256")
  echo "    res/$crate.wasm  $(wc -c < "res/$crate.wasm") bytes  sha256 $(cut -d' ' -f1 "res/$crate.wasm.sha256")"
done
echo "$COMMIT" > res/BUILD_COMMIT

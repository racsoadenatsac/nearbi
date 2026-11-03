#!/usr/bin/env bash
# Run a command inside the rs-payments dev toolchain container (Rust is never
# installed on the host). Cargo registry + target dir are cached in named volumes.
#   bin/dev.sh cargo test -p nearbi-splitter
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${RS_DEV_IMAGE:-rs-payments-dev:0.1}"
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -f "$ROOT/docker/dev.Dockerfile" -t "$IMAGE" "$ROOT/docker"
fi
TTY=(); [ -t 0 ] && TTY=(-t)
exec docker run --rm -i ${TTY[@]+"${TTY[@]}"} \
  -v "$ROOT":/work -w /work \
  -v rs-payments-cargo-registry:/usr/local/cargo/registry \
  -v rs-payments-target:/work/target \
  -v rs-payments-sandbox:/root/.near \
  -e CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-2}" \
  -e CARGO_TERM_COLOR=never \
  "$IMAGE" "$@"

# Dev/test toolchain for rs-payments. All Rust tooling runs in here; nothing is
# installed on the host.
#
#   docker build -f docker/dev.Dockerfile -t rs-payments-dev:0.1 docker/
#
# Release WASM is NOT built with this image: bin/build.sh uses the pinned
# sourcescan/cargo-near image (see contracts/*/Cargo.toml reproducible_build).
FROM rust:1.97.1-trixie@sha256:b1b3c9c0d921d7fa0a6d1f9ec7e4eab87f8c8ec97644c3d791450f131dec813f

ARG CARGO_NEAR_VERSION=0.22.0
ARG CARGO_NEAR_SHA256_AMD64=9429064e30a427e96523f539cb255f3688d2345e5000d7d4e4873a8247247d1a
ARG CARGO_NEAR_SHA256_ARM64=cf7987c98985c42968d04238324f1b4890c988dbe3509b68be58fae07a96c688
ARG TARGETARCH

RUN apt-get update \
 && apt-get install -y --no-install-recommends clang libclang-dev pkg-config libssl-dev \
 && rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32-unknown-unknown && rustup component add rust-src rustfmt clippy

RUN set -eu; \
    case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) triple=x86_64-unknown-linux-gnu; sum=$CARGO_NEAR_SHA256_AMD64 ;; \
      arm64) triple=aarch64-unknown-linux-gnu; sum=$CARGO_NEAR_SHA256_ARM64 ;; \
      *) echo "unsupported arch"; exit 1 ;; \
    esac; \
    f=cargo-near-$triple.tar.gz; \
    curl -fsSL -o /tmp/$f https://github.com/near/cargo-near/releases/download/cargo-near-v$CARGO_NEAR_VERSION/$f; \
    echo "$sum  /tmp/$f" | sha256sum -c -; \
    tar -xzf /tmp/$f -C /tmp; \
    install -m 0755 "$(find /tmp -type f -name cargo-near | head -1)" /usr/local/cargo/bin/cargo-near; \
    rm -rf /tmp/cargo-near*; \
    cargo near --version

WORKDIR /work

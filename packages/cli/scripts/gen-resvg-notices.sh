#!/bin/sh
# Regenerates packages/cli/scripts/licenses/resvg-wasm-rust-crates.md: the notices for every Rust crate
# statically linked into @resvg/resvg-wasm (the wasm binary the plugin bundle embeds).
#
# Dev-time only (needs network); run inside a Rust container, never on the host:
#   docker run --rm -v "$PWD":/repo -w /repo rust:1-bookworm sh packages/cli/scripts/gen-resvg-notices.sh
#
# resvg-js does not publish a Cargo.lock, so the dependency set is resolved from the published
# resvg-js v2.6.2 Cargo.toml (including its [patch] forks) for target wasm32-unknown-unknown, normal
# dependencies only. The resolved lock is stored next to the output for provenance.
set -eu
TAG=v2.6.2
OUT=/repo/packages/cli/scripts/licenses
W=/tmp/resvg-notices
rm -rf "$W" && mkdir -p "$W/src" && cd "$W"
curl -fsSL "https://raw.githubusercontent.com/yisibl/resvg-js/$TAG/Cargo.toml" -o Cargo.toml
: > src/lib.rs
rustup target add wasm32-unknown-unknown >/dev/null 2>&1 || true
cargo generate-lockfile
cargo tree --target wasm32-unknown-unknown -e normal --prefix none --no-dedupe \
  --format '{p}|{l}|{r}' | sort -u > crates.txt
cargo vendor --locked vendor >/dev/null 2>&1 || cargo vendor vendor >/dev/null
cp Cargo.lock "$OUT/resvg-wasm-Cargo.lock"
python3 /repo/packages/cli/scripts/gen-resvg-notices.py "$W" "$OUT/resvg-wasm-rust-crates.md" "$TAG"

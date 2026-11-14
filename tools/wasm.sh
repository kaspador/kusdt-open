#!/usr/bin/env bash
# Builds the kUSDT WebAssembly module (bridge/kaspa/wasm) into the npm
# package bridge/packages/core: pkg-web/ for browsers and bundlers,
# pkg-node/ for Node. Runs in the kusdt-rust-wasm image, which it first builds
# from tools/docker/rust-wasm.Dockerfile (in moments, from the cache, when
# nothing changed), and runs by the ID that build gives: never by a tag, which
# another build or a pull could have moved (run 21, Daybreak [6]).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
export MSYS_NO_PATHCONV=1

image="$(docker build -q -t kusdt-rust-wasm:1 -f "$root/tools/docker/rust-wasm.Dockerfile" "$root/tools/docker" | tail -n 1)"

exec docker run --rm \
  -v "$root:/kusdt" \
  -v kusdt-cargo-registry:/usr/local/cargo/registry \
  -v kusdt-cargo-git:/usr/local/cargo/git \
  -v kusdt-target:/target \
  -e CARGO_TARGET_DIR=/target \
  -e CARGO_TERM_COLOR=never \
  -e RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
  -e CC_wasm32_unknown_unknown=clang \
  -e AR_wasm32_unknown_unknown=llvm-ar \
  -w /kusdt/bridge/kaspa \
  "$image" sh -c '
    set -e
    command -v llvm-ar >/dev/null || ln -sf "$(ls /usr/bin/llvm-ar-* | head -1)" /usr/local/bin/llvm-ar
    cargo build --release --target wasm32-unknown-unknown -p kusdt-wasm
    wasm=/target/wasm32-unknown-unknown/release/kusdt_wasm.wasm
    wasm-bindgen --target web --out-dir /kusdt/bridge/packages/core/pkg-web "$wasm"
    wasm-bindgen --target nodejs --out-dir /kusdt/bridge/packages/core/pkg-node "$wasm"
    echo "{ \"type\": \"commonjs\" }" > /kusdt/bridge/packages/core/pkg-node/package.json
    ls -la /kusdt/bridge/packages/core/pkg-web
  '

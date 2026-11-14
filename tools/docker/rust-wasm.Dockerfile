# The pinned Rust toolchain plus what the WebAssembly build needs: clang for
# secp256k1's C code, the wasm32 target and the matching wasm-bindgen CLI.
# The base by its digest (the image tools/rust.sh runs) and each package at the
# version this core was built with (run 21, Daybreak [6]): a tag, and whatever
# version apt serves that day, let a registry or a mirror change what compiles
# the core. A version Debian no longer serves stops the build: pin its successor
# on purpose, and rebuild and compare (tools/check-artifacts.mjs). snapshot.debian.org
# keeps the old ones, for rebuilding an older release with its own pins.
FROM docker.io/library/rust:1.94.1@sha256:652612f07bfbbdfa3af34761c1e435094c00dde4a98036132fca28c7bb2b165c
RUN apt-get update && apt-get install -y --no-install-recommends \
      clang=1:19.0-63 clang-19=1:19.1.7-3+b1 lld=1:19.0-63 lld-19=1:19.1.7-3+b1 llvm=1:19.0-63 llvm-19=1:19.1.7-3+b1 \
 && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown
RUN cargo install wasm-bindgen-cli --version 0.2.100 --locked

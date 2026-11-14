#!/usr/bin/env bash
# Runs a command with the pinned Rust toolchain inside a container.
#
# Only this repository is mounted (at /kusdt), so code pulled from crates.io
# and git never sees the rest of the machine. Cargo caches and build output
# live in named Docker volumes, which keeps rebuilds fast.
#
#   tools/rust.sh <dir inside the repo> <command...>
#   tools/rust.sh bridge/kaspa cargo test --locked
#
# A test run leaves the tree as it was. The one tracked file a test can write, the follower's
# corpus (bridge/packages/protocol/src/rev-minter-corpus.json), is rewritten only when asked:
#   KUSDT_WRITE_CORPUS=1 tools/rust.sh bridge/kaspa cargo test --locked --test rev_minter_diff
#
# The image is named in full and by its digest, not by its tag alone: a tag is whatever the
# registry (or whoever controls it) points it at today, and this image compiles the covenant
# bytecode that controls minting (run 21, Daybreak [6]). The digest is the tag's multi-platform
# index, which names the linux/amd64 and the linux/arm64 builds among others: each machine runs
# its own build of the same pin. tools/docker/rust-wasm.Dockerfile starts from the same image,
# and tools/check-artifacts.mjs checks both. A new toolchain is pinned in both by its index's
# digest, the one the registry serves for the tag and a pull records first:
#   docker pull docker.io/library/rust:<tag>
#   docker image inspect docker.io/library/rust:<tag> --format '{{index .RepoDigests 0}}'
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && (pwd -W 2>/dev/null || pwd))"
dir="${1:?usage: tools/rust.sh <dir> <command...>}"
shift

# Git Bash would otherwise rewrite the container paths below into Windows paths.
export MSYS_NO_PATHCONV=1

exec docker run --rm \
  -v "$root:/kusdt" \
  -v kusdt-cargo-registry:/usr/local/cargo/registry \
  -v kusdt-cargo-git:/usr/local/cargo/git \
  -v kusdt-target:/target \
  -e CARGO_TARGET_DIR=/target \
  -e CARGO_TERM_COLOR=never \
  -e KUSDT_WRITE_CORPUS \
  -w "/kusdt/$dir" \
  docker.io/library/rust:1.94.1@sha256:652612f07bfbbdfa3af34761c1e435094c00dde4a98036132fca28c7bb2b165c "$@"

#!/usr/bin/env bash
# Fetches the third-party sources this repository builds against, at the
# commits it was built and tested with.
set -euo pipefail
cd "$(dirname "$0")/../vendor"

fetch() { # name url commit
  if [ ! -d "$1/.git" ]; then git clone -q "$2" "$1"; fi
  git -C "$1" fetch -q origin
  git -C "$1" checkout -q "$3"
  echo "$1 @ $(git -C "$1" rev-parse --short HEAD)"
}

# The KCC-20 reference that kUSDT imports is checked in (vendor/kcc20-reference, and see
# tools/check-artifacts.mjs). The compiler below is the commit bridge/kaspa/Cargo.toml builds with.
# Specifications (read, not built).
fetch kccs https://github.com/kaspanet/kccs.git 1ed87aef59faff8354061aee30f734a3b8b2c3d2
fetch kips https://github.com/kaspanet/kips.git master
fetch silverscript https://github.com/kaspanet/silverscript.git 443d519e6688fa03d24c69432763b13e6abe4486
fetch argent https://github.com/argent-lang/argent.git 9a9f4b107116d0b259fae629f200fa3b663e7e9d

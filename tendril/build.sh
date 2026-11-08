#!/usr/bin/env bash
# Builds Tendril: first the front end (esbuild bundles + gzip into web/dist),
# then the Rust binary that embeds it. This script only builds; running
# Tendril needs nothing but the resulting binary.
#
#   ./build.sh          native release binary  -> target/release/tendril
#   ./build.sh dist     portable binaries      -> dist/
#                         tendril-<version>-linux-x86_64        static (musl)
#                         tendril-<version>-linux-aarch64       static (musl), Raspberry Pi
#                         tendril-<version>-windows-x86_64.exe  static CRT (MinGW via zig)
#   ./build.sh web      front end only
#
# Requirements: Node.js 18+ with npm, and Rust (rustup). `dist` also needs,
# all per-user (no root):
#   zig 0.13+           e.g. `pip install --user ziglang` or https://ziglang.org
#   cargo-zigbuild      `cargo install --locked cargo-zigbuild`
#   rustup targets      `rustup target add x86_64-unknown-linux-musl \
#                          aarch64-unknown-linux-musl x86_64-pc-windows-gnu`
# On Windows use build.ps1 instead (MSVC toolchain).
set -euo pipefail
cd "$(dirname "$0")"
version="$(cat version.txt)"
mode="${1:-native}"

build_web() {
  if ! command -v node >/dev/null; then
    if [ -f web/dist/index.html.gz ]; then
      echo "==> Node.js not found: using the existing web/dist"
      return
    fi
    echo "Node.js is required to build the front end (https://nodejs.org)." >&2
    exit 1
  fi
  echo "==> Front end"
  if [ ! -d web/node_modules ]; then
    npm --prefix web ci --no-audit --no-fund
  fi
  node web/build.mjs
}

build_web
case "$mode" in
  web)
    ;;
  native)
    echo "==> Rust (native release)"
    cargo build --release
    ls -l target/release/tendril
    ;;
  dist)
    for tool in cargo-zigbuild zig; do
      command -v "$tool" >/dev/null || { echo "missing: $tool (see the comment at the top of build.sh)" >&2; exit 1; }
    done
    mkdir -p dist
    for target in x86_64-unknown-linux-musl aarch64-unknown-linux-musl x86_64-pc-windows-gnu; do
      echo "==> Rust ($target)"
      cargo zigbuild --release --target "$target"
    done
    cp target/x86_64-unknown-linux-musl/release/tendril "dist/tendril-${version}-linux-x86_64"
    cp target/aarch64-unknown-linux-musl/release/tendril "dist/tendril-${version}-linux-aarch64"
    cp target/x86_64-pc-windows-gnu/release/tendril.exe "dist/tendril-${version}-windows-x86_64.exe"
    echo "==> Done"
    ls -l dist
    ;;
  *)
    echo "usage: ./build.sh [native|dist|web]" >&2
    exit 2
    ;;
esac

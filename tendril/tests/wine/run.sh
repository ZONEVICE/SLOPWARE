#!/usr/bin/env bash
# Runs the Windows build of Tendril under Wine, for testing Windows code paths
# (drive letters, ConPTY, paths) from Linux. Real Windows 10/11 needs none of
# this: there the .exe runs as is.
#
#   tests/wine/run.sh [path/to/tendril.exe] [tendril arguments...]
#
# Defaults to the newest dist/tendril-*-windows-x86_64.exe, falling back to
# target/x86_64-pc-windows-gnu/release/tendril.exe, and to the arguments
# `http --password wine --port 6070`. Needs zig (for the shim DLL, see
# processprng.c) and a Wine of version 7 or newer: Wine 6.0 lacks the
# \Device\Afd driver that tokio's I/O layer (mio) opens on Windows, so the
# server stops at once with "Failed to open \Device\Afd\Mio". Point WINE at
# another build if the system one is too old, e.g. a Lutris runner:
#   WINE=~/.local/share/lutris/runners/wine/wine-ge-8-26-x86_64/bin/wine tests/wine/run.sh
# The Wine prefix defaults to ~/.cache/tendril-wine (override with
# WINEPREFIX), so personal prefixes are never touched. The shim is built into
# a temporary folder next to a copy of the .exe: nothing is written into
# dist/ or target/.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"

exe="${1:-}"
if [ -n "$exe" ] && [ -f "$exe" ]; then
  shift
else
  exe="$(ls -t "$root"/dist/tendril-*-windows-x86_64.exe 2>/dev/null | head -1 || true)"
  [ -n "$exe" ] || exe="$root/target/x86_64-pc-windows-gnu/release/tendril.exe"
fi
[ -f "$exe" ] || { echo "no Windows build found; run ./build.sh dist first" >&2; exit 1; }
wine="${WINE:-wine}"
for tool in "$wine" zig; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
export WINEPREFIX="${WINEPREFIX:-$HOME/.cache/tendril-wine}"
mkdir -p "$WINEPREFIX"
version="$("$wine" --version 2>/dev/null || true)"
case "$version" in
  wine-6.0*|wine-5.*|wine-4.*) echo "warning: $version cannot run tokio programs (no \\Device\\Afd); set WINE to Wine 7+" >&2 ;;
esac

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cp "$exe" "$work/tendril.exe"
zig cc -shared -target x86_64-windows-gnu -o "$work/bcryptprimitives.dll" "$here/processprng.c" -ladvapi32

if [ "$#" -eq 0 ]; then
  set -- http --password wine --port 6070
fi
echo "==> $version: $(basename "$exe") $*"
cd "$work"
# Prefer the shim over any built-in bcryptprimitives.dll of Wine.
WINEDLLOVERRIDES="bcryptprimitives=n,b" WINEDEBUG=-all "$wine" ./tendril.exe "$@"

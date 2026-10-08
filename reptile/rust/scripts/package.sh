#!/usr/bin/env bash
# Build the release artifacts into dist/:
#
#   reptile-<version>-linux-x86_64           one binary, glibc 2.28+ (Debian 10 and newer)
#   reptile_<version>-1_amd64.deb            installs /usr/bin/reptile
#   reptile-<version>-windows-x86_64.zip     reptile.exe (Windows 10/11) + README + licence
#
# Cross-compilation goes through zig (cargo-zigbuild): it links against an
# older glibc than the build machine's, and against the MinGW runtime for
# Windows, with nothing installed system-wide. Requirements, all per-user:
#
#   rustup target add x86_64-unknown-linux-gnu x86_64-pc-windows-gnu
#   cargo install --locked cargo-zigbuild cargo-deb
#   zig 0.13 or newer on PATH (https://ziglang.org/download/)
#
# The Debian package also needs dpkg-dev (dpkg-shlibdeps), present on any
# Debian-family system.
set -euo pipefail
cd "$(dirname "$0")/.."

version="$(cat ../version.txt)"
dist="dist"
linux_target="x86_64-unknown-linux-gnu"
windows_target="x86_64-pc-windows-gnu"

for tool in cargo cargo-zigbuild cargo-deb zig; do
  command -v "$tool" >/dev/null || { echo "missing: $tool (see the comment at the top of this script)" >&2; exit 1; }
done

mkdir -p "$dist"

echo "==> Linux x86_64 (glibc 2.28+)"
cargo zigbuild --release --target "${linux_target}.2.28"
cp "target/${linux_target}/release/reptile" "$dist/reptile-${version}-linux-x86_64"

echo "==> Debian package"
cargo deb --no-build --no-strip --target "$linux_target" --output "$dist/"

echo "==> Windows x86_64"
cargo zigbuild --release --target "$windows_target"
staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT
folder="$staging/reptile-${version}-windows-x86_64"
mkdir -p "$folder"
cp "target/${windows_target}/release/reptile.exe" README.md ../LICENCE.txt "$folder/"
(cd "$staging" && rm -f "$OLDPWD/$dist/reptile-${version}-windows-x86_64.zip" && zip -qr "$OLDPWD/$dist/reptile-${version}-windows-x86_64.zip" "reptile-${version}-windows-x86_64")

echo "==> Done"
ls -l "$dist"

#!/usr/bin/env bash
# Render the Homebrew cask and formula for a release (#168) from the
# templates in packaging/homebrew/ and the release's SHA256SUMS.
#
# Usage: scripts/release/homebrew.sh <SHA256SUMS> <tag> <out-dir>
#   e.g. scripts/release/homebrew.sh assets/SHA256SUMS v0.1.0 tap
#
# Writes <out-dir>/Casks/nauvi.rb and <out-dir>/Formula/nauvi-cli.rb, the
# layout of the nexburst/homebrew-tap repository. Fails if SHA256SUMS lacks
# one of the assets they point to (names as in .github/workflows/release.yml)
# or a sum is not 64 hex digits.
set -euo pipefail

usage() { echo "usage: $0 <SHA256SUMS> <tag> <out-dir>   (e.g. assets/SHA256SUMS v0.1.0 tap)" >&2; exit 2; }
[ $# -eq 3 ] || usage
sums="$1" tag="$2" out="$3"
version="${tag#v}"

[ -f "$sums" ] || { echo "error: no such file: $sums" >&2; exit 1; }
if ! [[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?$ ]]; then
  echo "error: '$tag' is not a release tag (vMAJOR.MINOR.PATCH[-N])" >&2
  exit 1
fi

templates="$(cd "$(dirname "$0")/../../packaging/homebrew" && pwd)"

# The SHA-256 of one asset. sha256sum writes "<sum>  <name>" (or "<sum> *<name>"
# in binary mode).
sum_of() {
  local name="$1" sum
  sum=$(awk -v n="$name" '{ f = $2; sub(/^\*/, "", f) } f == n { print $1; exit }' "$sums")
  if [ -z "$sum" ]; then
    echo "error: $sums has no entry for $name" >&2
    return 1
  fi
  if ! [[ "$sum" =~ ^[0-9a-f]{64}$ ]]; then
    echo "error: the sum of $name in $sums is not a SHA-256: $sum" >&2
    return 1
  fi
  echo "$sum"
}

dmg=$(sum_of "nauvi_${version}_universal.dmg")
cli_arm=$(sum_of "nauvi-cli-${tag}-aarch64-apple-darwin.tar.gz")
cli_intel=$(sum_of "nauvi-cli-${tag}-x86_64-apple-darwin.tar.gz")
cli_linux=$(sum_of "nauvi-cli-${tag}-x86_64-unknown-linux-gnu.tar.gz")

render() {
  local template="$1" dest="$2"
  mkdir -p "$(dirname "$dest")"
  sed -e "s|@VERSION@|${version}|g" \
      -e "s|@DMG_SHA256@|${dmg}|g" \
      -e "s|@CLI_AARCH64_APPLE_DARWIN_SHA256@|${cli_arm}|g" \
      -e "s|@CLI_X86_64_APPLE_DARWIN_SHA256@|${cli_intel}|g" \
      -e "s|@CLI_X86_64_UNKNOWN_LINUX_GNU_SHA256@|${cli_linux}|g" \
      "$template" > "$dest"
  if grep -n '@[A-Z0-9_]*@' "$dest" >&2; then
    echo "error: $dest still has a placeholder (above)" >&2
    exit 1
  fi
  echo "wrote $dest"
}

render "$templates/nauvi.rb.in" "$out/Casks/nauvi.rb"
render "$templates/nauvi-cli.rb.in" "$out/Formula/nauvi-cli.rb"

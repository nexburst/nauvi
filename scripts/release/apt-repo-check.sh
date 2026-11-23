#!/usr/bin/env bash
# Check the apt repository (#427) end to end with a release's .deb, the way
# the release dry run does: build it with scripts/release/apt-repo.sh and a
# throwaway key, serve it on 127.0.0.1, and in clean Ubuntu containers add
# the key and the source as the README says, install nauvi, upgrade it from
# an older version and run it.
#
# Usage: scripts/release/apt-repo-check.sh <nauvi_X.Y.Z_amd64.deb> [image...]
#   images default to ubuntu:22.04 ubuntu:24.04
#
# Needs docker, apt-utils (apt-ftparchive), gpg and python3. Nothing outside
# a temporary directory and the containers is changed.
set -euo pipefail

[ $# -ge 1 ] || { echo "usage: $0 <nauvi_X.Y.Z_amd64.deb> [image...]" >&2; exit 2; }
deb=$(realpath "$1"); shift
images=("$@")
[ ${#images[@]} -gt 0 ] || images=(ubuntu:22.04 ubuntu:24.04)
here=$(cd "$(dirname "$0")" && pwd)
version=$(dpkg-deb -f "$deb" Version)
depends=$(dpkg-deb -f "$deb" Depends)

work=$(mktemp -d)
server=""
cleanup() {
  [ -z "$server" ] || kill "$server" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

# A throwaway signing key, with a passphrase like the real one may have.
export GNUPGHOME="$work/gnupg"
mkdir -m 700 "$GNUPGHOME"
export APT_GPG_PASSPHRASE="dry-run-$RANDOM$RANDOM"
gpg --batch --quiet --pinentry-mode loopback --passphrase "$APT_GPG_PASSPHRASE" \
  --quick-gen-key "nauvi apt dry run <apt-dry-run@nauvi.invalid>" ed25519 sign 1d
APT_GPG_KEY=$(gpg --batch --with-colons --list-secret-keys | awk -F: '$1 == "fpr" { print $10; exit }')
export APT_GPG_KEY

# A small fake nauvi of another version, with the real package's dependencies.
fake() {
  local v="$1" d="$work/fake-$1"
  mkdir -p "$d/DEBIAN" "$d/usr/bin"
  printf '#!/bin/sh\necho "nauvi-desktop %s"\n' "$v" > "$d/usr/bin/nauvi-desktop"
  chmod 755 "$d/usr/bin/nauvi-desktop"
  cat > "$d/DEBIAN/control" <<EOF
Package: nauvi
Version: $v
Architecture: amd64
Maintainer: nauvi
Depends: $depends
Description: fake nauvi $v for the apt repository check
EOF
  dpkg-deb --root-owner-group --build "$d" "$work/nauvi_${v}_amd64.deb" >/dev/null
  echo "$work/nauvi_${v}_amd64.deb"
}
old=$(fake 0.0.1)

# r1: only the old version; r2: the old one and this release (what users
# see after the release). Same key, so one source line works for both.
site="$work/site"
"$here/apt-repo.sh" "$site/r1/apt" "$old"
cp -r "$site/r1" "$site/r2"
"$here/apt-repo.sh" "$site/r2/apt" "$deb"
grep -q "^Version: $version$" "$site/r2/apt/dists/stable/main/binary-amd64/Packages"

# The script's own rules, without containers.
echo "--- the repository script's rules"
rules="$work/rules"
cp -r "$site/r2" "$rules"
again=$("$here/apt-repo.sh" "$rules/apt" "$deb")
grep -q "already in the pool" <<<"$again" || { echo "error: adding the same .deb again was not a no-op" >&2; exit 1; }
other=$(fake "$version")
if "$here/apt-repo.sh" "$rules/apt" "$other" 2>/dev/null; then
  echo "error: a published version with other contents was replaced" >&2; exit 1
fi
if "$here/apt-repo.sh" "$rules/apt" "$(fake 0.0.2-1)" 2>/dev/null; then
  echo "error: a pre-release version was accepted" >&2; exit 1
fi
for v in 0.0.2 0.0.3 0.0.4 0.0.5; do "$here/apt-repo.sh" "$rules/apt" "$(fake "$v")" >/dev/null; done
pool=$(find "$rules/apt/pool" -name '*.deb' -printf '%f\n' | sort -V | tr '\n' ' ')
[ "$pool" = "nauvi_0.0.2_amd64.deb nauvi_0.0.3_amd64.deb nauvi_0.0.4_amd64.deb nauvi_0.0.5_amd64.deb nauvi_${version}_amd64.deb " ] \
  || { echo "error: the pool should keep the last 5 versions, has: $pool" >&2; exit 1; }
other_home="$work/other-gnupg"
mkdir -m 700 "$other_home"
GNUPGHOME="$other_home" gpg --batch --quiet --passphrase "" --quick-gen-key "other <other@nauvi.invalid>" ed25519 sign 1d
other_key=$(GNUPGHOME="$other_home" gpg --batch --with-colons --list-secret-keys | awk -F: '$1 == "fpr" { print $10; exit }')
if GNUPGHOME="$other_home" APT_GPG_KEY="$other_key" APT_GPG_PASSPHRASE="" "$here/apt-repo.sh" "$rules/apt" "$deb" 2>/dev/null; then
  echo "error: another key replaced the repository's key without APT_NEW_KEY=1" >&2; exit 1
fi
echo "ok: same version is a no-op, replaced contents and pre-releases are refused, the last 5 are kept, the key stays"

port=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
python3 -m http.server --bind 127.0.0.1 --directory "$site" "$port" >"$work/http.log" 2>&1 &
server=$!
for _ in $(seq 50); do
  curl -fsS -o /dev/null "http://127.0.0.1:$port/r1/apt/nauvi.gpg" 2>/dev/null && break
  sleep 0.2
done

# In the container: the README's steps against r1 (install the old
# version), then r2 (upgrade, then a fresh install of this release).
cat > "$work/in-container.sh" <<'EOF'
set -euo pipefail
base="$1" version="$2"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl gpg ca-certificates >/dev/null

source_at() {
  echo "deb [signed-by=/etc/apt/keyrings/nauvi.gpg] $base/$1/apt stable main" > /etc/apt/sources.list.d/nauvi.list
  apt-get update -qq
}
installed() { dpkg-query -W -f '${Version}' nauvi; }

# The README's steps.
install -d -m 0755 /etc/apt/keyrings
curl -fsSL "$base/r1/apt/nauvi.gpg" | gpg --dearmor -o /etc/apt/keyrings/nauvi.gpg
source_at r1
apt-get install -y -qq nauvi >/dev/null
[ "$(installed)" = "0.0.1" ] || { echo "error: installed $(installed), not 0.0.1"; exit 1; }
echo "installed 0.0.1"

source_at r2
apt-get upgrade -y -qq >/dev/null
[ "$(installed)" = "$version" ] || { echo "error: the upgrade left $(installed), not $version"; exit 1; }
out=$(timeout 30 nauvi-desktop --version)
echo "upgraded: $out"
[ "$out" = "nauvi-desktop $version" ] || { echo "error: nauvi-desktop --version printed '$out'"; exit 1; }
if ldd /usr/bin/nauvi-desktop | grep 'not found'; then echo "error: missing libraries"; exit 1; fi

apt-get remove -y -qq nauvi >/dev/null
apt-get install -y -qq nauvi >/dev/null
[ "$(installed)" = "$version" ] || { echo "error: a fresh install got $(installed), not $version"; exit 1; }
echo "fresh install: $(nauvi-desktop --version)"
EOF

for image in "${images[@]}"; do
  echo "--- $image"
  docker run --rm --network host -v "$work/in-container.sh:/check.sh:ro" "$image" \
    bash /check.sh "http://127.0.0.1:$port" "$version"
done
echo "ok: nauvi $version installs and upgrades from the apt repository on ${images[*]}"

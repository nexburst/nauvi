#!/usr/bin/env bash
# Add .deb packages to the nauvi apt repository (#427) and sign it.
#
# Usage: scripts/release/apt-repo.sh <repo-dir> <deb>...
#   e.g. scripts/release/apt-repo.sh site/apt nauvi_0.2.0_amd64.deb
#
# <repo-dir> is the repository as GitHub Pages serves it (the apt/ folder of
# the gh-pages branch); it may be empty or missing for the first release.
# The layout is one suite `stable`, component `main`, architecture amd64:
#
#   <repo-dir>/nauvi.gpg                              the public key (armored)
#   <repo-dir>/pool/main/n/nauvi/nauvi_<v>_amd64.deb  the last $APT_KEEP versions
#   <repo-dir>/dists/stable/{Release,InRelease,Release.gpg}
#   <repo-dir>/dists/stable/main/binary-amd64/Packages(.gz)
#
# The indexes are rebuilt from the pool with apt-ftparchive every time, so
# the branch is the only state. Environment:
#   APT_GPG_KEY         the key to sign with (fingerprint or id), in GNUPGHOME
#   APT_GPG_PASSPHRASE  its passphrase (optional)
#   APT_KEEP            versions to keep in the pool (default 5)
#   APT_NEW_KEY=1       allow a key other than the one in <repo-dir>/nauvi.gpg
#                       (a key rotation: every user must fetch the new key)
#
# Refuses a package that is not nauvi/amd64, a pre-release version (dpkg
# sorts 0.2.0-1 after 0.2.0, the opposite of the app's versions) and a
# version already in the pool with other contents.
set -euo pipefail

usage() { echo "usage: $0 <repo-dir> <deb>...   (e.g. site/apt nauvi_0.2.0_amd64.deb)" >&2; exit 2; }
[ $# -ge 2 ] || usage
repo="$1"; shift
keep="${APT_KEEP:-5}"
key="${APT_GPG_KEY:-}"
[ -n "$key" ] || { echo "error: APT_GPG_KEY is not set (the key to sign with)" >&2; exit 1; }
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || { echo "error: APT_KEEP is not a positive number: $keep" >&2; exit 1; }
for tool in apt-ftparchive dpkg-deb gpg gpgv; do
  command -v "$tool" >/dev/null || { echo "error: $tool is not installed (apt-ftparchive is in apt-utils)" >&2; exit 1; }
done

pool="$repo/pool/main/n/nauvi"
mkdir -p "$pool"

# The fingerprint of the signing key, which must have its secret part here.
fpr=$(gpg --batch --with-colons --list-secret-keys -- "$key" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
[ -n "$fpr" ] || { echo "error: no secret key $key in the keyring" >&2; exit 1; }

# The published key stays the same unless a rotation is asked for: a new
# secret must not silently change what users trust.
if [ -f "$repo/nauvi.gpg" ]; then
  old=$(gpg --batch --with-colons --show-keys "$repo/nauvi.gpg" | awk -F: '$1 == "fpr" { print $10; exit }')
  if [ "$old" != "$fpr" ] && [ "${APT_NEW_KEY:-}" != "1" ]; then
    echo "error: the repository's key is $old but the signing key is $fpr." >&2
    echo "       Set APT_NEW_KEY=1 to rotate the key (users then have to fetch the new nauvi.gpg)." >&2
    exit 1
  fi
fi

for deb in "$@"; do
  [ -f "$deb" ] || { echo "error: no such file: $deb" >&2; exit 1; }
  name=$(dpkg-deb -f "$deb" Package)
  version=$(dpkg-deb -f "$deb" Version)
  arch=$(dpkg-deb -f "$deb" Architecture)
  [ "$name" = "nauvi" ] || { echo "error: $deb is package '$name', not nauvi" >&2; exit 1; }
  [ "$arch" = "amd64" ] || { echo "error: $deb is for $arch, not amd64" >&2; exit 1; }
  if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "error: $deb has version $version; the stable suite takes MAJOR.MINOR.PATCH only" >&2
    exit 1
  fi
  dest="$pool/nauvi_${version}_amd64.deb"
  if [ -e "$dest" ]; then
    if cmp -s "$deb" "$dest"; then
      echo "nauvi $version is already in the pool"
      continue
    fi
    echo "error: nauvi $version is already in the pool with other contents; a published version is never replaced" >&2
    exit 1
  fi
  cp "$deb" "$dest"
  echo "added nauvi $version"
done

# Keep the newest $keep versions (all are MAJOR.MINOR.PATCH, so sort -V
# orders them as dpkg does).
mapfile -t versions < <(find "$pool" -maxdepth 1 -name 'nauvi_*_amd64.deb' -printf '%f\n' \
  | sed -E 's/^nauvi_(.*)_amd64\.deb$/\1/' | sort -V)
drop=$(( ${#versions[@]} - keep ))
for (( i = 0; i < drop; i++ )); do
  rm "$pool/nauvi_${versions[$i]}_amd64.deb"
  echo "removed nauvi ${versions[$i]} (keeping the last $keep)"
done

# Indexes. Paths in Packages are relative to <repo-dir>.
dist="$repo/dists/stable"
rm -rf "$repo/dists"
mkdir -p "$dist/main/binary-amd64"
(cd "$repo" && apt-ftparchive --arch amd64 packages pool/main) > "$dist/main/binary-amd64/Packages"
gzip -9nk "$dist/main/binary-amd64/Packages"
release=$(mktemp)
trap 'rm -f "$release"' EXIT
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=nauvi \
  -o APT::FTPArchive::Release::Label=nauvi \
  -o APT::FTPArchive::Release::Suite=stable \
  -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures=amd64 \
  -o APT::FTPArchive::Release::Components=main \
  -o "APT::FTPArchive::Release::Description=nauvi, a Kubernetes IDE (https://github.com/nexburst/nauvi)" \
  release "$dist" > "$release"
mv "$release" "$dist/Release"

# Sign: InRelease (inline, what apt reads first) and Release.gpg (detached,
# for older clients).
sign() {
  local args=(--batch --yes --local-user "$fpr" --digest-algo SHA512)
  if [ -n "${APT_GPG_PASSPHRASE:-}" ]; then
    gpg "${args[@]}" --pinentry-mode loopback --passphrase-fd 3 "$@" 3<<<"$APT_GPG_PASSPHRASE"
  else
    gpg "${args[@]}" "$@"
  fi
}
sign --clearsign --output "$dist/InRelease" "$dist/Release"
sign --armor --detach-sign --output "$dist/Release.gpg" "$dist/Release"
gpg --batch --yes --armor --export-options export-minimal --output "$repo/nauvi.gpg" --export "$fpr"

# Check both signatures against the published key, as apt will.
keyring=$(mktemp)
trap 'rm -f "$release" "$keyring"' EXIT
gpg --batch --yes --dearmor --output "$keyring" "$repo/nauvi.gpg"
gpgv --quiet --keyring "$keyring" "$dist/InRelease"
gpgv --quiet --keyring "$keyring" "$dist/Release.gpg" "$dist/Release"

echo "signed with $fpr; the pool has:"
find "$pool" -maxdepth 1 -name 'nauvi_*_amd64.deb' -printf '  %f\n' | sort -V

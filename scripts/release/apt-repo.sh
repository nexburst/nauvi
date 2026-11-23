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
#   APT_TRUSTED_KEYS    the trusted key fingerprints, first one signs
#                       (default: the lines of scripts/release/apt-keys.txt)
#
# Anyone who can push to gh-pages can change <repo-dir>, so nothing in it is
# signed again unless the published repository checks out first: its
# InRelease must be signed by a trusted key, Packages must match InRelease,
# and every pool file must be a nauvi package listed in Packages with that
# hash. Anything else there (another file, a symlink) is refused.
#
# Refuses a package that is not nauvi/amd64, a pre-release version (dpkg
# sorts 0.2.0-1 after 0.2.0, the opposite of the app's versions) and a
# version already in the pool with other contents.
set -euo pipefail

usage() { echo "usage: $0 <repo-dir> <deb>...   (e.g. site/apt nauvi_0.2.0_amd64.deb)" >&2; exit 2; }
die() { echo "error: $*" >&2; exit 1; }
[ $# -ge 2 ] || usage
repo="$1"; shift
here=$(cd "$(dirname "$0")" && pwd)
keep="${APT_KEEP:-5}"
key="${APT_GPG_KEY:-}"
[ -n "$key" ] || die "APT_GPG_KEY is not set (the key to sign with)"
[[ "$keep" =~ ^[1-9][0-9]*$ ]] || die "APT_KEEP is not a positive number: $keep"
for tool in apt-ftparchive dpkg-deb gpg gpgv sha256sum; do
  command -v "$tool" >/dev/null || die "$tool is not installed (apt-ftparchive is in apt-utils)"
done

if [ -n "${APT_TRUSTED_KEYS:-}" ]; then
  read -r -a trusted <<<"$APT_TRUSTED_KEYS"
else
  mapfile -t trusted < <(grep -Ev '^[[:space:]]*(#|$)' "$here/apt-keys.txt" | tr -d '[:space:]' | grep .)
fi
[ ${#trusted[@]} -gt 0 ] || die "no trusted key fingerprints"
for t in "${trusted[@]}"; do
  [[ "$t" =~ ^[0-9A-F]{40}$ ]] || die "not a key fingerprint: $t"
done
is_trusted() {
  local t
  for t in "${trusted[@]}"; do [ "$1" = "$t" ] && return 0; done
  return 1
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# The signing key must be the first trusted one: a changed secret must not
# silently change what users trust. A rotation is a reviewed change of
# apt-keys.txt.
fpr=$(gpg --batch --with-colons --list-secret-keys -- "$key" 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }')
[ -n "$fpr" ] || die "no secret key $key in the keyring"
[ "$fpr" = "${trusted[0]}" ] || die "the signing key is $fpr, but the first trusted key is ${trusted[0]} (scripts/release/apt-keys.txt)"

pool_rel="pool/main/n/nauvi"
pool="$repo/$pool_rel"
dist="$repo/dists/stable"
packages_rel="main/binary-amd64/Packages"

# Check the published repository before anything in it is signed again.
declare -A known=()
# find does not descend into a symlinked starting point, which would skip
# every check below.
[ ! -L "$repo" ] || die "$repo is a symlink, not the repository's directory"
[ ! -e "$repo" ] || [ -d "$repo" ] || die "$repo is not a directory"
if [ -d "$repo" ] && [ -n "$(find "$repo" -mindepth 1 -print -quit)" ]; then
  odd=$(find "$repo" -mindepth 1 ! -type f ! -type d -print -quit)
  [ -z "$odd" ] || die "$odd in the published repository is not a regular file"
  [ -f "$dist/InRelease" ] || die "the published repository has files but no dists/stable/InRelease"
  [ -f "$dist/$packages_rel" ] || die "the published repository has no dists/stable/$packages_rel"

  # The published nauvi.gpg may hold any key; only the fingerprint of the
  # key that made the signature decides.
  ring="$work/published.gpg"
  gpg --batch --export "$fpr" > "$ring"
  if [ -f "$repo/nauvi.gpg" ]; then
    gpg --batch --dearmor < "$repo/nauvi.gpg" >> "$ring" 2>/dev/null || true
  fi
  status=$(gpgv --keyring "$ring" --status-fd 1 --output "$work/Release" "$dist/InRelease" 2>/dev/null) \
    || die "the published dists/stable/InRelease does not verify with a trusted key"
  # Exactly one signature, by a trusted key: the signed text gpgv writes
  # out is then that key's alone.
  mapfile -t signers < <(awk '$2 == "VALIDSIG" { print $12 }' <<<"$status")
  [ ${#signers[@]} -eq 1 ] || die "the published InRelease has ${#signers[@]} valid signatures, not one"
  [ "$(grep -c '^\[GNUPG:\] GOODSIG ' <<<"$status")" -eq 1 ] || die "the published InRelease does not have exactly one good signature"
  is_trusted "${signers[0]}" || die "the published InRelease is signed by ${signers[0]}, which is not a trusted key"

  want=$(awk -v f="$packages_rel" '/^SHA256:/ { s = 1; next } /^[^ ]/ { s = 0 } s && $3 == f { print $1; exit }' "$work/Release")
  got=$(sha256sum < "$dist/$packages_rel" | cut -d' ' -f1)
  [ -n "$want" ] && [ "$got" = "$want" ] || die "the published Packages does not match the signed InRelease"

  # Every package listed must be a nauvi .deb in its pool, with that hash.
  while read -r name file sum; do
    [ "$name" = "nauvi" ] || die "the published Packages lists package '$name'"
    [[ "$file" =~ ^pool/main/n/nauvi/nauvi_[0-9]+\.[0-9]+\.[0-9]+_amd64\.deb$ ]] || die "the published Packages lists $file"
    [ -f "$repo/$file" ] || die "the published Packages lists $file, which is missing"
    [ "$(sha256sum < "$repo/$file" | cut -d' ' -f1)" = "$sum" ] || die "$file does not match the signed Packages"
    known["$file"]=1
  done < <(awk -v RS= -F'\n' '{
      p = f = h = ""
      for (i = 1; i <= NF; i++) {
        if ($i ~ /^Package: /) p = substr($i, 10)
        else if ($i ~ /^Filename: /) f = substr($i, 11)
        else if ($i ~ /^SHA256: /) h = substr($i, 9)
      }
      print (p == "" ? "-" : p), (f == "" ? "-" : f), (h == "" ? "-" : h)
    }' "$dist/$packages_rel")

  # Nothing else may be there: the indexes are rebuilt below.
  while IFS= read -r -d '' f; do
    rel="${f#"$repo"/}"
    case "$rel" in
      nauvi.gpg | dists/stable/Release | dists/stable/InRelease | dists/stable/Release.gpg \
        | "dists/stable/$packages_rel" | "dists/stable/$packages_rel.gz") ;;
      *) [ -n "${known[$rel]:-}" ] || die "$rel in the published repository is not in its signed Packages" ;;
    esac
  done < <(find "$repo" -type f -print0)
fi

mkdir -p "$pool"
for deb in "$@"; do
  [ -f "$deb" ] || die "no such file: $deb"
  name=$(dpkg-deb -f "$deb" Package)
  version=$(dpkg-deb -f "$deb" Version)
  arch=$(dpkg-deb -f "$deb" Architecture)
  [ "$name" = "nauvi" ] || die "$deb is package '$name', not nauvi"
  [ "$arch" = "amd64" ] || die "$deb is for $arch, not amd64"
  [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "$deb has version $version; the stable suite takes MAJOR.MINOR.PATCH only"
  dest="$pool/nauvi_${version}_amd64.deb"
  if [ -e "$dest" ]; then
    if cmp -s "$deb" "$dest"; then
      echo "nauvi $version is already in the pool"
      continue
    fi
    die "nauvi $version is already in the pool with other contents; a published version is never replaced"
  fi
  cp "$deb" "$dest"
  chmod 644 "$dest"
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

# Indexes, of the nauvi pool only. Paths in Packages are relative to <repo-dir>.
rm -rf "$repo/dists"
mkdir -p "$dist/main/binary-amd64"
(cd "$repo" && apt-ftparchive --arch amd64 packages "$pool_rel") > "$dist/$packages_rel"
if grep '^Package: ' "$dist/$packages_rel" | grep -qv '^Package: nauvi$'; then
  die "the new Packages lists a package other than nauvi"
fi
gzip -9nk "$dist/$packages_rel"
apt-ftparchive \
  -o APT::FTPArchive::Release::Origin=nauvi \
  -o APT::FTPArchive::Release::Label=nauvi \
  -o APT::FTPArchive::Release::Suite=stable \
  -o APT::FTPArchive::Release::Codename=stable \
  -o APT::FTPArchive::Release::Architectures=amd64 \
  -o APT::FTPArchive::Release::Components=main \
  -o "APT::FTPArchive::Release::Description=nauvi, a Kubernetes IDE (https://github.com/nexburst/nauvi)" \
  release "$dist" > "$work/Release.new"
# Written outside $dist (apt-ftparchive would index a half-written Release),
# then moved in with the mode of the other files.
mv "$work/Release.new" "$dist/Release"
chmod 644 "$dist/Release"

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
keyring="$work/nauvi.keyring"
gpg --batch --yes --dearmor --output "$keyring" "$repo/nauvi.gpg"
gpgv --quiet --keyring "$keyring" "$dist/InRelease"
gpgv --quiet --keyring "$keyring" "$dist/Release.gpg" "$dist/Release"

echo "signed with $fpr; the pool has:"
find "$pool" -maxdepth 1 -name 'nauvi_*_amd64.deb' -printf '  %f\n' | sort -V

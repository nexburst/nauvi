#!/bin/sh
# Installs the nauvi desktop app from its apt repository (#448), in one step:
#
#   curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install-apt.sh | sudo sh
#
# It does what the README's manual steps do: fetches the repository's key,
# checks its fingerprint against the one pinned below, writes
# /etc/apt/keyrings/nauvi.gpg and /etc/apt/sources.list.d/nauvi.list, and
# installs the `nauvi` package. After that `sudo apt upgrade` keeps it up to
# date. Running it again changes nothing but upgrades nauvi.
#
#   ... | sudo sh -s -- --uninstall   removes the package, the key and the
#                                     source (not your settings)
#
# Debian, Ubuntu and derivatives, x86_64 (amd64) only. Installs gpg (and
# curl) first if they are missing.
#
# Environment, for tests only (sudo drops it anyway):
#   NAUVI_APT_URL   the repository (default https://nexburst.github.io/nauvi/apt)
#   NAUVI_APT_KEYS  the trusted key fingerprints, space-separated
#
# The whole script is one function called on the last line, so a download
# cut short runs nothing.

nauvi_install_apt() {
  set -eu

  # The fingerprints of scripts/release/apt-keys.txt (CI checks they match).
  trusted_keys="B2B644E79A85C438FC3EB8C5408A65C769395FBF"

  url="${NAUVI_APT_URL:-https://nexburst.github.io/nauvi/apt}"
  keys="${NAUVI_APT_KEYS:-$trusted_keys}"
  keyring=/etc/apt/keyrings/nauvi.gpg
  list=/etc/apt/sources.list.d/nauvi.list

  say() { printf '%s\n' "$*"; }
  die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
  }

  mode=install
  for arg in "$@"; do
    case "$arg" in
      --uninstall) mode=uninstall ;;
      -h | --help)
        say "usage: curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install-apt.sh | sudo sh [-s -- --uninstall]"
        return 0
        ;;
      *) die "unknown option: $arg" ;;
    esac
  done

  [ "$(id -u)" = 0 ] || die "run it as root: curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install-apt.sh | sudo sh"
  if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg >/dev/null 2>&1; then
    die "this needs apt (Debian, Ubuntu or a derivative); see https://github.com/nexburst/nauvi#install for other systems"
  fi
  export DEBIAN_FRONTEND=noninteractive

  if [ "$mode" = uninstall ]; then
    if dpkg-query -W -f '${Status}' nauvi 2>/dev/null | grep -q 'install ok installed'; then
      apt-get remove -y nauvi </dev/null
    fi
    rm -f "$keyring" "$list"
    say "Removed nauvi, its apt key and its apt source. Your settings are kept."
    return 0
  fi

  arch=$(dpkg --print-architecture)
  [ "$arch" = amd64 ] || die "the apt repository only has x86_64 (amd64) packages; this system is $arch"

  missing=""
  command -v gpg >/dev/null 2>&1 || missing="$missing gpg"
  command -v curl >/dev/null 2>&1 || missing="$missing curl"
  if [ -n "$missing" ]; then
    say "Installing$missing"
    apt-get update -qq </dev/null
    # shellcheck disable=SC2086 # a list of package names
    apt-get install -y -qq $missing ca-certificates </dev/null >/dev/null
  fi

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  export GNUPGHOME="$tmp/gnupg"
  mkdir -m 700 "$GNUPGHOME"

  say "Fetching the nauvi apt key from $url"
  # https only, also after redirects; plain http only for a test repository.
  proto='=https'
  [ -z "${NAUVI_APT_URL:-}" ] || proto='=https,http'
  curl -fsSL --proto "$proto" --proto-redir "$proto" "$url/nauvi.gpg" -o "$tmp/nauvi.asc" || die "could not download $url/nauvi.gpg"
  gpg --batch --quiet --dearmor -o "$tmp/nauvi.gpg" "$tmp/nauvi.asc" 2>/dev/null \
    || die "$url/nauvi.gpg is not a PGP key"
  # Every primary key in the file must be a trusted one, and there must be one.
  found=$(gpg --batch --with-colons --show-keys "$tmp/nauvi.gpg" 2>/dev/null \
    | awk -F: '$1 == "pub" { p = 1; next } $1 == "fpr" && p { print $10; p = 0 }')
  [ -n "$found" ] || die "no key in $url/nauvi.gpg"
  for f in $found; do
    case " $keys " in
      *" $f "*) ;;
      *) die "the key at $url/nauvi.gpg is $f, not the nauvi key ($keys); nothing was installed" ;;
    esac
  done
  say "Key fingerprint: $found"

  install -d -m 0755 /etc/apt/keyrings
  install -m 0644 "$tmp/nauvi.gpg" "$keyring"
  printf 'deb [arch=amd64 signed-by=%s] %s stable main\n' "$keyring" "$url" >"$list"
  chmod 0644 "$list"
  say "Added $list"

  apt-get update -qq </dev/null
  apt-get install -y nauvi </dev/null
  say ""
  say "Installed nauvi $(dpkg-query -W -f '${Version}' nauvi): run nauvi-desktop, or find nauvi in your applications."
  say "Updates come with: sudo apt update && sudo apt upgrade"
}

nauvi_install_apt "$@"

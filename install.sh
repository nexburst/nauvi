#!/bin/sh
# Installs nauvi from its GitHub release (#430):
#
#   curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/nexburst/nauvi/main/install.sh | sh -s -- --cli
#
# Linux (x86_64): the AppImage as ~/.local/bin/nauvi-desktop, a desktop entry
#   (with the nauvi:// link handler) and its icon. No sudo.
# macOS: nauvi.app from the universal .dmg into /Applications (or
#   ~/Applications when /Applications is not writable).
# --cli: only the command-line tool, as ~/.local/bin/nauvi.
# --uninstall: removes what this script installs (not your settings).
#
# Every download is checked against the release's SHA256SUMS before anything
# is put in place. Running it again upgrades in place.
#
# Environment:
#   NAUVI_VERSION      a release tag (v0.1.0) instead of the latest release
#   NAUVI_INSTALL_DIR  where the programs go (default ~/.local/bin)
#   NAUVI_APP_DIR      macOS: where nauvi.app goes (default: see above)
#   NAUVI_DOWNLOAD_BASE  for tests only: the release's download URL, https://
#                      or file:// (a directory holding the assets and SHA256SUMS)
#
# The whole script is one function called on the last line, so a download
# cut short runs nothing.

nauvi_install() {
  set -eu

  repo="nexburst/nauvi"
  releases="https://github.com/$repo/releases"

  say() { printf '%s\n' "$*"; }
  warn() { printf 'warning: %s\n' "$*" >&2; }
  die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
  }

  mode=app
  uninstall=0
  for arg in "$@"; do
    case "$arg" in
    --cli) mode=cli ;;
    --uninstall) uninstall=1 ;;
    -h | --help)
      say "usage: install.sh [--cli] [--uninstall]"
      say "  (no option)  the desktop app"
      say "  --cli        only the nauvi command-line tool"
      say "  --uninstall  remove what this script installed (settings are kept)"
      say "Environment: NAUVI_VERSION=v0.1.0, NAUVI_INSTALL_DIR=<dir>, NAUVI_APP_DIR=<dir> (macOS)"
      return 0
      ;;
    *) die "unknown option '$arg' (try --help)" ;;
    esac
  done

  [ -n "${HOME:-}" ] || die "HOME is not set"
  bin_dir="${NAUVI_INSTALL_DIR:-$HOME/.local/bin}"
  case "$bin_dir" in
  /*) ;;
  *) die "NAUVI_INSTALL_DIR must be an absolute path (got '$bin_dir')" ;;
  esac
  data_dir="${XDG_DATA_HOME:-$HOME/.local/share}"
  desktop_file="$data_dir/applications/nauvi.desktop"
  icon_sizes="16x16 32x32 48x48 64x64 128x128 256x256 256x256@2 512x512"

  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
  Linux) platform=linux ;;
  Darwin) platform=macos ;;
  *) die "$os is not supported by this script; download nauvi from $releases" ;;
  esac

  app_dir() {
    if [ -n "${NAUVI_APP_DIR:-}" ]; then
      printf '%s\n' "$NAUVI_APP_DIR"
    elif [ -w /Applications ]; then
      printf '%s\n' /Applications
    else
      printf '%s\n' "$HOME/Applications"
    fi
  }

  # --- uninstall -----------------------------------------------------------
  if [ "$uninstall" -eq 1 ]; then
    removed=0
    remove() {
      for p in "$@"; do
        if [ -e "$p" ] || [ -L "$p" ]; then
          rm -rf -- "$p"
          say "removed $p"
          removed=1
        fi
      done
    }
    remove "$bin_dir/nauvi" "$bin_dir/nauvi-desktop"
    if [ "$platform" = linux ]; then
      remove "$desktop_file"
      for s in $icon_sizes; do
        remove "$data_dir/icons/hicolor/$s/apps/nauvi.png"
      done
      if command -v update-desktop-database >/dev/null 2>&1; then
        update-desktop-database "$data_dir/applications" >/dev/null 2>&1 || true
      fi
    else
      if [ -n "${NAUVI_APP_DIR:-}" ]; then
        remove "$NAUVI_APP_DIR/nauvi.app"
      else
        remove /Applications/nauvi.app "$HOME/Applications/nauvi.app"
      fi
    fi
    [ "$removed" -eq 1 ] || say "nauvi is not installed by this script; nothing to remove"
    say "Your settings were kept."
    return 0
  fi

  # --- where to download from ----------------------------------------------
  command -v curl >/dev/null 2>&1 || die "curl is needed (for example: sudo apt install curl)"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256() { sha256sum "$1" | cut -d' ' -f1; }
  elif command -v shasum >/dev/null 2>&1; then
    sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
  else
    die "sha256sum or shasum is needed to check the download"
  fi

  if [ -n "${NAUVI_DOWNLOAD_BASE:-}" ]; then
    base="${NAUVI_DOWNLOAD_BASE%/}"
  elif [ -n "${NAUVI_VERSION:-}" ]; then
    v="$NAUVI_VERSION"
    case "$v" in v*) ;; *) v="v$v" ;; esac
    # Only a release tag: it goes into the URL. The case rules out a newline
    # (and anything else odd), so the line-based grep sees the whole value.
    case "$v" in *[!v0-9.-]*) die "NAUVI_VERSION must look like v0.1.0 (got '$NAUVI_VERSION')" ;; esac
    printf '%s\n' "$v" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9]+)?$' ||
      die "NAUVI_VERSION must look like v0.1.0 (got '$NAUVI_VERSION')"
    base="$releases/download/$v"
  else
    base="$releases/latest/download"
  fi
  case "$base" in
  https://*) proto="=https" ;;
  file:///*) proto="=file" ;;
  *) die "refusing to download from '$base': only https:// is allowed" ;;
  esac

  tmp=$(mktemp -d "${TMPDIR:-/tmp}/nauvi-install.XXXXXX")
  # shellcheck disable=SC2064 # expand $tmp now
  trap "rm -rf '$tmp'" EXIT
  trap 'exit 130' INT TERM

  fetch() {
    # $1: file name in the release, $2: where to save it.
    curl --fail --silent --show-error --location --proto "$proto" --proto-redir "$proto" \
      --retry 3 --output "$2" "$base/$1" ||
      die "could not download $base/$1"
  }

  fetch SHA256SUMS "$tmp/SHA256SUMS"

  # The one asset in SHA256SUMS whose name matches the pattern (an ERE).
  pick() {
    names=$(awk '{ n = $2; sub(/^\*/, "", n); print n }' "$tmp/SHA256SUMS" | grep -E "$1" || true)
    count=$(printf '%s' "$names" | grep -c . || true)
    [ "$count" -eq 1 ] || die "the release has $count files matching $1, expected one (see $releases)"
    case "$names" in
    */* | .*) die "unexpected file name in SHA256SUMS: $names" ;;
    esac
    printf '%s\n' "$names"
  }

  # Downloads the asset and checks it; prints its local path.
  download() {
    want=$(awk -v n="$1" '{ m = $2; sub(/^\*/, "", m); if (m == n) { print $1; exit } }' "$tmp/SHA256SUMS")
    printf '%s\n' "$want" | grep -Eq '^[0-9a-fA-F]{64}$' || die "no SHA-256 for $1 in SHA256SUMS"
    say "Downloading $1" >&2
    fetch "$1" "$tmp/$1"
    got=$(sha256 "$tmp/$1")
    if [ "$(printf '%s' "$got" | tr 'A-F' 'a-f')" != "$(printf '%s' "$want" | tr 'A-F' 'a-f')" ]; then
      rm -f "$tmp/$1"
      die "checksum mismatch for $1 (expected $want, got $got); nothing was installed"
    fi
    printf '%s\n' "$tmp/$1"
  }

  # Moves a file into place in one step, so a running copy is replaced cleanly.
  put() {
    mkdir -p "$(dirname "$2")"
    cp "$1" "$2.new.$$"
    chmod 755 "$2.new.$$"
    mv -f "$2.new.$$" "$2"
  }

  path_hint() {
    case ":$PATH:" in
    *":$bin_dir:"*) ;;
    *) warn "$bin_dir is not on your PATH; add it, e.g. export PATH=\"$bin_dir:\$PATH\" in your shell's profile" ;;
    esac
  }

  # --- the CLI -------------------------------------------------------------
  if [ "$mode" = cli ]; then
    case "$platform-$arch" in
    linux-x86_64 | linux-amd64) target=x86_64-unknown-linux-gnu ;;
    macos-arm64 | macos-aarch64) target=aarch64-apple-darwin ;;
    macos-x86_64)
      target=x86_64-apple-darwin
      # A shell under Rosetta on Apple silicon reports x86_64.
      if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = 1 ]; then
        target=aarch64-apple-darwin
      fi
      ;;
    *) die "there is no nauvi CLI build for $os $arch yet; see $releases" ;;
    esac
    name=$(pick "^nauvi-cli-v[0-9][0-9.-]*-$target\\.tar\\.gz\$")
    archive=$(download "$name")
    mkdir "$tmp/cli"
    tar -xzf "$archive" -C "$tmp/cli"
    exe="$tmp/cli/${name%.tar.gz}/nauvi"
    [ -f "$exe" ] || die "$name has no nauvi binary inside"
    put "$exe" "$bin_dir/nauvi"
    say "Installed the nauvi CLI ($("$bin_dir/nauvi" --version 2>/dev/null || echo "${name%-"$target".tar.gz}")) to $bin_dir/nauvi"
    path_hint
    return 0
  fi

  # --- the desktop app: macOS ----------------------------------------------
  # Mounts the DMG ($1) read-only at $2, hidden from Finder (so no window
  # opens), past its licence agreement (#210). `diskutil image` where it
  # exists (#467: macOS 27 deprecates `hdiutil attach`), else hdiutil.
  # NAUVI_TEST_DMG_TOOL=diskutil|hdiutil, for tests only, takes one of the
  # two without falling back.
  attach_dmg() {
    tool=${NAUVI_TEST_DMG_TOOL:-}
    if [ "$tool" != hdiutil ] && diskutil image >/dev/null 2>&1; then
      # diskutil cannot accept a licence on its own (before macOS 27.2 it
      # shows a dialog and waits), so it attaches a copy without one: a
      # RAW image carries no licence.
      rm -f "$tmp/app.img"
      if diskutil image create from --format RAW "$1" "$tmp/app.img" </dev/null >/dev/null 2>&1 &&
        diskutil image attach --readOnly --nobrowse --mountPoint "$2" "$tmp/app.img" </dev/null >/dev/null; then
        return 0
      fi
      rm -f "$tmp/app.img"
      [ "$tool" != diskutil ] || return 1
    elif [ "$tool" = diskutil ]; then
      return 1
    fi
    # Answering the licence agreement lets attach go on.
    { yes || true; } | PAGER='cat' hdiutil attach -nobrowse -readonly -noautoopen \
      -mountpoint "$2" "$1" >/dev/null
  }

  if [ "$platform" = macos ]; then
    name=$(pick '^[^ ]+_universal\.dmg$')
    dmg=$(download "$name")
    mnt="$tmp/mnt"
    mkdir "$mnt"
    attach_dmg "$dmg" "$mnt" || die "could not open $name"
    if [ ! -d "$mnt/nauvi.app" ]; then
      hdiutil detach -quiet "$mnt" || true
      die "$name has no nauvi.app"
    fi
    dest=$(app_dir)
    mkdir -p "$dest" || {
      hdiutil detach -quiet "$mnt" || true
      die "could not create $dest"
    }
    rm -rf "$dest/.nauvi.app.new"
    if ! ditto "$mnt/nauvi.app" "$dest/.nauvi.app.new"; then
      rm -rf "$dest/.nauvi.app.new"
      hdiutil detach -quiet "$mnt" || true
      die "could not copy nauvi.app to $dest"
    fi
    hdiutil detach -quiet "$mnt" || hdiutil detach -quiet -force "$mnt" || true
    rm -rf "$dest/nauvi.app"
    mv "$dest/.nauvi.app.new" "$dest/nauvi.app"
    say "Installed nauvi ($name) to $dest/nauvi.app"
    say "Start it from Launchpad or with: open \"$dest/nauvi.app\""
    say "The CLI is separate: run this script again with --cli."
    return 0
  fi

  # --- the desktop app: Linux ----------------------------------------------
  case "$arch" in
  x86_64 | amd64) ;;
  *) die "there is no nauvi desktop build for Linux $arch yet; see $releases" ;;
  esac
  nl='
'
  cr=$(printf '\r')
  case "$bin_dir" in
  *"$nl"* | *"$cr"*) die "NAUVI_INSTALL_DIR must not contain a line break (it goes into the desktop entry)" ;;
  *[\"\`\$\\%]*) die "NAUVI_INSTALL_DIR must not contain \" \` \$ \\ or % (it goes into the desktop entry)" ;;
  esac

  name=$(pick '^[^ ]+_amd64\.AppImage$')
  image=$(download "$name")
  chmod 755 "$image"

  # The icons, from the AppImage itself (extracting needs no FUSE).
  icons_found=0
  (cd "$tmp" && "$image" --appimage-extract 'usr/share/icons' >/dev/null 2>&1) || true
  if [ -d "$tmp/squashfs-root/usr/share/icons/hicolor" ]; then
    for s in $icon_sizes; do
      src=$(find "$tmp/squashfs-root/usr/share/icons/hicolor/$s/apps" -name '*.png' 2>/dev/null | head -n1)
      [ -n "$src" ] || continue
      mkdir -p "$data_dir/icons/hicolor/$s/apps"
      cp "$src" "$data_dir/icons/hicolor/$s/apps/nauvi.png"
      icons_found=1
    done
  fi
  [ "$icons_found" -eq 1 ] || warn "found no icon in $name; the menu entry has none"

  put "$image" "$bin_dir/nauvi-desktop"

  mkdir -p "$(dirname "$desktop_file")"
  cat >"$desktop_file.new.$$" <<EOF
[Desktop Entry]
Type=Application
Name=nauvi
Comment=A Lens alternative written in Rust - a Kubernetes IDE
Exec="$bin_dir/nauvi-desktop" %u
TryExec=$bin_dir/nauvi-desktop
Icon=nauvi
StartupWMClass=nauvi-desktop
Terminal=false
Categories=Development;
MimeType=x-scheme-handler/nauvi;
EOF
  mv -f "$desktop_file.new.$$" "$desktop_file"

  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$data_dir/applications" >/dev/null 2>&1 || true
  fi
  if command -v xdg-mime >/dev/null 2>&1; then
    xdg-mime default nauvi.desktop x-scheme-handler/nauvi >/dev/null 2>&1 || true
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    gtk-update-icon-cache -q -t "$data_dir/icons/hicolor" >/dev/null 2>&1 || true
  fi

  say "Installed nauvi ($name) to $bin_dir/nauvi-desktop"
  say "Menu entry: $desktop_file"
  say "The app updates itself; the CLI is separate: run this script again with --cli."

  # The AppImage runtime needs FUSE 2. Only say how to get it; no sudo here.
  fuse=0
  for d in /lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu /lib64 /usr/lib64 /lib /usr/lib; do
    [ -e "$d/libfuse.so.2" ] && fuse=1 && break
  done
  if [ "$fuse" -eq 0 ]; then
    pkg=libfuse2
    if [ -r /etc/os-release ]; then
      id=$(sed -n 's/^ID=//p' /etc/os-release | tr -d '"')
      ver=$(sed -n 's/^VERSION_ID=//p' /etc/os-release | tr -d '"')
      if [ "$id" = ubuntu ] && [ "${ver%%.*}" -ge 24 ] 2>/dev/null; then pkg=libfuse2t64; fi
      if [ "$id" = debian ] && [ "${ver%%.*}" -ge 13 ] 2>/dev/null; then pkg=libfuse2t64; fi
    fi
    warn "the AppImage needs FUSE 2 (libfuse.so.2), which is not installed. On Debian or Ubuntu: sudo apt install $pkg"
  fi
  path_hint
}

nauvi_install "$@"

#!/bin/sh
# Runs install.sh against fake releases (fixtures.sh) on Linux or macOS
# (#430): install, upgrade, both ways of opening the DMG on macOS (#467),
# --cli, a tampered release (must fail and change nothing), refused URLs and
# --uninstall. Everything goes into a temporary HOME; nothing outside it is
# touched.
#
#   scripts/test-install/test.sh            # from anywhere in the repo
set -eu

root=$(cd "$(dirname "$0")/../.." && pwd)
installer="$root/install.sh"
fixtures="$root/scripts/test-install/fixtures.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

sh "$fixtures" "$work/v1" v0.0.1 >/dev/null
sh "$fixtures" "$work/v2" v0.0.2 >/dev/null
sh "$fixtures" "$work/bad" v0.0.3 --tamper >/dev/null

export HOME="$work/home"
mkdir -p "$HOME"
unset XDG_DATA_HOME NAUVI_INSTALL_DIR NAUVI_VERSION || true
export NAUVI_APP_DIR="$HOME/Applications"
bin="$HOME/.local/bin"
data="$HOME/.local/share"

failures=0
pass() { printf 'ok    %s\n' "$*"; }
fail() {
  printf 'FAIL  %s\n' "$*"
  failures=$((failures + 1))
}
check() {
  # $1: description, rest: the command.
  what=$1
  shift
  if "$@"; then pass "$what"; else fail "$what"; fi
}
run() {
  # $1: release dir, rest: install.sh arguments.
  rel=$1
  shift
  NAUVI_DOWNLOAD_BASE="file://$work/$rel" sh "$installer" "$@" >"$work/out" 2>&1
}
has() { grep -q -- "$2" "$1"; }

app_version() {
  case "$(uname -s)" in
  Linux) "$bin/nauvi-desktop" --version ;;
  Darwin) "$NAUVI_APP_DIR/nauvi.app/Contents/MacOS/nauvi-desktop" ;;
  esac
}

# --- the app ---------------------------------------------------------------
check "app install from v1" run v1
cat "$work/out"
check "app is v1" test "$(app_version)" = "nauvi-desktop 0.0.1"
if [ "$(uname -s)" = Linux ]; then
  check "desktop entry exists" test -f "$data/applications/nauvi.desktop"
  check "desktop entry handles nauvi://" has "$data/applications/nauvi.desktop" 'MimeType=x-scheme-handler/nauvi;'
  check "desktop entry starts the AppImage" has "$data/applications/nauvi.desktop" "Exec=\"$bin/nauvi-desktop\" %u"
  check "icon installed" test -f "$data/icons/hicolor/128x128/apps/nauvi.png"
  check "PATH warning" has "$work/out" "is not on your PATH"
fi

check "app upgrade to v2" run v2
check "app is v2" test "$(app_version)" = "nauvi-desktop 0.0.2"

# macOS: both ways of opening the DMG (#467), each without the other as a
# fallback. The fixture DMG has a licence agreement, like the release's.
if [ "$(uname -s)" = Darwin ]; then
  with_tool() {
    # $1: diskutil or hdiutil, $2: release dir.
    NAUVI_TEST_DMG_TOOL=$1 NAUVI_DOWNLOAD_BASE="file://$work/$2" sh "$installer" >"$work/out" 2>&1
  }
  not_mounted() { ! mount | grep -q 'nauvi-install\.'; }
  no_quarantine() { ! xattr -p com.apple.quarantine "$NAUVI_APP_DIR/nauvi.app" >/dev/null 2>&1; }
  if diskutil image >/dev/null 2>&1; then
    check "diskutil image: install v1" with_tool diskutil v1
    cat "$work/out"
    check "diskutil image: app is v1" test "$(app_version)" = "nauvi-desktop 0.0.1"
    check "diskutil image: no deprecation warning" sh -c "! grep -qi deprecated '$work/out'"
    check "diskutil image: DMG detached" not_mounted
    check "diskutil image: no quarantine flag" no_quarantine
  else
    echo "skip  diskutil image: not on macOS $(sw_vers -productVersion)"
  fi
  check "hdiutil: install v2" with_tool hdiutil v2
  cat "$work/out"
  check "hdiutil: app is v2" test "$(app_version)" = "nauvi-desktop 0.0.2"
  check "hdiutil: DMG detached" not_mounted
  check "hdiutil: no quarantine flag" no_quarantine
fi

if run bad; then fail "tampered app release must fail"; else pass "tampered app release fails"; fi
check "tampered: says checksum mismatch" has "$work/out" "checksum mismatch"
check "tampered: app still v2" test "$(app_version)" = "nauvi-desktop 0.0.2"

# --- the CLI ---------------------------------------------------------------
# Through a pipe, the way the one-liner runs it.
if NAUVI_DOWNLOAD_BASE="file://$work/v1" sh -s -- --cli <"$installer" >"$work/out" 2>&1; then
  pass "cli install from v1 (piped)"
else
  fail "cli install from v1 (piped)"
fi
cat "$work/out"
check "cli is v1" test "$("$bin/nauvi" --version)" = "nauvi 0.0.1"
check "cli upgrade to v2" run v2 --cli
check "cli is v2" test "$("$bin/nauvi" --version)" = "nauvi 0.0.2"
if run bad --cli; then fail "tampered cli release must fail"; else pass "tampered cli release fails"; fi
check "tampered: cli still v2" test "$("$bin/nauvi" --version)" = "nauvi 0.0.2"

# A fresh HOME: a tampered release installs nothing at all. (Through env,
# not `VAR=x run`: bash's sh mode keeps such assignments after a function.)
fresh() {
  rel=$1
  shift
  env HOME="$work/fresh" NAUVI_APP_DIR="$work/fresh/Applications" \
    NAUVI_DOWNLOAD_BASE="file://$work/$rel" sh "$installer" "$@" >"$work/out" 2>&1
}
if fresh bad; then fail "tampered (fresh) must fail"; else pass "tampered (fresh) fails"; fi
if fresh bad --cli; then fail "tampered cli (fresh) must fail"; else pass "tampered cli (fresh) fails"; fi
check "tampered (fresh): nothing installed" test ! -e "$work/fresh/.local" -a ! -e "$work/fresh/Applications"

# --- refusals --------------------------------------------------------------
if NAUVI_DOWNLOAD_BASE="http://example.invalid" sh "$installer" --cli >"$work/out" 2>&1; then
  fail "http:// must be refused"
else
  check "http:// refused" has "$work/out" "only https:// is allowed"
fi
if NAUVI_VERSION='v1.0.0/../../x' sh "$installer" --cli >"$work/out" 2>&1; then
  fail "a bad NAUVI_VERSION must be refused"
else
  check "bad NAUVI_VERSION refused" has "$work/out" "NAUVI_VERSION must look like"
fi
# A newline: grep alone would accept the first line.
for v in 'v1.0.0
' 'v1.0.0
/../../x'; do
  if NAUVI_VERSION="$v" sh "$installer" --cli >"$work/out" 2>&1; then
    fail "NAUVI_VERSION with a newline must be refused"
  else
    check "NAUVI_VERSION with a newline refused" has "$work/out" "NAUVI_VERSION must look like"
  fi
done
if [ "$(uname -s)" = Linux ]; then
  for d in "$work/a
b" "$work/a$(printf '\r')b"; do
    if NAUVI_INSTALL_DIR="$d" NAUVI_DOWNLOAD_BASE="file://$work/v2" sh "$installer" >"$work/out" 2>&1; then
      fail "an install dir with a line break must be refused"
    else
      check "install dir with a line break refused" has "$work/out" "must not contain a line break"
    fi
  done
fi
if sh "$installer" --bogus >"$work/out" 2>&1; then fail "unknown option must fail"; else pass "unknown option fails"; fi

# --- uninstall -------------------------------------------------------------
check "uninstall" sh "$installer" --uninstall
check "uninstall: cli gone" test ! -e "$bin/nauvi"
check "uninstall: app gone" test ! -e "$bin/nauvi-desktop" -a ! -e "$NAUVI_APP_DIR/nauvi.app"
check "uninstall: desktop entry gone" test ! -e "$data/applications/nauvi.desktop"
check "uninstall: icons gone" test ! -e "$data/icons/hicolor/128x128/apps/nauvi.png"
check "uninstall again is fine" sh "$installer" --uninstall

if [ "$failures" -ne 0 ]; then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all install.sh checks passed"

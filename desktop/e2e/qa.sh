#!/usr/bin/env bash
# Run QA scenarios against the real app on WebKitGTK, without sudo.
#
# Usage: desktop/e2e/qa.sh [options] [scenario...]
#
#   scenario      a file in desktop/e2e/qa/ (`terminal`, `qa/terminal.test.mjs`
#                 and a path all work). None: every qa/*.test.mjs.
#   --out DIR     where screenshots, page text, app logs and the report go
#                 (default: desktop/e2e/artifacts/qa-<date>-<time>)
#   --no-build    use the app that is already built
#   --shard I/N   run only shard I of N: the files split into N parts of about
#                 the same run time (lib/shard.mjs, weights in qa-weights.json)
#   --tools-only  fetch the tools, print their paths and exit
#
# Tools come from the system when it has them, otherwise they are fetched
# once into ~/.cache/kubeloupe-qa (KUBELOUPE_QA_CACHE):
#   WebKitWebDriver  webkit2gtk-driver / webkitgtk-webdriver .deb (apt-get download)
#   Xvfb             xvfb .deb (apt-get download)
#   tauri-driver     cargo install --root <cache>
#   helm             get.helm.sh tarball (for the Helm scenarios)
#   xclip            xclip .deb, if neither xclip nor xsel is installed
# Set WEBKIT_DRIVER, XVFB, TAURI_DRIVER or HELM to use your own.
#
# Everything started here (Xvfb, tauri-driver, WebKitWebDriver, the app) is
# stopped on exit, and a control plane paused by a scenario is unpaused.

set -euo pipefail

E2E="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$E2E/../.." && pwd)"
CACHE="${KUBELOUPE_QA_CACHE:-$HOME/.cache/kubeloupe-qa}"
TAURI_DRIVER_VERSION="${TAURI_DRIVER_VERSION:-2.1.0}"
HELM_VERSION="${HELM_VERSION:-v3.16.4}"

OUT=""
BUILD=1
TOOLS_ONLY=0
SHARD=""
SCENARIOS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift ;;
    --out=*) OUT="${1#--out=}" ;;
    --no-build) BUILD=0 ;;
    --shard) SHARD="$2"; shift ;;
    --shard=*) SHARD="${1#--shard=}" ;;
    --tools-only) TOOLS_ONLY=1 ;;
    -h|--help) sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "qa.sh: unknown option $1" >&2; exit 2 ;;
    *) SCENARIOS+=("$1") ;;
  esac
  shift
done

log() { echo "qa.sh: $*" >&2; }
die() { log "$*"; exit 1; }

# --- Tools -------------------------------------------------------------------

# Download one .deb (the first package name that exists) into a scratch dir
# and unpack it into $2. $3.. are candidate "name" or "name=version" specs.
fetch_deb() {
  local dest="$1"; shift
  command -v apt-get >/dev/null || die "no apt-get: install $* yourself and set the env variable (see --help)"
  local tmp; tmp="$(mktemp -d)"
  local spec ok=0
  for spec in "$@"; do
    if (cd "$tmp" && apt-get download "$spec" >/dev/null 2>&1); then ok=1; break; fi
  done
  if [ "$ok" = 0 ]; then
    rm -rf "$tmp"
    die "could not download any of: $* (is the apt package list up to date? try a user-level 'apt-get update' or install it)"
  fi
  mkdir -p "$dest"
  local deb
  for deb in "$tmp"/*.deb; do dpkg-deb -x "$deb" "$dest"; done
  rm -rf "$tmp"
}

pkg_version() { dpkg-query -W -f='${Version}' "$1" 2>/dev/null || true; }

find_webkit_driver() {
  if [ -n "${WEBKIT_DRIVER:-}" ]; then echo "$WEBKIT_DRIVER"; return; fi
  if command -v WebKitWebDriver >/dev/null; then command -v WebKitWebDriver; return; fi
  # Must match the installed WebKitGTK, so the cache is keyed by its version.
  local v; v="$(pkg_version libwebkit2gtk-4.1-0)"
  [ -n "$v" ] || v="$(pkg_version libwebkitgtk-6.0-4)"
  [ -n "$v" ] || die "WebKitGTK (libwebkit2gtk-4.1-0) is not installed; see the README's Linux dependencies"
  local root="$CACHE/webkit-driver-${v//[:~]/_}"
  if [ ! -x "$root/usr/bin/WebKitWebDriver" ]; then
    log "fetching WebKitWebDriver $v into $root"
    fetch_deb "$root" "webkit2gtk-driver=$v" "webkitgtk-webdriver=$v"
  fi
  [ -x "$root/usr/bin/WebKitWebDriver" ] || die "the driver package has no usr/bin/WebKitWebDriver"
  echo "$root/usr/bin/WebKitWebDriver"
}

find_xvfb() {
  if [ -n "${XVFB:-}" ]; then echo "$XVFB"; return; fi
  if command -v Xvfb >/dev/null; then command -v Xvfb; return; fi
  # Same version as the installed X server bits (xserver-common), if any.
  local v; v="$(pkg_version xserver-common)"
  local root="$CACHE/xvfb-${v:-latest}"
  root="${root//[:~]/_}"
  if [ ! -x "$root/usr/bin/Xvfb" ]; then
    log "fetching Xvfb ${v:-latest} into $root"
    if [ -n "$v" ]; then fetch_deb "$root" "xvfb=$v" xvfb; else fetch_deb "$root" xvfb; fi
  fi
  local missing; missing="$(ldd "$root/usr/bin/Xvfb" | grep 'not found' || true)"
  [ -z "$missing" ] || die "Xvfb needs libraries that are not installed: $missing"
  command -v xkbcomp >/dev/null || [ -x /usr/bin/xkbcomp ] || die "Xvfb needs xkbcomp (package x11-xkb-utils)"
  echo "$root/usr/bin/Xvfb"
}

find_tauri_driver() {
  if [ -n "${TAURI_DRIVER:-}" ]; then echo "$TAURI_DRIVER"; return; fi
  if command -v tauri-driver >/dev/null; then command -v tauri-driver; return; fi
  local root="$CACHE/tauri-driver-$TAURI_DRIVER_VERSION"
  if [ ! -x "$root/bin/tauri-driver" ]; then
    log "building tauri-driver $TAURI_DRIVER_VERSION into $root (once)"
    CARGO_TARGET_DIR="$CACHE/cargo-target" cargo install tauri-driver --locked \
      --version "$TAURI_DRIVER_VERSION" --root "$root" >&2
    rm -rf "$CACHE/cargo-target"
  fi
  echo "$root/bin/tauri-driver"
}

find_helm() {
  if [ -n "${HELM:-}" ]; then echo "$HELM"; return; fi
  if command -v helm >/dev/null; then command -v helm; return; fi
  local root="$CACHE/helm-$HELM_VERSION"
  if [ ! -x "$root/helm" ]; then
    log "fetching helm $HELM_VERSION into $root"
    local tmp; tmp="$(mktemp -d)"
    if curl -fsSL "https://get.helm.sh/helm-$HELM_VERSION-linux-amd64.tar.gz" -o "$tmp/helm.tgz"; then
      mkdir -p "$root"
      tar -xzf "$tmp/helm.tgz" -C "$tmp" linux-amd64/helm
      mv "$tmp/linux-amd64/helm" "$root/helm"
    fi
    rm -rf "$tmp"
  fi
  # Optional: only the Helm scenarios need it.
  if [ -x "$root/helm" ]; then echo "$root/helm"; fi
}

# Optional: the clipboard helper reads the Xvfb clipboard with xclip (or xsel)
# and falls back to a page hook without it.
find_xclip() {
  if command -v xclip >/dev/null || command -v xsel >/dev/null; then return; fi
  local root="$CACHE/xclip"
  [ -x "$root/usr/bin/xclip" ] || (fetch_deb "$root" xclip) >/dev/null 2>&1 || true
  if [ -x "$root/usr/bin/xclip" ]; then echo "$root/usr/bin"; fi
}

mkdir -p "$CACHE"
WEBKIT_DRIVER="$(find_webkit_driver)"
XVFB="$(find_xvfb)"
TAURI_DRIVER="$(find_tauri_driver)"
HELM="$(find_helm || true)"
export WEBKIT_DRIVER TAURI_DRIVER
if [ -n "$HELM" ]; then export PATH="$(dirname "$HELM"):$PATH"; fi
XCLIP_DIR="$(find_xclip || true)"
if [ -n "$XCLIP_DIR" ]; then export PATH="$XCLIP_DIR:$PATH"; fi

if [ "$TOOLS_ONLY" = 1 ]; then
  printf 'WEBKIT_DRIVER=%s\nXVFB=%s\nTAURI_DRIVER=%s\nHELM=%s\n' "$WEBKIT_DRIVER" "$XVFB" "$TAURI_DRIVER" "$HELM"
  exit 0
fi

# --- Build -------------------------------------------------------------------

if [ "$BUILD" = 1 ]; then
  log "building the app (frontend embedded)"
  [ -d "$REPO/desktop/ui-src/node_modules" ] || npm --prefix "$REPO/desktop/ui-src" ci --no-audit --no-fund
  npm --prefix "$REPO/desktop/ui-src" run build
  (cd "$REPO" && cargo build -p kubeloupe-desktop --features tauri/custom-protocol)
fi
[ -d "$E2E/node_modules" ] || npm --prefix "$E2E" ci --no-audit --no-fund

# --- Scenarios ---------------------------------------------------------------

FILES=()
if [ ${#SCENARIOS[@]} -eq 0 ]; then
  for f in "$E2E"/qa/*.test.mjs; do FILES+=("$f"); done
else
  for s in "${SCENARIOS[@]}"; do
    for f in "$s" "$E2E/$s" "$E2E/qa/$s" "$E2E/qa/$s.test.mjs"; do
      if [ -f "$f" ]; then FILES+=("$(cd "$(dirname "$f")" && pwd)/$(basename "$f")"); continue 2; fi
    done
    die "no scenario $s (looked in $E2E/qa)"
  done
fi
if [ -n "$SHARD" ]; then
  picked="$(node "$E2E/lib/shard.mjs" "$SHARD" "${FILES[@]}")" || die "bad --shard $SHARD (want I/N)"
  FILES=()
  if [ -n "$picked" ]; then mapfile -t FILES <<< "$picked"; fi
  log "shard $SHARD: ${#FILES[@]} file(s): $(for f in "${FILES[@]}"; do basename "$f" .test.mjs; done | tr '\n' ' ')"
  [ ${#FILES[@]} -gt 0 ] || { log "shard $SHARD is empty"; exit 0; }
fi

OUT="${OUT:-$E2E/artifacts/qa-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
# The scenarios record what to clean up here (process groups, paused
# containers); the trap below reads it.
export QA_RUN_DIR="$OUT/.run"
mkdir -p "$QA_RUN_DIR"
export E2E_ARTIFACTS="$OUT"

XVFB_PID=""
cleanup() {
  local rc=$?
  set +e
  # A paused control plane must never be left behind (the cluster is shared).
  for f in "$QA_RUN_DIR"/paused-*; do
    [ -f "$f" ] || continue
    log "unpausing $(cat "$f")"
    docker unpause "$(cat "$f")" >/dev/null 2>&1
    rm -f "$f"
  done
  for f in "$QA_RUN_DIR"/pgid-*; do
    [ -f "$f" ] || continue
    kill -KILL -- "-$(cat "$f")" 2>/dev/null
    rm -f "$f"
  done
  if [ -n "$XVFB_PID" ]; then kill "$XVFB_PID" 2>/dev/null; wait "$XVFB_PID" 2>/dev/null; fi
  rm -rf "$QA_RUN_DIR"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A private X server: the app's windows never show on your desktop, and its
# clipboard is separate from yours. Xvfb picks a free display number.
DISPLAY_FILE="$QA_RUN_DIR/display"
"$XVFB" -displayfd 3 -screen 0 "${QA_SCREEN:-1600x1000x24}" -nolisten tcp -noreset \
  > "$OUT/xvfb.log" 2>&1 3> "$DISPLAY_FILE" &
XVFB_PID=$!
for _ in $(seq 1 100); do
  [ -s "$DISPLAY_FILE" ] && break
  kill -0 "$XVFB_PID" 2>/dev/null || die "Xvfb did not start, see $OUT/xvfb.log"
  sleep 0.1
done
[ -s "$DISPLAY_FILE" ] || die "Xvfb did not report a display, see $OUT/xvfb.log"
export DISPLAY=":$(tr -d '[:space:]' < "$DISPLAY_FILE")"
# Use X11 (Xvfb) even from a Wayland desktop session.
unset WAYLAND_DISPLAY
export GDK_BACKEND=x11
log "Xvfb on $DISPLAY, output in $OUT"

# A free port for tauri-driver (and the next one for WebKitWebDriver), so
# runs in other worktrees don't collide.
if [ -z "${E2E_DRIVER_PORT:-}" ]; then
  E2E_DRIVER_PORT="$(node -e '
    const net = require("node:net");
    const tryPort = (p) => { const s = net.createServer(); s.once("error", () => tryPort(p + 2));
      s.listen(p + 1, "127.0.0.1", () => { s.close(() => { const t = net.createServer();
        t.once("error", () => tryPort(p + 2)); t.listen(p, "127.0.0.1", () => t.close(() => console.log(p))); }); }); };
    tryPort(4600 + Math.floor(Math.random() * 300) * 2);')"
fi
export E2E_DRIVER_PORT

set +e
(cd "$E2E" && node --test --test-concurrency=1 \
  --test-reporter=spec --test-reporter-destination=stdout \
  --test-reporter=./lib/qa-reporter.mjs --test-reporter-destination="$OUT/results.jsonl" \
  "${FILES[@]}") 2>&1 | tee "$OUT/run.log"
RC=${PIPESTATUS[0]}
set -e
node "$E2E/lib/qa-report.mjs" "$OUT" > "$OUT/report.md" || true
log "report: $OUT/report.md"
exit "$RC"

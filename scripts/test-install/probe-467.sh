#!/bin/sh
# Temporary (#467): what diskutil image attach does on the CI runner.
set -u
[ "$(uname -s)" = Darwin ] || exit 0
echo "=== sw_vers"
sw_vers
echo "=== diskutil image"
diskutil image 2>&1 | head -40
echo "=== diskutil image attach (no args)"
diskutil image attach 2>&1 | head -60
echo "=== diskutil image attach --help"
diskutil image attach --help 2>&1 | head -60
echo "=== diskutil image detach (no args)"
diskutil image detach 2>&1 | head -30
echo "=== man diskutil (image part)"
man diskutil 2>/dev/null | col -b | awk '/^ *image/ {p=1} p' | head -250
echo "=== hdiutil attach deprecation?"
w=$(mktemp -d)
sh "$(dirname "$0")/fixtures.sh" "$w/rel" v0.0.9 >/dev/null || echo "fixtures failed"
dmg=$(ls "$w"/rel/*.dmg)
hdiutil imageinfo "$dmg" | grep -i licen
try() {
  # $1: label, rest: command; killed after 20 s.
  label=$1
  shift
  echo "=== try: $label"
  mkdir -p "$w/m"
  perl -e 'alarm 20; exec @ARGV' "$@" 2>&1
  echo "exit: $?"
  ls "$w/m" 2>&1
  mount | grep "$w/m" || true
  hdiutil detach -quiet "$w/m" 2>/dev/null || diskutil image detach "$w/m" 2>/dev/null || true
}
try "diskutil stdin null" sh -c "diskutil image attach --readOnly --nobrowse --mountPoint '$w/m' '$dmg' </dev/null"
try "diskutil yes" sh -c "yes | PAGER=cat diskutil image attach --readOnly --nobrowse --mountPoint '$w/m' '$dmg'"
try "diskutil mountOptions" sh -c "yes | PAGER=cat diskutil image attach --readOnly --mountOptions nobrowse --mountPoint '$w/m' '$dmg'"
try "hdiutil yes" sh -c "yes | PAGER=cat hdiutil attach -nobrowse -readonly -noautoopen -mountpoint '$w/m' '$dmg'"
try "diskutil yes plist" sh -c "yes | PAGER=cat diskutil image attach --readOnly --nobrowse --plist --mountPoint '$w/m' '$dmg'"
rm -rf "$w"
echo "=== probe done"

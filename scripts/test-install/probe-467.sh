#!/bin/sh
# Temporary (#467): what diskutil image attach does on the CI runner.
set -u
[ "$(uname -s)" = Darwin ] || exit 0
sw_vers
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
for fmt in RAW UDRO UDZO; do
  rm -f "$w/c.img" "$w/c.dmg"
  out="$w/c.img"; [ "$fmt" = RAW ] || out="$w/c.dmg"
  try "create from $fmt" sh -c "diskutil image create from --format $fmt '$dmg' '$out' </dev/null; ls -l '$out'; hdiutil imageinfo '$out' | grep -i licen"
  try "attach converted $fmt" sh -c "time diskutil image attach --readOnly --nobrowse --mountPoint '$w/m' '$out' </dev/null"
  try "attach converted $fmt plist" sh -c "diskutil image --plist attach --readOnly --nobrowse --mountPoint '$w/m' '$out' </dev/null | head -40"
done
try "diskutil info licensed" sh -c "diskutil image info '$dmg' </dev/null | head -30"
try "diskutil eject" sh -c "diskutil image attach --readOnly --nobrowse --mountPoint '$w/m' '$w/c.dmg' </dev/null && diskutil eject '$w/m'; echo eject=\$?; mount | grep '$w/m' || echo gone"
rm -rf "$w"
echo "=== probe done"

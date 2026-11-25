#!/bin/sh
# Writes a fake nauvi release for testing install.sh and install.ps1 (#430):
# the same file names as a real one (see .github/workflows/release.yml) and a
# SHA256SUMS, but the "binaries" are tiny shell scripts that print the version.
#
#   scripts/test-install/fixtures.sh <dir> <tag> [--tamper]
#
# --tamper changes the assets after SHA256SUMS is written, so every checksum
# check must fail. The macOS .dmg is only written where hdiutil exists, the
# Windows CLI .zip where python3 exists.
set -eu

[ $# -ge 2 ] || {
  echo "usage: $0 <dir> <tag> [--tamper]" >&2
  exit 2
}
dir=$1
tag=$2
tamper=${3:-}
ver=${tag#v}
mkdir -p "$dir"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# A fake AppImage: --version, and --appimage-extract of the icons like the
# real AppImage runtime (into ./squashfs-root).
cat >"$dir/nauvi_${ver}_amd64.AppImage" <<SH
#!/bin/sh
case "\${1:-}" in
--version) echo "nauvi-desktop $ver" ;;
--appimage-extract)
  for s in 32x32 128x128; do
    mkdir -p "squashfs-root/usr/share/icons/hicolor/\$s/apps"
    printf 'fake png $ver %s\n' "\$s" >"squashfs-root/usr/share/icons/hicolor/\$s/apps/nauvi-desktop.png"
  done ;;
*) echo "fake nauvi desktop $ver" ;;
esac
SH
chmod 755 "$dir/nauvi_${ver}_amd64.AppImage"

for target in x86_64-unknown-linux-gnu aarch64-apple-darwin x86_64-apple-darwin; do
  name="nauvi-cli-$tag-$target"
  mkdir -p "$work/$name"
  printf '#!/bin/sh\necho "nauvi %s"\n' "$ver" >"$work/$name/nauvi"
  chmod 755 "$work/$name/nauvi"
  echo "fixture" >"$work/$name/README.md"
  tar -czf "$dir/$name.tar.gz" -C "$work" "$name"
done

if command -v python3 >/dev/null 2>&1; then
  name="nauvi-cli-$tag-x86_64-pc-windows-msvc"
  python3 - "$dir/$name.zip" "$name" "$ver" <<'PY'
import sys, zipfile
out, name, ver = sys.argv[1:]
with zipfile.ZipFile(out, "w") as z:
    z.writestr(f"{name}/nauvi.exe", f"fake nauvi.exe {ver}\n")
    z.writestr(f"{name}/README.md", "fixture\n")
PY
fi

if command -v hdiutil >/dev/null 2>&1; then
  app="$work/dmg/nauvi.app/Contents"
  mkdir -p "$app/MacOS"
  cat >"$app/Info.plist" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>nauvi-desktop</string>
<key>CFBundleIdentifier</key><string>com.nauvi.app</string>
<key>CFBundleShortVersionString</key><string>$ver</string>
</dict></plist>
PL
  printf '#!/bin/sh\necho "nauvi-desktop %s"\n' "$ver" >"$app/MacOS/nauvi-desktop"
  chmod 755 "$app/MacOS/nauvi-desktop"
  hdiutil create -quiet -volname nauvi -srcfolder "$work/dmg" -format UDZO \
    -ov "$dir/nauvi_${ver}_universal.dmg"
  # A licence agreement, like the release DMG (#210, #467): install.sh must
  # accept it without asking.
  printf 'Fixture licence %s.\nPress Agree to go on.\n' "$ver" >"$work/license.txt"
  base64 <"$work/license.txt" | tr -d '\n' | fold -w 52 >"$work/license.b64"
  awk -v f="$work/license.b64" '$0 == "@EULA_DATA@" { while ((getline l <f) > 0) print "\t\t\t" l; next } { print }' \
    "$(dirname "$0")/eula-resources.xml" >"$work/eula.xml"
  hdiutil udifrez -xml "$work/eula.xml" '' -quiet "$dir/nauvi_${ver}_universal.dmg"
  hdiutil imageinfo "$dir/nauvi_${ver}_universal.dmg" | grep -q 'Software License Agreement: true' || {
    echo "the fixture DMG has no licence agreement" >&2
    exit 1
  }
fi

rm -f "$dir/SHA256SUMS"
if command -v sha256sum >/dev/null 2>&1; then
  (cd "$dir" && sha256sum -- *) >"$work/sums"
else
  (cd "$dir" && shasum -a 256 -- *) >"$work/sums"
fi
mv "$work/sums" "$dir/SHA256SUMS"

if [ "$tamper" = --tamper ]; then
  for f in "$dir"/*; do
    [ "$(basename "$f")" = SHA256SUMS ] || printf 'tampered\n' >>"$f"
  done
fi
echo "fixture release $tag in $dir:"
cat "$dir/SHA256SUMS"

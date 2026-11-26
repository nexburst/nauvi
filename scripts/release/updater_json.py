#!/usr/bin/env python3
"""Write the updater's latest.json (#30) from a release's assets.

The release workflow's publish job runs this once the `sign` job has signed
every update bundle (#245), from all the .sig files at once.

    updater_json.py --assets DIR --repo OWNER/REPO --tag vX.Y.Z \
        --out DIR/latest.json

Fails if a platform the app supports has no signed update bundle.
"""

import argparse
import datetime
import fnmatch
import json
import os
import sys

# Target keys (as tauri-plugin-updater looks them up: `{os}-{arch}-{bundle}`,
# then `{os}-{arch}`) and the asset that updates them. The plain
# `{os}-{arch}` keys use what tauri-action used to pick: the AppImage, the
# universal .app and the MSI.
REQUIRED = {
    "linux-x86_64": "*.AppImage",
    "linux-x86_64-appimage": "*.AppImage",
    "darwin-aarch64": "*_universal.app.tar.gz",
    "darwin-x86_64": "*_universal.app.tar.gz",
    "darwin-aarch64-app": "*_universal.app.tar.gz",
    "darwin-x86_64-app": "*_universal.app.tar.gz",
    "darwin-universal": "*_universal.app.tar.gz",
    "darwin-universal-app": "*_universal.app.tar.gz",
    "windows-x86_64": "*.msi",
    "windows-x86_64-msi": "*.msi",
    "windows-x86_64-nsis": "*-setup.exe",
}
# Added when they are signed (the app then installs .deb updates); the
# release signs the .deb and builds no .rpm.
OPTIONAL = {
    "linux-x86_64-deb": "*.deb",
    "linux-x86_64-rpm": "*.rpm",
}


def find_one(names, pattern):
    hits = sorted(n for n in names if fnmatch.fnmatchcase(n, pattern))
    if len(hits) > 1:
        raise SystemExit(f"error: more than one asset matches {pattern}: {hits}")
    return hits[0] if hits else None


def build(assets_dir, repo, tag, version, notes, now):
    names = set(os.listdir(assets_dir))
    platforms, missing = {}, []
    for table, required in ((REQUIRED, True), (OPTIONAL, False)):
        for key, pattern in table.items():
            bundle = find_one(names, pattern)
            if bundle is None or f"{bundle}.sig" not in names:
                if required:
                    missing.append(f"{key} ({pattern} and its .sig)")
                continue
            with open(os.path.join(assets_dir, f"{bundle}.sig"), encoding="utf-8") as f:
                signature = f.read().strip()
            platforms[key] = {
                "signature": signature,
                "url": f"https://github.com/{repo}/releases/download/{tag}/{bundle}",
            }
    if missing:
        raise SystemExit("error: no signed update for " + ", ".join(missing))
    return {
        "version": version,
        "notes": notes,
        "pub_date": now,
        "platforms": dict(sorted(platforms.items())),
    }


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--assets", required=True)
    p.add_argument("--repo", required=True)
    p.add_argument("--tag", required=True)
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)

    version = a.tag[1:] if a.tag.startswith("v") else a.tag
    notes = f"See https://github.com/{a.repo}/releases/tag/{a.tag}"
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ours = build(a.assets, a.repo, a.tag, version, notes, now)

    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(ours, f, indent=2)
        f.write("\n")
    print(json.dumps(ours, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

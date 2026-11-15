#!/usr/bin/env python3
"""Write the updater's latest.json (#30) from a release's assets.

The release workflow's publish job runs this once every bundle is uploaded.
tauri-action also uploads a latest.json, but each matrix job reads, extends
and re-uploads it in parallel, so one platform can overwrite another's entry.
Writing it here from all the .sig files at once is deterministic; when
tauri-action's file is passed with --check, every entry it has must carry
the same signature as ours.

    updater_json.py --assets DIR --repo OWNER/REPO --tag vX.Y.Z \
        [--check tauri-action-latest.json] --out DIR/latest.json

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
# `{os}-{arch}` keys use what tauri-action picks: the AppImage, the
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
# Added when the bundler signed them (the app then installs .deb updates).
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


def check_against(ours, theirs):
    """tauri-action's entries must match ours; it may lack some (the race)."""
    problems = []
    for key, entry in (theirs.get("platforms") or {}).items():
        mine = ours["platforms"].get(key)
        if mine is None:
            print(f"::warning::{key} is in tauri-action's latest.json but not a target here; left out")
        elif entry.get("signature", "").strip() != mine["signature"]:
            problems.append(f"{key}: tauri-action's signature differs from {mine['url']}.sig")
    if theirs.get("version") not in (None, ours["version"]):
        problems.append(f"version: tauri-action wrote {theirs.get('version')}, expected {ours['version']}")
    lost = sorted(set(ours["platforms"]) - set(theirs.get("platforms") or {}))
    return problems, lost


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--assets", required=True)
    p.add_argument("--repo", required=True)
    p.add_argument("--tag", required=True)
    p.add_argument("--check")
    p.add_argument("--out", required=True)
    a = p.parse_args(argv)

    version = a.tag[1:] if a.tag.startswith("v") else a.tag
    notes = f"See https://github.com/{a.repo}/releases/tag/{a.tag}"
    now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    ours = build(a.assets, a.repo, a.tag, version, notes, now)

    if a.check:
        with open(a.check, encoding="utf-8") as f:
            theirs = json.load(f)
        problems, lost = check_against(ours, theirs)
        if problems:
            for msg in problems:
                print(f"::error::latest.json mismatch: {msg}")
            return 1
        if lost:
            print(f"::warning::tauri-action's latest.json lacked {', '.join(lost)} (parallel uploads); added them")

    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(ours, f, indent=2)
        f.write("\n")
    print(json.dumps(ours, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Write a release's version and SHA-256s into the Homebrew tap's files.

    homebrew_tap.py --version 0.2.0 --sums SHA256SUMS \
        tap/Casks/kubeloupe.rb tap/Formula/kubeloupe-cli.rb

In each file it replaces the `version "..."` line, the old version in every
`url "..."` line, and then every `sha256 "..."` line with the checksum (from
SHA256SUMS) of the asset its url names. The n-th sha256 line belongs to the
n-th url line (a cask has sha256 before url, a formula after; both pair up in
order). It fails if a file has no version line, if the counts differ or if an
asset is not in SHA256SUMS, so a changed asset name can't publish a broken tap.
"""

import argparse
import re
import sys
from pathlib import Path

VERSION_RE = re.compile(r'^(\s*version\s+")([^"]+)(")', re.M)
URL_RE = re.compile(r'^(\s*url\s+")([^"]+)(")', re.M)
SHA_RE = re.compile(r'^(\s*sha256\s+")([0-9a-f]{64})(")', re.M)


def read_sums(path):
    sums = {}
    for line in Path(path).read_text().splitlines():
        if line.strip():
            digest, name = line.split(maxsplit=1)
            sums[name.lstrip("*")] = digest
    return sums


def update(text, version, sums):
    m = VERSION_RE.search(text)
    if not m:
        raise ValueError('no `version "..."` line')
    old = m.group(2)
    text = VERSION_RE.sub(lambda m: m.group(1) + version + m.group(3), text, count=1)
    text = URL_RE.sub(lambda m: m.group(1) + m.group(2).replace(old, version) + m.group(3), text)

    assets = []
    for m in URL_RE.finditer(text):
        url = m.group(2).replace("#{version}", version)
        assets.append(url.rsplit("/", 1)[-1])
    shas = SHA_RE.findall(text)
    if len(assets) != len(shas) or not assets:
        raise ValueError(f"{len(assets)} url lines but {len(shas)} sha256 lines")
    missing = [a for a in assets if a not in sums]
    if missing:
        raise ValueError(f"not in SHA256SUMS: {', '.join(missing)}")

    it = iter(assets)
    return SHA_RE.sub(lambda m: m.group(1) + sums[next(it)] + m.group(3), text), assets


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--version", required=True, help="release version, without the v")
    p.add_argument("--sums", required=True, help="the release's SHA256SUMS")
    p.add_argument("files", nargs="+", type=Path)
    args = p.parse_args()
    sums = read_sums(args.sums)
    failed = False
    for f in args.files:
        try:
            text, assets = update(f.read_text(), args.version, sums)
        except (OSError, ValueError) as e:
            print(f"::error::{f}: {e}", file=sys.stderr)
            failed = True
            continue
        f.write_text(text)
        print(f"{f}: {args.version} ({', '.join(assets)})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

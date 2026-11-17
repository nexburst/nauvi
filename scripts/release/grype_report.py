#!/usr/bin/env python3
"""Summarise Grype JSON reports and gate the release on them (#341).

Each argument is a `grype -o json` report. Prints a Markdown report (for the
job summary) and exits 1 when any finding is High or Critical *and* has a fix
(fix state "fixed"): those block the release. Everything else (Medium and
below, or no fix yet) is reported only.

    grype_report.py scan/*.json >> "$GITHUB_STEP_SUMMARY"
"""

import json
import os
import sys

BLOCKING = {"Critical", "High"}
ORDER = ["Critical", "High", "Medium", "Low", "Negligible", "Unknown"]


def findings(path):
    with open(path, encoding="utf-8") as f:
        report = json.load(f)
    target = os.path.splitext(os.path.basename(path))[0]
    for m in report.get("matches") or []:
        vuln = m.get("vulnerability", {})
        art = m.get("artifact", {})
        fix = vuln.get("fix", {}) or {}
        yield {
            "target": target,
            "id": vuln.get("id", "?"),
            "severity": vuln.get("severity", "Unknown") or "Unknown",
            "package": art.get("name", "?"),
            "version": art.get("version", "?"),
            "type": art.get("type", "?"),
            "fixed": fix.get("state") == "fixed",
            "fix": ", ".join(fix.get("versions") or []) or fix.get("state", "unknown"),
        }


def is_blocking(f):
    return f["severity"] in BLOCKING and f["fixed"]


def table(rows):
    out = ["| Target | Severity | Vulnerability | Package | Fix |", "| --- | --- | --- | --- | --- |"]
    for f in rows:
        out.append(
            f"| {f['target']} | {f['severity']} | {f['id']} | {f['package']} {f['version']} ({f['type']}) | {f['fix']} |"
        )
    return "\n".join(out)


def main(paths):
    if not paths:
        print("usage: grype_report.py REPORT.json...", file=sys.stderr)
        return 2
    all_rows = []
    targets = []
    for p in paths:
        rows = list(findings(p))
        targets.append((os.path.splitext(os.path.basename(p))[0], rows))
        all_rows.extend(rows)
    rank = {s: i for i, s in enumerate(ORDER)}
    all_rows.sort(key=lambda f: (rank.get(f["severity"], len(ORDER)), f["target"], f["id"]))
    blocking = [f for f in all_rows if is_blocking(f)]

    print("## Vulnerability scan (Grype)\n")
    print("| Target | " + " | ".join(ORDER) + " | Blocking |")
    print("| --- |" + " ---: |" * (len(ORDER) + 1))
    for name, rows in targets:
        counts = [sum(1 for f in rows if f["severity"] == s) for s in ORDER]
        print(f"| {name} | " + " | ".join(map(str, counts)) + f" | {sum(1 for f in rows if is_blocking(f))} |")
    print()
    if blocking:
        print(f"**{len(blocking)} High/Critical finding(s) with a fix: the release is blocked.**\n")
        print(table(blocking))
        print()
    else:
        print("No High or Critical finding with a fix.\n")
    rest = [f for f in all_rows if not is_blocking(f)]
    if rest:
        print(f"<details><summary>{len(rest)} other finding(s), reported only</summary>\n")
        print(table(rest))
        print("\n</details>\n")
    for f in blocking:
        print(
            f"::error::{f['id']} ({f['severity']}) in {f['package']} {f['version']} [{f['target']}], fixed in {f['fix']}",
            file=sys.stderr,
        )
    return 1 if blocking else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

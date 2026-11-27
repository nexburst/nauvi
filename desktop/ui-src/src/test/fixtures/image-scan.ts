// The local scanner (#536): what the fake finds on this computer and what
// a scan of each image finds. `FakeCluster.imageScan` overrides it.

import type { ScannerKind, ScannerStatus, Vulnerability } from "../../lib/bindings";

export interface FakeImageScan {
  /** The scanner the fake finds, per kind (absent: not installed). */
  found: Partial<
    Record<
      ScannerKind,
      {
        path: string;
        version: string;
        db: string;
        from?: string;
        sha256?: string;
        /** A Trivy whose file names no version (#561): refused before it runs. */
        unversioned?: boolean;
      }
    >
  >;
  /** Approved paths by kind. */
  approved: Partial<Record<ScannerKind, string>>;
  /** Paths that changed since they were approved. */
  changed: string[];
  /** What a scan finds, by image (default: `defaultVulns`). */
  vulns: Record<string, Vulnerability[]>;
  /** Images whose scan fails, with the error. */
  errors: Record<string, string>;
  /** How long a scan takes, ms. */
  delayMs: number;
  /** Scans kept, by `scanner@digest`: unix seconds. */
  scanned: Record<string, { at: number; image: string }>;
  /** The images scanned (each call), for the tests. */
  calls: string[];
}

const v = (id: string, pkg: string, installed: string, severity: Vulnerability["severity"], fixed: string): Vulnerability => ({
  id,
  package: pkg,
  installed_version: installed,
  fixed_version: fixed,
  severity,
  score: 0,
  title: `${pkg} issue`,
  link: `https://avd.aquasec.com/nvd/${id.toLowerCase()}`,
  exploit: { kev: false, epss: 0, epss_percentile: 0, risk: 0 },
});

export const defaultVulns: Vulnerability[] = [
  v("CVE-2026-7001", "openssl", "3.0.11-1", "critical", "3.0.15-1"),
  v("CVE-2026-7002", "curl", "7.88.1-10", "high", ""),
  v("CVE-2026-7003", "zlib1g", "1.2.13", "low", ""),
];

export function imageScanFixture(): FakeImageScan {
  return {
    found: { trivy: { path: "/usr/local/bin/trivy", version: "0.58.1", db: "2026-11-25T06:13:33Z" } },
    approved: {},
    changed: [],
    vulns: { "busybox:1.36": [] },
    errors: {},
    delayMs: 50,
    scanned: {},
    calls: [],
  };
}

/** The end of the backend's refusal of a Trivy of unknown version. */
export const UNVERSIONED_TRIVY =
  "nauvi does not run it: Trivy 0.69.4 to 0.69.6 ran malicious code as soon as they started (CVE-2026-33634). Install a release build of Trivy (from its GitHub releases, its apt or yum repository, or brew install aquasecurity/trivy/trivy), or set NAUVI_TRIVY to one.";

/** The SHA-256 of a scanner file the fake finds, unless it names one. */
export const FAKE_SHA256 = "3f1a9c0b7d2e" + "4a5b6c7d8e9f".repeat(4) + "0123";

export const scannerStatusOf = (kind: ScannerKind, f: FakeImageScan): ScannerStatus => {
  const found = f.found[kind];
  const base: ScannerStatus = {
    scanner: kind,
    state: "not_installed",
    path: "",
    from: "",
    approved_path: "",
    version: "",
    db: "",
    message: "",
    file: "",
    sha256: "",
  };
  if (!found) {
    return {
      ...base,
      message: `${kind} is not installed or not on PATH. Install it yourself, or set ${kind === "trivy" ? "NAUVI_TRIVY" : "NAUVI_GRYPE"} to its path: nauvi never downloads a scanner.`,
    };
  }
  const sha256 = found.sha256 ?? FAKE_SHA256;
  const withPath = { ...base, path: found.path, from: found.from ?? "PATH", file: `48.2 MB, SHA-256 ${sha256.slice(0, 12)}…`, sha256 };
  // Like the backend: refused from the file, before the approval counts.
  if (kind === "trivy" && found.unversioned)
    return {
      ...withPath,
      state: "refused",
      message: `This Trivy's Go build info names no version (built from source?), so nauvi cannot tell which version it is without running it. ${UNVERSIONED_TRIVY}`,
    };
  const approved = f.approved[kind];
  if (!approved) return { ...withPath, state: "unapproved", message: `nauvi runs ${kind} only once you approve this file.` };
  if (approved !== found.path || f.changed.includes(found.path))
    return {
      ...withPath,
      state: "changed",
      approved_path: approved,
      message: `${found.path} changed since you approved it (an update?). Approve it again to use it.`,
    };
  if (kind === "trivy" && /^v?0\.69\.[4-6]/.test(found.version))
    return {
      ...withPath,
      state: "refused",
      version: found.version,
      message: `Trivy ${found.version} is one of the malicious releases (0.69.4 to 0.69.6, CVE-2026-33634): nauvi does not run it.`,
    };
  return { ...withPath, state: "ready", version: found.version, db: found.db };
};

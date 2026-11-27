// The local scanner (`commands/image_scan.rs`, #536), from
// `fixtures/image-scan.ts` unless a test sets `cluster.imageScan`. Like the
// backend: nothing runs before an approval, one scan at a time, Cancel
// stops it, and only images of the listing can be scanned.

import type { FixGroup, ImageDetail, ImageVulns, ScannerKind, SeverityCounts, Vulnerability, VulnsSummary } from "../../lib/bindings";
import { DEFAULT_IMAGE_SECURITY } from "../../lib/imageSecurity";
import { defaultVulns, imageScanFixture, scannerStatusOf } from "../fixtures/image-scan";
import type { FakeImageScan } from "../fixtures/image-scan";
import { fakeListing } from "./image-security";
import type { AreaHandlers, FakeState } from "./state";

const SEVERITIES = ["critical", "high", "medium", "low", "unknown"] as const;
const zero = (): SeverityCounts => ({ critical: 0, high: 0, medium: 0, low: 0, unknown: 0 });

export function scanData(s: FakeState): FakeImageScan {
  s.cluster.imageScan ??= imageScanFixture();
  return s.cluster.imageScan;
}

function settingsOf(s: FakeState) {
  return s.cluster.settings.image_security ?? DEFAULT_IMAGE_SECURITY;
}

const usesLocal = (s: FakeState) => settingsOf(s).source !== "cluster";

function vulnsOf(d: FakeImageScan, image: string): Vulnerability[] {
  return d.vulns[image] ?? defaultVulns;
}

function withScan(row: ImageVulns, d: FakeImageScan, scanner: ScannerKind, at: number): ImageVulns {
  const counts = zero();
  const fixable = zero();
  for (const v of vulnsOf(d, row.image)) {
    counts[v.severity] += 1;
    if (v.fixed_version) fixable[v.severity] += 1;
  }
  const version = d.found[scanner]?.version ?? "";
  return {
    ...row,
    source: "local_scanner",
    scanned: true,
    counts,
    fixable,
    scanner: `${scanner === "grype" ? "Grype" : "Trivy"} ${version}`,
    scanned_at: at,
    report_namespace: "",
    report_name: "",
  };
}

/** The listing as the backend makes it with a local source: the pods'
 *  images (local only, or no operator), the kept scans on unscanned rows. */
export function localListing(s: FakeState, summary: VulnsSummary, running: ImageVulns[]): VulnsSummary {
  if (!usesLocal(s)) return summary;
  const d = scanData(s);
  const scanner = settingsOf(s).scanner;
  let out = summary;
  if (settingsOf(s).source === "local" || summary.state === "no_operator" || summary.state === "forbidden") {
    const images = running
      .filter((r) => r.running)
      .map((r) => ({
        ...r,
        source: "local_scanner" as const,
        scanned: false,
        counts: zero(),
        fixable: zero(),
        scanner: "",
        scanned_at: 0,
        reports: 0,
        report_namespace: "",
        report_name: "",
      }));
    out = { ...summary, source: "local_scanner", state: "ok", images, forbidden_namespaces: [], notes: [] };
  }
  const images = out.images.map((r) => {
    const kept = d.scanned[`${scanner}@${r.digest}`];
    return !r.scanned && r.running && r.digest && kept ? withScan(r, d, scanner, kept.at) : r;
  });
  const unscanned = images.filter((r) => !r.scanned).length;
  return { ...out, images, unscanned, state: out.state === "no_reports" && images.length > 0 ? "ok" : out.state };
}

function groups(vulns: Vulnerability[]): FixGroup[] {
  const by = new Map<string, FixGroup>();
  for (const v of vulns) {
    const key = `${v.package}@${v.installed_version}`;
    const g = by.get(key) ?? {
      package: v.package,
      installed_version: v.installed_version,
      fixed_in: [],
      counts: zero(),
      fixable: 0,
      ids: [],
    };
    g.counts[v.severity] += 1;
    if (v.fixed_version) {
      g.fixable += 1;
      if (!g.fixed_in.includes(v.fixed_version)) g.fixed_in.push(v.fixed_version);
    }
    g.ids.push(v.id);
    by.set(key, g);
  }
  return [...by.values()];
}

/** The findings of a row a kept local scan covers. */
export function localDetail(s: FakeState, row: ImageVulns): ImageDetail {
  const st = settingsOf(s);
  const rank = (x: string) => SEVERITIES.length - SEVERITIES.indexOf(x as (typeof SEVERITIES)[number]);
  const vulns = vulnsOf(scanData(s), row.image).filter(
    (v) => rank(v.severity) >= rank(st.min_severity) && (!st.only_fixable || v.fixed_version),
  );
  return { image: row, vulnerabilities: structuredClone(vulns), fix_groups: groups(vulns) };
}

let running: string | null = null;
let cancel: (() => void) | null = null;

export function imageScanHandlers(s: FakeState) {
  const listed = (namespaces: string[]) => fakeListing(s, namespaces);
  const statusOf = (kind: ScannerKind) => scannerStatusOf(kind, scanData(s));
  return {
    cmdImageScan: async (namespaces, image, digest, refresh) => {
      if (!usesLocal(s))
        throw "Scanning on this computer is off. Choose a source with the local scanner in Settings → Image security.";
      const row = listed(namespaces).images.find((r) => r.image === image && r.digest === digest);
      if (!row) throw `${image} is no longer in the list; refresh it.`;
      const scanner = settingsOf(s).scanner;
      const st = statusOf(scanner);
      if (st.state === "unapproved") throw `Approve ${st.path} in Settings → Image security first.`;
      if (st.state !== "ready") throw st.message;
      if (running) throw `A scan of ${running} is running. Wait for it, or cancel it.`;
      const d = scanData(s);
      const key = `${scanner}@${digest}`;
      if (!d.scanned[key] || refresh) {
        running = image;
        d.calls.push(image);
        try {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, d.delayMs);
            cancel = () => {
              clearTimeout(t);
              reject("The scan was cancelled.");
            };
          });
        } finally {
          running = null;
          cancel = null;
        }
        if (d.errors[image]) throw d.errors[image];
        d.scanned[key] = { at: Math.floor(Date.now() / 1000), image };
      }
      return localDetail(s, withScan(row, d, scanner, d.scanned[key].at));
    },
    cmdImageScanCancel: () => {
      cancel?.();
    },
    cmdImageScannerApprove: (scanner, path) => {
      const d = scanData(s);
      const found = d.found[scanner];
      if (!found || found.path !== path) throw `${path} is not the ${scanner} nauvi finds now. Check Settings again.`;
      d.approved[scanner] = path;
      d.changed = d.changed.filter((p) => p !== path);
      const st = statusOf(scanner);
      if (st.state === "refused") delete d.approved[scanner];
      return st;
    },
    cmdImageScannerForget: (scanner) => {
      delete scanData(s).approved[scanner];
      return statusOf(scanner);
    },
    cmdImageScannerStatus: (scanner) => statusOf(scanner),
  } satisfies AreaHandlers;
}

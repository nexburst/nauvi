// Scanning images with a Trivy or Grype the user installed (#536, ADR
// 0011): the words of Settings → Image security's scanner part and of the
// Scan buttons. The backend (`commands/image_scan.rs`) finds the scanner,
// keeps the approval, and runs one scan at a time.

import type { ImageVulns, ScannerKind, ScannerStatus, VulnSource } from "./bindings";

export const SOURCES: { value: VulnSource; label: string }[] = [
  { value: "cluster", label: "Trivy Operator reports in the cluster" },
  { value: "local", label: "A scanner on this computer" },
  { value: "cluster_then_local", label: "Cluster reports, then this computer for the rest" },
];

export const SCANNERS: { value: ScannerKind; label: string }[] = [
  { value: "trivy", label: "Trivy" },
  { value: "grype", label: "Grype" },
];

export const scannerLabel = (k: ScannerKind) => (k === "grype" ? "Grype" : "Trivy");

/** Whether the source runs the local scanner. */
export const usesLocal = (source: VulnSource | undefined) => source === "local" || source === "cluster_then_local";

/** What nauvi itself scans, for the hints about the source. */
export function scansText(source: VulnSource | undefined): string {
  if (!usesLocal(source)) return "nauvi scans nothing and downloads nothing itself.";
  const rest = source === "cluster_then_local" ? "an image the reports do not cover" : "an image";
  return `nauvi scans ${rest} only when you ask, with the Trivy or Grype on this computer, and never downloads a scanner or a database.`;
}

/** The line Settings shows about the scanner. */
export function scannerStateText(s: ScannerStatus): string {
  const name = scannerLabel(s.scanner);
  switch (s.state) {
    case "not_installed":
      return s.message;
    case "unapproved":
      return `${name} found at ${s.path}${s.from === "PATH" ? " (on PATH)" : ` (from ${s.from})`}. nauvi runs it only once you approve it.`;
    case "changed":
      return s.message;
    case "ready":
      return `${name} ${s.version} at ${s.path}. ${s.db ? `Its database was built ${dbDate(s.db)}.` : "It has no database yet: it downloads one on its first scan."}`;
    case "refused":
      return s.message;
    case "broken":
      return `${name} at ${s.path || "?"} did not answer: ${s.message}`;
  }
}

/** `2026-11-25T06:13:33Z` → `2026-11-25`; anything else as it is. */
export function dbDate(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1] : s;
}

/** Whether a row can be scanned here: it runs, and the pods say its digest. */
export const scannable = (r: ImageVulns) => r.running && r.digest.startsWith("sha256:");

/** The rows a "Scan all" scans: running, with a digest, no report or local scan yet. */
export function toScan(rows: readonly ImageVulns[]): ImageVulns[] {
  return rows.filter((r) => scannable(r) && !r.scanned);
}

/** The running rows without a scan that cannot be scanned (no digest yet). */
export function unscannable(rows: readonly ImageVulns[]): ImageVulns[] {
  return rows.filter((r) => r.running && !r.scanned && !scannable(r));
}

/** "1 image cannot be scanned: no pod reports which digest it runs." */
export function unscannableText(n: number): string {
  return n === 1
    ? "1 image cannot be scanned: no pod reports which digest it runs."
    : `${n} images cannot be scanned: no pod reports which digest they run.`;
}

/** Why a row cannot be scanned (empty when it can). */
export function notScannableText(r: ImageVulns): string {
  if (!r.running) return "No pod runs this image any more.";
  if (!r.digest) return "No pod reports which digest it runs yet (has it started?): nauvi scans by digest.";
  return "";
}

/** "Scanning 2 of 5: nginx:1.27…" */
export function progressText(done: number, total: number, image: string): string {
  return total > 1 ? `Scanning ${done + 1} of ${total}: ${image}…` : `Scanning ${image}…`;
}

/** "3 images", "1 image". */
export const imagesText = (n: number) => `${n} ${n === 1 ? "image" : "images"}`;

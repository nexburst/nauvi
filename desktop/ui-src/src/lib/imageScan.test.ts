import { describe, expect, it } from "vitest";
import type { ImageVulns, ScannerStatus } from "./bindings";
import { dbDate, notScannableText, progressText, scannable, scannerStateText, toScan, unscannable, unscannableText, usesLocal } from "./imageScan";

const D = `sha256:${"a".repeat(64)}`;

function row(over: Partial<ImageVulns> = {}): ImageVulns {
  return {
    source: "local_scanner",
    image: "nginx:1.27",
    digest: D,
    running: true,
    scanned: false,
    counts: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    fixable: { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 },
    workloads: [],
    report_namespace: "",
    report_name: "",
    reports: 0,
    scanner: "",
    scanned_at: 0,
    ...over,
  };
}

function status(over: Partial<ScannerStatus>): ScannerStatus {
  return {
    scanner: "trivy",
    state: "ready",
    path: "/usr/bin/trivy",
    from: "PATH",
    approved_path: "",
    version: "0.58.1",
    db: "2026-11-25T06:13:33Z",
    message: "",
    ...over,
  };
}

describe("image scan words", () => {
  it("says where the scanner is and what to do", () => {
    expect(scannerStateText(status({}))).toBe("Trivy 0.58.1 at /usr/bin/trivy. Its database was built 2026-11-25.");
    expect(scannerStateText(status({ db: "" }))).toMatch(/no database yet/);
    expect(scannerStateText(status({ state: "unapproved", version: "" }))).toBe(
      "Trivy found at /usr/bin/trivy (on PATH). nauvi runs it only once you approve it.",
    );
    expect(scannerStateText(status({ state: "unapproved", from: "NAUVI_TRIVY" }))).toMatch(/from NAUVI_TRIVY/);
    expect(scannerStateText(status({ state: "refused", message: "malicious" }))).toBe("malicious");
    expect(scannerStateText(status({ state: "broken", message: "exit 3", scanner: "grype" }))).toMatch(/^Grype at/);
  });

  it("only running images with a digest are scanned", () => {
    expect(scannable(row())).toBe(true);
    expect(scannable(row({ digest: "" }))).toBe(false);
    expect(scannable(row({ running: false }))).toBe(false);
    expect(toScan([row(), row({ scanned: true }), row({ digest: "" })])).toHaveLength(1);
    expect(notScannableText(row({ digest: "" }))).toMatch(/by digest/);
    expect(notScannableText(row())).toBe("");
    expect(unscannable([row(), row({ digest: "" }), row({ digest: "", scanned: true })])).toHaveLength(1);
    expect(unscannableText(1)).toBe("1 image cannot be scanned: no pod reports which digest it runs.");
  });

  it("progress and dates", () => {
    expect(progressText(1, 5, "nginx:1.27")).toBe("Scanning 2 of 5: nginx:1.27…");
    expect(progressText(0, 1, "nginx:1.27")).toBe("Scanning nginx:1.27…");
    expect(dbDate("garbage")).toBe("garbage");
    expect(usesLocal("cluster")).toBe(false);
    expect(usesLocal("cluster_then_local")).toBe(true);
    expect(usesLocal(undefined)).toBe(false);
  });
});

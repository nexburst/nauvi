import { describe, expect, it } from "vitest";
import type { ImageSecuritySettings_Serialize as ImageSecuritySettings, ImageVulns, VulnsSummary } from "./bindings";
import {
  agoText,
  compareVersions,
  DEFAULT_IMAGE_SECURITY,
  fixSentence,
  headline,
  headlineDetail,
  imageRows,
  imageSecurityOn,
  sourceText,
  splitGroups,
  stateMessage,
  verdict,
  viewNotes,
  workloadsText,
} from "./imageSecurity";
import { imageSecurityFixture } from "../test/fixtures/image-security";

const s = DEFAULT_IMAGE_SECURITY;
const fx = imageSecurityFixture();
const byImage = (name: string) => fx.images.find((i) => i.image === name)!;

function summary(p: Partial<VulnsSummary>): VulnsSummary {
  return {
    source: "trivy_operator",
    state: "ok",
    namespace: "",
    namespaces_read: [],
    images: [],
    forbidden_namespaces: [],
    all_namespaces_allowed: false,
    unscanned: 0,
    notes: [],
    ...p,
  };
}

describe("image security", () => {
  it("is off by default; a cluster's own choice wins", () => {
    expect(imageSecurityOn(s, undefined)).toBe(false);
    expect(imageSecurityOn(s, "default")).toBe(false);
    expect(imageSecurityOn(s, "on")).toBe(true);
    const on: ImageSecuritySettings = { ...s, enabled: true };
    expect(imageSecurityOn(on, "default")).toBe(true);
    expect(imageSecurityOn(on, "off")).toBe(false);
  });

  it("leads each image with a verdict sentence", () => {
    const nginx = verdict(byImage("nginx:1.27"), s);
    expect(nginx.text).toBe("2 critical and 5 high. 6 of 7 have a fix.");
    expect(nginx.tone).toBe("critical");
    const redis = verdict(byImage("redis:7.2"), s);
    expect(redis.text).toBe("2 high. None has a fix yet.");
    expect(redis.tone).toBe("high");
    expect(verdict(byImage("busybox:1.36"), s)).toMatchObject({ kind: "clean", text: "No known vulnerabilities." });
    expect(verdict(byImage("ghcr.io/team-a/app:2.1"), s).text).toBe(
      "No high or critical vulnerabilities; 6 lower ones.",
    );
    expect(verdict(byImage("ghcr.io/team-a/worker:3"), s)).toMatchObject({ kind: "unscanned", text: "Not scanned yet." });
  });

  it("is red only for a critical vulnerability that has a fix", () => {
    const noFix: ImageVulns = { ...byImage("redis:7.2"), counts: { ...byImage("redis:7.2").counts, critical: 3 } };
    expect(verdict(noFix, s).tone).toBe("high");
    // Medium and worse counted: medium alone stays neutral.
    const medium = verdict(byImage("ghcr.io/team-a/app:2.1"), { ...s, min_severity: "medium" });
    expect(medium).toMatchObject({ tone: "neutral", text: "4 medium. 1 of 4 has a fix." });
  });

  it("counts only what has a fix when asked", () => {
    const only = { ...s, only_fixable: true };
    expect(verdict(byImage("nginx:1.27"), only).text).toBe("2 critical and 4 high. Each has a fix.");
    expect(verdict(byImage("redis:7.2"), only).text).toBe(
      "No high or critical vulnerabilities with a fix.",
    );
  });

  it("orders findings first, then clean, then not scanned, and counts images in the headline", () => {
    const rows = imageRows(fx.images, s);
    expect(rows.map((r) => r.row.image)).toEqual([
      "nginx:1.27",
      "postgres:15",
      "redis:7.2",
      "busybox:1.36",
      "ghcr.io/team-a/app:2.1",
      "ghcr.io/team-a/worker:3",
    ]);
    expect(headline(rows)).toBe("2 images have fixes waiting");
    expect(headlineDetail(rows, s)).toBe("6 images, 3 with high or critical vulnerabilities, 1 not scanned yet.");
    expect(headline(rows.filter((r) => r.row.image === "redis:7.2"))).toBe("No fixes waiting");
    expect(headline(rows.slice(5))).toBe("Not scanned yet");
    expect(headline(rows.slice(3, 4))).toBe("No known vulnerabilities");
    expect(headline(rows.slice(1, 2))).toBe("1 image has a fix waiting");
  });

  it("leaves out excluded namespaces and applies the filter", () => {
    const rows = imageRows(fx.images, { ...s, excluded_namespaces: ["team-a"] });
    expect(rows.map((r) => r.row.image)).toEqual(["nginx:1.27", "redis:7.2", "busybox:1.36"]);
    expect(imageRows(fx.images, s, "cache").map((r) => r.row.image)).toEqual(["redis:7.2"]);
    expect(imageRows(fx.images, s, "NGINX").map((r) => r.row.image)).toEqual(["nginx:1.27"]);
  });

  it("says what to do per package, and keeps what has no fix apart", () => {
    const d = fx.details["nginx:1.27@sha256:1111111111111111"];
    const { fixable, noFix } = splitGroups(d.fix_groups);
    expect(fixable.map((g) => fixSentence(g, d.vulnerabilities))).toEqual([
      "Updating openssl to 3.0.15-1 fixes 4 (2 critical).",
      "Updating curl to 7.88.1-10+deb12u8 fixes 2 high.",
    ]);
    expect(noFix.map((g) => g.package)).toEqual(["libc6"]);
  });

  it("compares versions by their numbers", () => {
    expect(compareVersions("3.0.9", "3.0.15")).toBeLessThan(0);
    expect(compareVersions("1.2", "1.2.1")).toBeLessThan(0);
    expect(compareVersions("2.0", "2.0")).toBe(0);
  });

  it("names the source and the age, and marks old scans", () => {
    const now = byImage("nginx:1.27").scanned_at + 2 * 86400;
    expect(sourceText(byImage("nginx:1.27"), now)).toEqual({
      text: "Trivy 0.69.3 through Trivy Operator, 2 days ago",
      stale: false,
    });
    const pg = byImage("postgres:15");
    expect(sourceText(pg, pg.scanned_at + 10 * 86400).stale).toBe(true);
    expect(sourceText(byImage("ghcr.io/team-a/worker:3"), now).text).toBe("No VulnerabilityReport for it yet");
    expect(agoText(30)).toBe("just now");
    expect(agoText(3600)).toBe("1 hour ago");
  });

  it("names the workloads", () => {
    expect(workloadsText(byImage("nginx:1.27").workloads)).toBe("deploy/web in demo");
    const many = ["a", "b", "c", "d"].map((n, i) => ({
      kind: "Pod",
      namespace: i < 2 ? "x" : "y",
      name: n,
      container: "c",
    }));
    expect(workloadsText(many)).toBe("pod/a, pod/b, pod/c +1 more in 2 namespaces");
    expect(workloadsText([])).toBe("");
  });

  it("tells the three empty states apart", () => {
    expect(stateMessage(summary({ state: "no_operator" }))?.title).toBe(
      "This cluster has no Trivy Operator reports",
    );
    expect(stateMessage(summary({ state: "no_reports" }))?.title).toBe("Not scanned yet");
    expect(stateMessage(summary({ state: "forbidden", forbidden_namespaces: ["team-b"] }))?.title).toBe(
      "You are not allowed to list vulnerabilityreports in namespace team-b",
    );
    expect(stateMessage(summary({ state: "forbidden" }))?.title).toBe(
      "You are not allowed to list vulnerabilityreports in any namespace",
    );
    expect(stateMessage(summary({}))).toBeNull();
  });

  it("puts the namespaces that could not be read and the cut-off in the notes", () => {
    const notes = viewNotes(
      summary({
        forbidden_namespaces: ["a", "b"],
        notes: ["Only the first 2000 VulnerabilityReports were read; narrow with -n."],
      }),
    );
    expect(notes).toEqual([
      "You are not allowed to list vulnerabilityreports in namespaces a and b.",
      "Only the first 2000 VulnerabilityReports were read; pick fewer namespaces to see the rest.",
    ]);
  });
});

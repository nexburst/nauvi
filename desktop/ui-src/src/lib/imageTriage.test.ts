import { describe, expect, it } from "vitest";
import type { IgnoreRule_Serialize as IgnoreRule, ImageVulns, SeverityCounts, Vulnerability } from "./bindings";
import { DEFAULT_IMAGE_SECURITY, verdict } from "./imageSecurity";
import {
  epssText,
  expiryText,
  ignoreActive,
  likeliest,
  makeRule,
  repositoryOf,
  sameTarget,
  scopeChoices,
  scopeText,
  triageParts,
} from "./imageTriage";

const zero: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
const NOW = 1_800_000_000;

function row(p: Partial<ImageVulns> = {}): ImageVulns {
  return {
    source: "trivy_operator",
    image: "nginx:1.27",
    digest: "sha256:1111",
    running: true,
    scanned: true,
    counts: { ...zero, high: 2 },
    fixable: { ...zero, high: 2 },
    ignored: zero,
    kev: 0,
    fixes_known: true,
    workloads: [{ kind: "Deployment", namespace: "shop", name: "web", container: "nginx" }],
    report_namespace: "shop",
    report_name: "r",
    reports: 1,
    scanner: "Trivy 0.69.3",
    scanned_at: NOW,
    ...p,
  };
}

function vuln(id: string, epss: number, percentile = 0): Vulnerability {
  return {
    id,
    package: "openssl",
    installed_version: "3.0.11",
    fixed_version: "",
    severity: "high",
    score: 0,
    title: "",
    link: "",
    exploit: { kev: false, epss, epss_percentile: percentile, risk: 0 },
  };
}

describe("ignores (#537)", () => {
  it("names what an ignore covers", () => {
    expect(repositoryOf("ghcr.io/a/b:2.1@sha256:1")).toBe("ghcr.io/a/b");
    expect(repositoryOf("registry.local:5000/app")).toBe("registry.local:5000/app");
    const r = makeRule(" CVE-2026-1 ", "image", row(), " not reachable ", 30, "kind-dev", NOW);
    expect(r).toMatchObject({ id: "CVE-2026-1", image: "nginx:1.27", context: "", reason: "not reachable" });
    expect(r.expires).toBe(NOW + 30 * 86400);
    expect(scopeText(r)).toBe("every nginx image");
    const w = makeRule("CVE-2026-1", "workload", row(), "x", 0, "kind-dev", NOW);
    expect(w).toMatchObject({ context: "kind-dev", namespace: "shop", kind: "Deployment", name: "web", expires: 0 });
    expect(scopeText(w)).toBe("Deployment web in shop");
    expect(scopeText({ ...w, scope: "namespace" })).toBe("namespace shop");
    expect(sameTarget(r, { ...r, reason: "other", image: "nginx:1.28" } as IgnoreRule)).toBe(true);
    expect(sameTarget(r, w)).toBe(false);
  });

  it("offers a workload or namespace only when the image has one", () => {
    expect(scopeChoices(row()).map((c) => c.scope)).toEqual(["image", "workload", "namespace"]);
    const two = row({
      workloads: [
        { kind: "Deployment", namespace: "shop", name: "web", container: "a" },
        { kind: "Deployment", namespace: "blog", name: "site", container: "a" },
      ],
    });
    expect(scopeChoices(two).map((c) => c.scope)).toEqual(["image"]);
    // Without a cluster, nothing tied to one.
    expect(scopeChoices(row(), "").map((c) => c.scope)).toEqual(["image"]);
  });

  it("says when an ignore ends, and that an expired one no longer applies", () => {
    const at = Date.UTC(2027, 2, 3) / 1000;
    expect(expiryText(at, at - 10)).toBe("until 3 Mar 2027");
    expect(expiryText(at, at)).toBe("expired on 3 Mar 2027");
    expect(expiryText(0, NOW)).toBe("");
    expect(ignoreActive({ expires: at }, at - 1)).toBe(true);
    expect(ignoreActive({ expires: at }, at)).toBe(false);
    expect(ignoreActive({ expires: 0 }, NOW)).toBe(true);
  });
});

describe("the verdict with ignores and KEV", () => {
  const s = DEFAULT_IMAGE_SECURITY;

  it("counts the ignored ones at the end, at the severity counted", () => {
    const r = row({ ignored: { ...zero, high: 1, low: 3 } });
    expect(triageParts(r, "high")).toEqual({ kev: "", ignored: "1 ignored." });
    expect(verdict(r, s).text).toBe("2 high. All 2 have a fix. 1 ignored.");
    expect(triageParts(r, "unknown").ignored).toBe("4 ignored.");
    expect(triageParts(row({ scanned: false, ignored: { ...zero, high: 1 } }), "high").ignored).toBe("");
  });

  it("puts known exploited first and makes the row red, even below the severity counted", () => {
    const v = verdict(row({ kev: 1 }), s);
    expect(v.tone).toBe("critical");
    expect(v.text).toBe("1 known to be exploited in the wild. 2 high. All 2 have a fix.");
    const low = verdict(row({ counts: { ...zero, low: 1 }, fixable: zero, kev: 1 }), s);
    expect(low).toMatchObject({ kind: "findings", tone: "critical" });
    expect(low.text.startsWith("1 known to be exploited in the wild.")).toBe(true);
  });
});

describe("EPSS where the scanner gives it", () => {
  it("is worded as a percentage with its rank", () => {
    expect(epssText(vuln("a", 0.5, 0.9))).toBe("EPSS 50% (top 10%)");
    expect(epssText(vuln("b", 0.0123, 0.999))).toBe("EPSS 1.2% (top 1%)");
    expect(epssText(vuln("c", 0))).toBe("");
    expect(likeliest([vuln("a", 0.1), vuln("b", 0), vuln("c", 0.7), vuln("d", 0)]).map((v) => v.id)).toEqual([
      "c",
      "a",
    ]);
  });
});

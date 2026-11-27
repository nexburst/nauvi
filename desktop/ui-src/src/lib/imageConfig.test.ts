import { describe, expect, it } from "vitest";
import type { ConfigSummary } from "./bindings";
import {
  configHeadline,
  configHeadlineDetail,
  configNotes,
  configRows,
  configSourceText,
  configStateMessage,
  configVerdict,
  splitChecks,
  targetText,
} from "./imageConfig";
import { DEFAULT_IMAGE_SECURITY } from "./imageSecurity";
import { imageConfigFixture } from "../test/fixtures/image-config";

const s = DEFAULT_IMAGE_SECURITY;
const fx = imageConfigFixture();
const byName = (kind: string, name: string) =>
  fx.workloads.find((w) => w.target.kind === kind && w.target.name === name)!;

function summary(p: Partial<ConfigSummary>): ConfigSummary {
  return {
    state: "ok",
    namespace: "",
    namespaces_read: [],
    workloads: [],
    forbidden_namespaces: [],
    all_namespaces_allowed: false,
    notes: [],
    ...p,
  };
}

describe("misconfigurations", () => {
  it("leads each workload with what it fails, at the settings' severity", () => {
    const web = configVerdict(byName("Deployment", "web"), s);
    expect(web).toMatchObject({
      kind: "changes",
      tone: "critical",
      counted: 3,
    });
    expect(web.text).toBe("Fails 3 checks: 1 critical and 2 high.");
    const cache = configVerdict(byName("StatefulSet", "cache"), s);
    expect(cache.text).toBe("Fails 1 high check.");
    expect(cache.tone).toBe("high");
    const logger = configVerdict(byName("Deployment", "logger"), s);
    expect(logger).toMatchObject({ kind: "clean", tone: "neutral" });
    expect(logger.text).toBe("No high or critical checks fail; 6 lower ones.");
    expect(configVerdict(byName("Service", "web"), s).text).toBe(
      "Passes every check.",
    );
    // All severities: the medium and low ones count too.
    const all = configVerdict(byName("Deployment", "logger"), {
      ...s,
      min_severity: "unknown",
    });
    expect(all.text).toBe("Fails 6 checks: 2 medium and 4 low.");
  });

  it("orders workloads with changes first, worst first, and filters", () => {
    const rows = configRows(fx.workloads, s);
    expect(rows.map((r) => targetText(r.row))).toEqual([
      "deploy/web",
      "sts/cache",
      "deploy/logger",
      "deploy/app",
      "svc/web",
    ]);
    expect(configHeadline(rows)).toBe("2 workloads have settings to change");
    expect(configHeadlineDetail(rows, s)).toBe(
      "5 workloads, 2 failing high or critical checks.",
    );
    expect(
      configRows(fx.workloads, { ...s, excluded_namespaces: ["team-a"] }),
    ).toHaveLength(4);
    expect(
      configRows(fx.workloads, s, "cache").map((r) => r.row.target.name),
    ).toEqual(["cache"]);
    expect(configHeadline(configRows([byName("Service", "web")], s))).toBe(
      "Nothing to change",
    );
  });

  it("splits the failed checks at the settings' severity", () => {
    const d = fx.details["Deployment/demo/web"];
    const { counted, lower } = splitChecks(d.failed, s);
    expect(counted.map((c) => c.id)).toEqual(["KSV017", "KSV014", "KSV118"]);
    expect(lower.map((c) => c.id)).toEqual(["KSV001", "KSV011", "KSV016"]);
  });

  it("says where the data comes from and how old it is", () => {
    const app = byName("Deployment", "app");
    const src = configSourceText(app, app.scanned_at + 10 * 86400);
    expect(src.text).toBe("Trivy 0.69.3 through Trivy Operator, 10 days ago");
    expect(src.stale).toBe(true);
  });

  it("names each empty state plainly", () => {
    expect(configStateMessage(summary({}))).toBeNull();
    expect(configStateMessage(summary({ state: "no_operator" }))!.title).toBe(
      "This cluster has no configuration audits",
    );
    expect(configStateMessage(summary({ state: "no_reports" }))!.title).toBe(
      "Not checked yet",
    );
    expect(
      configStateMessage(
        summary({ state: "forbidden", forbidden_namespaces: ["a"] }),
      )!.title,
    ).toBe("You are not allowed to list configauditreports in namespace a");
    expect(
      configNotes(
        summary({
          forbidden_namespaces: ["b"],
          notes: [
            "Only the first 2000 ConfigAuditReports were read; narrow with -n.",
          ],
        }),
      ),
    ).toEqual([
      "You are not allowed to list configauditreports in b.",
      "Only the first 2000 ConfigAuditReports were read; pick fewer namespaces to see the rest.",
    ]);
  });
});

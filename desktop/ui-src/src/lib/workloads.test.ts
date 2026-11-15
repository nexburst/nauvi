import { describe, expect, it } from "vitest";
import type { KindCounts, ResourceKind } from "./bindings";
import { matchesStatus, needsAttention, segments, toneOf, workloadKind } from "./workloads";

const DEPLOYMENTS: KindCounts = {
  group: "apps",
  kind: "Deployment",
  total: 3,
  statuses: [
    { status: "Running", count: 2 },
    { status: "Pending", count: 1 },
    { status: "Failed", count: 0 },
  ],
};

describe("workload cards", () => {
  it("splits a kind into its statuses, zeros included", () => {
    expect(segments(DEPLOYMENTS)).toEqual([
      { status: "Running", count: 2, percent: 66.7, tone: "ok" },
      { status: "Pending", count: 1, percent: 33.3, tone: "progress" },
      { status: "Failed", count: 0, percent: 0, tone: "bad" },
    ]);
    const none = { ...DEPLOYMENTS, total: 0, statuses: DEPLOYMENTS.statuses.map((s) => ({ ...s, count: 0 })) };
    expect(segments(none).every((s) => s.percent === 0)).toBe(true);
  });

  it("colours failures and errors, not suspended or scheduled", () => {
    expect(toneOf("Error")).toBe("bad");
    expect(toneOf("Failed")).toBe("bad");
    expect(toneOf("Succeeded")).toBe("done");
    expect(toneOf("Suspended")).toBe("idle");
    expect(toneOf("Scheduled")).toBe("idle");
    expect(needsAttention(DEPLOYMENTS)).toBe(false);
    const failed = { ...DEPLOYMENTS, statuses: [{ status: "Failed" as const, count: 1 }] };
    expect(needsAttention(failed)).toBe(true);
  });

  it("finds the table of a kind and filters its rows by status", () => {
    const kind = (group: string, k: string, version: string) =>
      ({ id: `${group}/${version}/${k}`, resource: { group, kind: k, version } }) as unknown as ResourceKind;
    const kinds = [kind("apps", "Deployment", "v1"), kind("batch", "Job", "v1"), kind("", "Pod", "v1")];
    expect(workloadKind(kinds, "batch", "Job")?.id).toBe("batch/v1/Job");
    expect(workloadKind(kinds, "", "Deployment")).toBeUndefined();
    expect(matchesStatus({ status: "Pending" }, "Pending")).toBe(true);
    expect(matchesStatus({ status: "Running" }, "Pending")).toBe(false);
    expect(matchesStatus({ status: "" }, "")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import type { KindCounts, ResourceKind } from "./bindings";
import {
  PROBLEMS_STATUS,
  matchesStatus,
  needsAttention,
  seeAllWorkloads,
  segments,
  toneOf,
  workloadKind,
  workloadsHeadline,
  workloadsKicker,
} from "./workloads";

const DEPLOYMENTS: KindCounts = {
  group: "apps",
  kind: "Deployment",
  total: 3,
  problems: 1,
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
    // Any table: only what needs attention, whatever its status says.
    expect(matchesStatus({ status: "", problem: "CrashLoopBackOff" }, PROBLEMS_STATUS)).toBe(true);
    expect(matchesStatus({ status: "Running", problem: "" }, PROBLEMS_STATUS)).toBe(false);
    expect(matchesStatus({ status: "Running" }, "Pending")).toBe(false);
    expect(matchesStatus({ status: "" }, "")).toBe(true);
  });
});

describe("the deck and its budgets (#606)", () => {
  it("says how many workloads need a look, or that none do", () => {
    expect(workloadsHeadline(41, "kind-dev")).toEqual({ text: "41 workloads need a look", calm: false });
    expect(workloadsHeadline(1, "kind-dev").text).toBe("1 workload needs a look");
    expect(workloadsHeadline(0, "kind-dev")).toEqual({ text: "No workload problems in kind-dev", calm: true });
    expect(workloadsHeadline(0, "").text).toBe("No workload problems");
    expect(workloadsKicker("kind-dev", [])).toBe("kind-dev · all namespaces");
    expect(workloadsKicker("kind-dev", ["a"])).toBe("kind-dev · namespace a");
    expect(workloadsKicker("", ["a", "b"])).toBe("namespaces a and b");
  });

  it("links to every kind with problems when not all are listed, most first", () => {
    const kinds: KindCounts[] = [
      { ...DEPLOYMENTS, problems: 38 },
      { ...DEPLOYMENTS, group: "batch", kind: "Job", problems: 0 },
      { ...DEPLOYMENTS, group: "batch", kind: "CronJob", problems: 3 },
    ];
    const five = [1, 2, 3, 4, 5];
    expect(seeAllWorkloads({ kinds, problems: five, problems_total: 41 })).toEqual([
      { group: "apps", kind: "Deployment", count: 38, status: PROBLEMS_STATUS },
      { group: "batch", kind: "CronJob", count: 3, status: "Suspended" },
    ]);
    // All five listed: no link.
    expect(seeAllWorkloads({ kinds, problems: five, problems_total: 5 })).toEqual([]);
    expect(seeAllWorkloads({ kinds, problems: [], problems_total: 0 })).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { Capacity, EventInfo, PodCounts, ProblemGroup, ResourceKind } from "./bindings";
import {
  capacityBars,
  deckHeadline,
  deckKicker,
  eventKind,
  groupCounts,
  overviewCount,
  percent,
  podCards,
  rawPercent,
  seeAllProblems,
} from "./overview";

const capacity: Capacity = {
  cpu_requests_millicores: 1200,
  cpu_limits_millicores: 2000,
  cpu_unlimited_containers: 0,
  cpu_allocatable_millicores: 8000,
  cpu_usage_millicores: 900,
  memory_requests_bytes: 3 * 1024 ** 3,
  memory_limits_bytes: 20 * 1024 ** 3,
  memory_unlimited_containers: 0,
  memory_allocatable_bytes: 16 * 1024 ** 3,
  memory_usage_bytes: 4 * 1024 ** 3,
  metrics: true,
  pods: 105,
  pods_allocatable: 110,
};

const kind = (group: string, version: string, k: string, namespaced = true): ResourceKind => ({
  resource: { group, version, kind: k, plural: k.toLowerCase() + "s", namespaced },
  id: `${group ? group + "/" : ""}${version}/${k.toLowerCase()}s`,
  label: k + "s",
  category: "workloads",
  crd: false,
  verbs: [],
  short_names: [],
  columns: [],
  actions: [],
});

const event = (apiVersion: string, k: string, name = "web"): EventInfo => ({
  key: "demo/e1",
  kind: "Warning",
  reason: "BackOff",
  message: "",
  object: `${k}/${name}`,
  object_api_version: apiVersion,
  object_kind: k,
  object_namespace: "demo",
  object_name: name,
  time: 0,
  count: 1,
  owner_kind: "",
  owner_name: "",
});

describe("percent", () => {
  it("rounds, caps at 100 and survives a zero total", () => {
    expect(percent(1, 3)).toBe(33);
    expect(percent(5, 4)).toBe(100);
    expect(percent(5, 0)).toBe(0);
  });
});

describe("capacityBars", () => {
  it("shows requests against allocatable, with usage when metrics are there", () => {
    const [cpu, mem, pods] = capacityBars(capacity);
    expect(cpu.text).toBe("1.2 / 8 requested (15%)");
    expect(cpu.usage).toBe("900m used (11%)");
    expect(mem.text).toBe("3 GiB / 16 GiB requested (19%)");
    expect(mem.usage).toBe("4 GiB used (25%)");
    expect(pods.text).toBe("105 / 110 (95%)");
    expect(pods.high).toBe(true);
    expect(cpu.high).toBe(false);
  });

  it("shows the limits, uncapped, with a capped marker", () => {
    const [cpu, mem, pods] = capacityBars(capacity);
    expect(cpu.limits).toBe("2 limits (25%)");
    expect(cpu.limitPercent).toBe(25);
    expect(cpu.overcommitted).toBe(false);
    // 20Gi of limits on 16Gi: overcommitted, the marker stops at the end.
    expect(mem.limits).toBe("20 GiB limits (125%)");
    expect(mem.limitPercent).toBe(100);
    expect(mem.overcommitted).toBe(true);
    expect(pods.limits).toBe("");
    expect(pods.limitPercent).toBeNull();
    // No limits set: no marker.
    const none = capacityBars({ ...capacity, cpu_limits_millicores: 0 })[0];
    expect(none.limitPercent).toBeNull();
    expect(none.limits).toBe("no limits");
    expect(rawPercent(5, 0)).toBe(0);
  });

  it("says how many containers have no limit, and marks the limits partial", () => {
    const [cpu, mem] = capacityBars({ ...capacity, cpu_unlimited_containers: 1, memory_unlimited_containers: 14 });
    expect(cpu.limits).toBe("2 limits (25%) · 1 container without a limit");
    expect(mem.limits).toBe("20 GiB limits (125%) · 14 containers without a limit");
    expect(cpu.partial).toBe(true);
    expect(cpu.limitPercent).toBe(25);
    expect(capacityBars(capacity)[0].partial).toBe(false);
  });

  it("leaves usage out without metrics", () => {
    const [cpu, mem] = capacityBars({ ...capacity, metrics: false });
    expect(cpu.usage).toBe("");
    expect(mem.usage).toBe("");
  });
});

describe("podCards", () => {
  it("flags waiting errors and failures", () => {
    const counts: PodCounts = {
      namespace: null,
      total: 5,
      running: 3,
      pending: 1,
      succeeded: 0,
      failed: 0,
      waiting_errors: 1,
      by_namespace: [],
      problems: [],
      problems_total: 0,
      groups: [],
      groups_total: 0,
    };
    const cards = podCards(counts);
    expect(cards.map((c) => [c.label, c.value, c.alert, c.status, c.quiet])).toEqual([
      ["Running", 3, false, "Running", false],
      ["Pending", 1, false, "Pending", false],
      // Errors open the Pods that need attention.
      ["Errors", 1, true, "needs attention", false],
      // Failed 0 and Succeeded 0 are a muted line, not cards.
      ["Failed", 0, false, "Failed", true],
      ["Succeeded", 0, false, "Succeeded", true],
    ]);
    expect(podCards({ ...counts, failed: 2 })[3]).toMatchObject({ alert: true, quiet: false });
    expect(overviewCount(counts, { total: 2 })).toBe("5 pods, 2 nodes");
    expect(overviewCount(counts, null)).toBe("5 pods");
  });
});

describe("eventKind", () => {
  const kinds = [kind("", "v1", "Pod"), kind("apps", "v1", "Deployment"), kind("", "v1", "Node", false)];

  it("finds the kind by group and version, or by group alone", () => {
    expect(eventKind(event("v1", "Pod"), kinds)?.id).toBe("v1/pods");
    expect(eventKind(event("apps/v1", "Deployment"), kinds)?.id).toBe("apps/v1/deployments");
    expect(eventKind(event("apps/v1beta2", "Deployment"), kinds)?.id).toBe("apps/v1/deployments");
  });

  it("gives up on unknown kinds and objects without a name", () => {
    expect(eventKind(event("example.com/v1", "Widget"), kinds)).toBeUndefined();
    expect(eventKind(event("v1", "Pod", ""), kinds)).toBeUndefined();
  });
});

describe("deckHeadline", () => {
  const pods = (problems_total: number) => ({ problems_total }) as unknown as PodCounts;
  it("says how the cluster is, in plain words", () => {
    expect(deckHeadline(pods(0), "kind-dev")).toEqual({ text: "No problems in kind-dev", calm: true });
    expect(deckHeadline(pods(0), "").text).toBe("No problems");
    expect(deckHeadline(pods(1), "kind-dev").text).toBe("1 pod needs a look");
    expect(deckHeadline(pods(3), "kind-dev")).toEqual({ text: "3 pods need a look", calm: false });
    expect(deckHeadline(null, "kind-dev").calm).toBe(true);
  });

  it("names the context and what it covers above it", () => {
    expect(deckKicker("kind-dev", null)).toBe("kind-dev · all namespaces");
    expect(deckKicker("kind-dev", "team-a")).toBe("kind-dev · namespace team-a");
  });
});

describe("Problem groups", () => {
  const group = (over: Partial<ProblemGroup>): ProblemGroup => ({
    key: "k",
    namespace: "demo",
    owner_kind: "Deployment",
    owner_name: "web",
    reason: "CrashLoopBackOff",
    error: true,
    count: 18,
    owner_pods: 20,
    restarts: 340,
    pods: [],
    events: [],
    ...over,
  });

  it("count the pods of the workload and their restarts", () => {
    expect(groupCounts(group({}))).toBe("18 of 20 pods · 340 restarts");
    expect(groupCounts(group({ count: 1, owner_pods: 1, restarts: 1 }))).toBe("1 of 1 pod · 1 restart");
    expect(groupCounts(group({ restarts: 0 }))).toBe("18 of 20 pods");
    // A pod without an owner: only its restarts.
    expect(groupCounts(group({ owner_kind: "", owner_name: "", count: 1, owner_pods: 1, restarts: 12 }))).toBe("12 restarts");
    expect(groupCounts(group({ owner_kind: "", owner_name: "", count: 1, owner_pods: 1, restarts: 0 }))).toBe("");
  });

  it("link to all problem pods only when the rows do not hold them all", () => {
    const counts = (groups: ProblemGroup[], problems_total: number, groups_total = groups.length) =>
      ({ groups, groups_total, problems_total }) as unknown as PodCounts;
    expect(seeAllProblems(counts([group({ count: 2 })], 2))).toBe("");
    const five = Array.from({ length: 5 }, (_, i) => group({ key: `${i}`, count: 10 }));
    expect(seeAllProblems(counts(five, 166, 11))).toBe("See all 166 problem pods →");
    // All in the rows, but a group's pods beyond what was counted.
    expect(seeAllProblems(counts([group({ count: 3 })], 4))).toBe("See all 4 problem pods →");
  });
});

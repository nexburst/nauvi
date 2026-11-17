import { beforeEach, describe, expect, it } from "vitest";
import type { Capacity, OverviewUsageView, UsageSample } from "./bindings";
import {
  CLUSTER_SPACING_MS,
  CLUSTER_WINDOW_MS,
  addSample,
  clearClusterUsage,
  clusterChart,
  clusterRefs,
  recordClusterUsage,
  sampledClusterUsage,
} from "./clusterUsage";

const s = (t: number, cpu = 100, mem = 1024): UsageSample => ({ t, cpu_millicores: cpu, memory_bytes: mem });

const capacity: Capacity = {
  cpu_requests_millicores: 1200,
  cpu_limits_millicores: 0,
  cpu_allocatable_millicores: 8000,
  cpu_usage_millicores: 900,
  memory_requests_bytes: 3 * 1024 ** 3,
  memory_limits_bytes: 6 * 1024 ** 3,
  memory_allocatable_bytes: 16 * 1024 ** 3,
  memory_usage_bytes: 2 * 1024 ** 3,
  metrics: true,
  pods: 4,
  pods_allocatable: 220,
};

beforeEach(clearClusterUsage);

describe("addSample", () => {
  it("drops samples too close to the last one and older than an hour", () => {
    const a = addSample([], s(0));
    expect(a).toEqual([s(0)]);
    // Too soon: the same array.
    expect(addSample(a, s(CLUSTER_SPACING_MS - 1))).toBe(a);
    const b = addSample(a, s(CLUSTER_SPACING_MS));
    expect(b.map((x) => x.t)).toEqual([0, CLUSTER_SPACING_MS]);
    const c = addSample(b, s(CLUSTER_WINDOW_MS + 1));
    expect(c.map((x) => x.t)).toEqual([CLUSTER_SPACING_MS, CLUSTER_WINDOW_MS + 1]);
  });
});

describe("recordClusterUsage", () => {
  it("records per context, and nothing without metrics", () => {
    recordClusterUsage("a", capacity, 1000);
    recordClusterUsage("a", { ...capacity, cpu_usage_millicores: 950 }, 1000 + 30_000);
    recordClusterUsage("b", { ...capacity, metrics: false }, 1000);
    expect(sampledClusterUsage("a", 31_000).map((x) => x.cpu_millicores)).toEqual([900, 950]);
    expect(sampledClusterUsage("a", 31_000)[0].memory_bytes).toBe(2 * 1024 ** 3);
    expect(sampledClusterUsage("b", 31_000)).toEqual([]);
    // An hour later the first sample is gone.
    expect(sampledClusterUsage("a", 1001 + CLUSTER_WINDOW_MS)).toHaveLength(1);
  });
});

describe("clusterChart", () => {
  const view = (v: Partial<OverviewUsageView>): OverviewUsageView => ({
    samples: [],
    source: "metrics_server",
    prometheus: "",
    note: "",
    ...v,
  });

  it("uses Prometheus' hour when it sent one", () => {
    const c = clusterChart(view({ source: "prometheus", prometheus: "monitoring/prometheus:9090", samples: [s(1)] }), [
      s(2),
    ]);
    expect(c.samples).toEqual([s(1)]);
    expect(c.source).toBe("Last hour, from Prometheus (monitoring/prometheus:9090).");
    expect(c.note).toBe("");
  });

  it("falls back to the samples of this window, saying why", () => {
    const local = [s(new Date(2026, 0, 1, 10, 42).getTime())];
    expect(clusterChart(view({}), local).source).toBe(
      "Sampled from metrics-server while this window is open, since 10:42 (at most an hour).",
    );
    expect(clusterChart(null, []).source).toMatch(/first sample comes with the next usage poll/);
    const failed = clusterChart(view({ prometheus: "m/p:9090", note: "Prometheus at m/p:9090 is not available." }), local);
    expect(failed.samples).toBe(local);
    expect(failed.note).toBe("Prometheus at m/p:9090 is not available. Showing the metrics-server samples instead.");
  });
});

describe("clusterRefs", () => {
  it("lists the requests, limits and allocatable that are set", () => {
    expect(clusterRefs(capacity, "cpu").map((r) => r.label)).toEqual(["request", "allocatable"]);
    expect(clusterRefs(capacity, "memory")).toEqual([
      { label: "request", value: 3 * 1024 ** 3 },
      { label: "limit", value: 6 * 1024 ** 3 },
      { label: "allocatable", value: 16 * 1024 ** 3 },
    ]);
  });
});

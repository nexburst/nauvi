import { describe, expect, it } from "vitest";
import type { HelmChartVersion, HelmDeployRequest } from "./bindings";
import {
  bareName,
  chartSources,
  defaultReleaseName,
  filterCharts,
  namespaceError,
  nextValues,
  pickVersion,
  releaseNameError,
  repoOf,
  sameDeploy,
} from "./helmCharts";

const v = (name: string, version: string, description = "", app_version = ""): HelmChartVersion => ({
  name,
  version,
  app_version,
  description,
});

describe("chart names", () => {
  it("splits repo/chart", () => {
    expect(repoOf("bitnami/redis")).toBe("bitnami");
    expect(bareName("bitnami/redis")).toBe("redis");
    expect(repoOf("redis")).toBe("");
    expect(bareName("redis")).toBe("redis");
  });

  it("makes a valid default release name", () => {
    expect(defaultReleaseName("bitnami/redis")).toBe("redis");
    expect(defaultReleaseName("x/My_Chart")).toBe("my-chart");
    expect(defaultReleaseName("x/_-")).toBe("release");
    expect(defaultReleaseName(`x/${"a".repeat(80)}`)).toHaveLength(53);
    expect(releaseNameError(defaultReleaseName("x/My_Chart"))).toBe("");
  });
});

describe("validation", () => {
  it("checks release names like the backend", () => {
    for (const ok of ["web", "my-app.v2", "0x"]) expect(releaseNameError(ok)).toBe("");
    for (const bad of ["", "-rf", "Web", "a b", "x".repeat(54)]) expect(releaseNameError(bad)).not.toBe("");
  });

  it("checks namespaces", () => {
    expect(namespaceError("team-a")).toBe("");
    for (const bad of ["", "-a", "a-", "A", "a.b"]) expect(namespaceError(bad)).not.toBe("");
  });
});

describe("filterCharts", () => {
  const all = [v("b/web", "1.0.0", "A web server"), v("a/redis", "18.0.0", "Data store", "7.2")];

  it("sorts by name and matches name, description or app version", () => {
    expect(filterCharts(all, "").map((c) => c.name)).toEqual(["a/redis", "b/web"]);
    expect(filterCharts(all, "WEB").map((c) => c.name)).toEqual(["b/web"]);
    expect(filterCharts(all, "store").map((c) => c.name)).toEqual(["a/redis"]);
    expect(filterCharts(all, "7.2").map((c) => c.name)).toEqual(["a/redis"]);
    expect(filterCharts(all, "nothing")).toEqual([]);
  });
});

describe("versions", () => {
  const found = [v("a/web", "1.3.0"), v("a/web", "1.2.0"), v("b/web", "1.2.0")];

  it("groups versions by repository in order", () => {
    const s = chartSources(found);
    expect([...s.keys()]).toEqual(["a/web", "b/web"]);
    expect(s.get("a/web")?.map((x) => x.version)).toEqual(["1.3.0", "1.2.0"]);
  });

  it("keeps the preferred version if offered, else the newest", () => {
    const a = chartSources(found).get("a/web") ?? [];
    expect(pickVersion(a, "1.2.0")).toBe("1.2.0");
    expect(pickVersion(a, "0.9.0")).toBe("1.3.0");
    expect(pickVersion(a, "")).toBe("1.3.0");
    expect(pickVersion([], "1.0.0")).toBe("");
  });

  it("refills values from new defaults unless edited", () => {
    expect(nextValues("", "", "a: 1\n")).toBe("a: 1\n");
    expect(nextValues("a: 1\n", "a: 1\n", "a: 2\n")).toBe("a: 2\n");
    expect(nextValues("a: 9\n", "a: 1\n", "a: 2\n")).toBe("a: 9\n");
  });
});

describe("sameDeploy", () => {
  const req: HelmDeployRequest = {
    name: "web",
    namespace: "apps",
    chart: "a/web",
    version: "1.0.0",
    values: "a: 1\n",
    create_namespace: true,
    dry_run: true,
    reveal: false,
  };

  it("ignores dry_run and compares everything else", () => {
    expect(sameDeploy(req, { ...req, dry_run: false })).toBe(true);
    expect(sameDeploy(req, { ...req, values: "a: 2\n" })).toBe(false);
    expect(sameDeploy(req, { ...req, version: "1.1.0" })).toBe(false);
    expect(sameDeploy(null, req)).toBe(false);
  });
});

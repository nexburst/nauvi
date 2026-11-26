import { describe, expect, it } from "vitest";
import type { Application, AppWorkload } from "./bindings";
import { appRow, healthTone, nextSort, sourceLabel, visibleApps, workloadSummary } from "./applications";
import type { AppRow } from "./applications";
import type { Entry } from "./stores/keyed.svelte";

const w = (kind: string, name: string): AppWorkload => ({
  group: kind === "Job" ? "batch" : "apps",
  kind,
  namespace: "demo",
  name,
  status: "Running",
  problem: "",
});

function app(name: string, over: Partial<Application> = {}): Application {
  return {
    key: `demo/${name}`,
    namespace: "demo",
    name,
    source: "Instance",
    components: [],
    versions: [],
    managed_by: [],
    health: "Healthy",
    reason: "",
    workloads: [w("Deployment", name)],
    created: 100,
    ...over,
  };
}

/** Entries like `KeyedStore` makes them. */
function entries(list: Application[]): Entry<AppRow>[] {
  return list.map((a) => {
    const row = appRow(a);
    return { key: row.key, row };
  });
}

describe("applications", () => {
  it("colours health like workload statuses", () => {
    expect(healthTone("Healthy")).toBe("ok");
    expect(healthTone("Progressing")).toBe("progress");
    expect(healthTone("Degraded")).toBe("bad");
    expect(healthTone("Suspended")).toBe("idle");
    expect(sourceLabel("Helm")).toBe("Helm release");
    expect(sourceLabel("Name")).toBe("name label");
  });

  it("filters on fields and workload names, and sorts with key ties", () => {
    const list = [
      app("web", { health: "Healthy", created: 300 }),
      app("shop", { health: "Degraded", workloads: [w("Deployment", "api"), w("Job", "migrate")], created: 100 }),
      app("db", { health: "Progressing", versions: ["15.2"], created: 200 }),
    ];
    const e = entries(list);
    expect(visibleApps(e, "", { key: "name", dir: "asc" }).map((a) => a.name)).toEqual(["db", "shop", "web"]);
    expect(visibleApps(e, "", { key: "health", dir: "asc" }).map((a) => a.name)).toEqual(["shop", "db", "web"]);
    expect(visibleApps(e, "", { key: "workloads", dir: "desc" }).map((a) => a.name)).toEqual(["shop", "db", "web"]);
    expect(visibleApps(e, "", { key: "age", dir: "asc" }).map((a) => a.name)).toEqual(["web", "db", "shop"]);
    expect(visibleApps(e, "MIGRATE", { key: "name", dir: "asc" }).map((a) => a.name)).toEqual(["shop"]);
    expect(visibleApps(e, "15.2", { key: "name", dir: "asc" }).map((a) => a.name)).toEqual(["db"]);
    // The row object itself is not searched as "[object Object]".
    expect(visibleApps(e, "object", { key: "name", dir: "asc" })).toEqual([]);
  });

  it("summarizes workloads per kind", () => {
    expect(workloadSummary(app("a", { workloads: [w("Deployment", "a"), w("Deployment", "b"), w("Job", "c")] }))).toBe(
      "2 Deployments, 1 Job",
    );
    expect(workloadSummary(app("a", { workloads: [] }))).toBe("");
  });

  it("flips the sort of the same column", () => {
    expect(nextSort({ key: "name", dir: "asc" }, "name")).toEqual({ key: "name", dir: "desc" });
    expect(nextSort({ key: "name", dir: "desc" }, "age")).toEqual({ key: "age", dir: "asc" });
  });
});

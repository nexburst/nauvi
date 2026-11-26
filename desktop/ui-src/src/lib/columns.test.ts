import { describe, expect, it } from "vitest";
import type { ColumnKind, ResourceKind, ResourceRow } from "./bindings";
import {
  columnsFor,
  headerLabel,
  EMPTY_METRICS,
  HIDDEN_METRICS,
  isNode,
  isPod,
  nodeReadyClass,
  shownColumns,
  statusIcon,
  cellWidth,
} from "./columns";
import type { Ctx, Metrics } from "./columns";

function kindWith(kinds: [string, ColumnKind][], kind = "Pod", group = ""): ResourceKind {
  return {
    resource: { group, version: "v1", kind, plural: kind.toLowerCase() + "s", namespaced: true },
    id: `${group}/v1/${kind}`,
    label: kind,
    category: "workloads",
    crd: false,
    verbs: [],
    short_names: [],
    columns: kinds.map(([key, k]) => ({ key, label: key.toUpperCase(), kind: k, default_hidden: false })),
    actions: [],
  };
}

const row = (cells: string[], extra: Partial<ResourceRow> = {}): ResourceRow => ({
  key: "demo/web-1",
  name: "web-1",
  namespace: "demo",
  created: 0,
  cells,
  ...extra,
  problem: extra.problem ?? "",
  status: extra.status ?? "",
});

const metrics: Metrics = {
  pods: new Map([["demo/web-1", { namespace: "demo", name: "web-1", cpu_millicores: 250, memory_bytes: 64 * 1024 ** 2, containers: [] }]]),
  nodes: new Map([
    [
      "node-1",
      {
        name: "node-1",
        cpu_millicores: 1500,
        cpu_capacity_millicores: 4000,
        memory_bytes: 1024 ** 3,
        memory_capacity_bytes: 0,
      },
    ],
  ]),
  sparks: new Map([
    ["demo/web-1", { cpu: [100, 250], memory: [1, 2] }],
    ["node-1", { cpu: [900, 1500], memory: [3, 4] }],
  ]),
  since: 1000,
};
const ctx: Ctx = { metrics, now: 0 };

describe("columnsFor", () => {
  it("keeps the backend's keys, sentence-cases its labels, and caches per kind", () => {
    const k = kindWith([["name", "text"]]);
    const cols = columnsFor(k);
    expect(cols.map((c) => [c.key, c.label])).toEqual([["name", "Name"]]);
    expect(columnsFor(k)).toBe(cols);
  });

  it("lets Name and message columns grow, and short columns never give way (#482)", () => {
    const cols = columnsFor(
      kindWith([
        ["name", "text"],
        ["namespace", "text"],
        ["ready", "text"],
        ["uptodate", "number"],
        ["status", "rollout"],
        ["age", "age"],
        ["message", "text"],
        ["x", "text"],
      ]),
    );
    const fit = Object.fromEntries(cols.map((c) => [c.key, c.fit]));
    // The message takes the spare width before Name, Name before Namespace.
    expect(fit.message.grow).toBeGreaterThan(fit.name.grow);
    expect(fit.name.grow).toBeGreaterThan(fit.namespace.grow);
    for (const k of ["ready", "uptodate", "status", "age", "x"]) expect(fit[k].grow, k).toBe(0);
    // Short values are never cut; Name gives way last.
    for (const k of ["ready", "uptodate", "status", "age"]) expect(fit[k].give, k).toBe(0);
    expect(fit.name.give).toBeGreaterThan(fit.namespace.give);
    expect(fit.namespace.give).toBeGreaterThan(fit.x.give);
    // Generated names keep their end when cut.
    expect(fit.name.middle).toBe(true);
    expect(fit.namespace.middle).toBe(true);
    expect(fit.x.middle).toBeFalsy();
    // Age is as wide as its widest value from the start.
    expect(fit.age.sample).toBe("23h59m");
  });

  it("gives a cell's width with what is drawn in it", () => {
    const m = (t: string) => t.length * 7;
    const [name, st, sq] = columnsFor(
      kindWith([
        ["name", "text"],
        ["status", "status"],
        ["containers", "containers"],
      ]),
    );
    expect(cellWidth(name, "web-1", m)).toBe(20 + 35);
    // The status icon and its gap.
    expect(cellWidth(st, "Running", m)).toBe(20 + 20 + 49);
    // One square per container.
    expect(cellWidth(sq, "app=running sidecar=waiting", m)).toBe(20 + 2 * 13);
  });

  it("draws each status with an icon in its tone (#482)", () => {
    expect(statusIcon("phase-Running")).toBe("ok");
    expect(statusIcon("phase-Completed")).toBe("check");
    expect(statusIcon("phase-Pending")).toBe("pending");
    expect(statusIcon("phase-CrashLoopBackOff")).toBe("error");
    expect(statusIcon("phase-Failed")).toBe("failed");
    expect(statusIcon("phase-Init:0/1")).toBeNull();
    expect(statusIcon("")).toBeNull();
  });

  it("sorts numeric cells by their leading number, unknown last", () => {
    const [num] = columnsFor(kindWith([["ready", "number"]]));
    expect(num.sort(row(["1/2"]), ctx)).toBe(1);
    expect(num.sort(row(["12"]), ctx)).toBe(12);
    expect(num.sort(row(["<none>"]), ctx)).toBe(-1);
    expect(num.text(row(["1/2"]), ctx)).toBe("1/2");
  });

  it("classes status cells by value", () => {
    const [st] = columnsFor(kindWith([["status", "status"]]));
    expect(st.cls?.(row(["Running"]))).toBe("phase-Running");
  });

  it("computes age from the creation time", () => {
    const [age] = columnsFor(kindWith([["age", "age"]]));
    const r = row([""], { created: 100 });
    expect(age.text(r, { metrics, now: 160_000 })).toBe("60s");
    expect(age.text(r, { metrics, now: 290_000 })).toBe("3m10s");
    expect(age.sort(r, ctx)).toBe(100);
    expect(age.title?.(r, "utc")).toBe("Created 1970-01-01 00:01:40 UTC");
  });

  it("merges pod metrics by namespace/name", () => {
    const [cpu, mem] = columnsFor(
      kindWith([
        ["cpu", "podCpu"],
        ["memory", "podMemory"],
      ]),
    );
    expect(cpu.text(row(["", ""]), ctx)).toBe("250m");
    expect(mem.text(row(["", ""]), ctx)).toBe("64Mi");
    expect(cpu.sort(row(["", ""]), ctx)).toBe(250);
    const other = row(["", ""], { key: "demo/other" });
    expect(cpu.text(other, ctx)).toBe("—");
    expect(cpu.sort(other, ctx)).toBe(-1);
    expect(cpu.spark?.(row(["", ""]), ctx)).toEqual([100, 250]);
    expect(mem.spark?.(row(["", ""]), ctx)).toEqual([1, 2]);
    // No history yet: no sparkline.
    expect(cpu.spark?.(other, ctx)).toEqual([]);
    expect(cpu.text(row(["", ""]), { metrics: EMPTY_METRICS, now: 0 })).toBe("—");
  });

  it("merges node metrics by name, with capacity when known", () => {
    const [cpu, mem] = columnsFor(
      kindWith(
        [
          ["cpu", "nodeCpu"],
          ["memory", "nodeMemory"],
        ],
        "Node",
      ),
    );
    const node = row(["", ""], { key: "node-1", name: "node-1", namespace: "" });
    expect(cpu.text(node, ctx)).toBe("1.5 / 4");
    // Capacity 0 means unknown: no "/ ..." part.
    expect(mem.text(node, ctx)).toBe("1Gi");
    expect(mem.sort(node, ctx)).toBe(1024 ** 3);
    expect(cpu.spark?.(node, ctx)).toEqual([900, 1500]);
    expect(mem.spark?.(node, ctx)).toEqual([3, 4]);
  });

  it("shows the Disk column only once Prometheus reports disks", () => {
    const cols = columnsFor(
      kindWith(
        [
          ["name", "text"],
          ["disk", "nodeDisk"],
        ],
        "Node",
      ),
    );
    const disk = cols[1];
    const node = row(["node-1", ""], { key: "node-1", name: "node-1", namespace: "" });
    expect(shownColumns(cols, [], metrics).map((c) => c.key)).toEqual(["name"]);
    const withDisks: Metrics = {
      ...metrics,
      disks: new Map([["node-1", { name: "node-1", mountpoint: "/", used_bytes: 10 * 1024 ** 3, size_bytes: 40 * 1024 ** 3 }]]),
    };
    const c2: Ctx = { metrics: withDisks, now: 0 };
    expect(shownColumns(cols, [], withDisks).map((c) => c.key)).toEqual(["name", "disk"]);
    expect(shownColumns(cols, ["disk"], withDisks).map((c) => c.key)).toEqual(["name"]);
    expect(disk.text(node, c2)).toBe("25% · 10Gi / 40Gi");
    expect(disk.sort(node, c2)).toBe(25);
    const other = row(["x", ""], { key: "node-2", name: "node-2", namespace: "" });
    expect(disk.text(other, c2)).toBe("—");
    expect(disk.sort(other, c2)).toBe(-1);
  });

  it("drops every metric column while metrics are hidden (#327)", () => {
    const pods = columnsFor(
      kindWith([
        ["name", "text"],
        ["cpu", "podCpu"],
        ["memory", "podMemory"],
      ]),
    );
    const nodes = columnsFor(
      kindWith(
        [
          ["name", "text"],
          ["cpu", "nodeCpu"],
          ["memory", "nodeMemory"],
          ["disk", "nodeDisk"],
        ],
        "Node",
      ),
    );
    const withDisks: Metrics = {
      ...metrics,
      disks: new Map([["node-1", { name: "node-1", mountpoint: "/", used_bytes: 1, size_bytes: 2 }]]),
    };
    expect(shownColumns(pods, [], metrics).map((c) => c.key)).toEqual(["name", "cpu", "memory"]);
    expect(shownColumns(pods, [], HIDDEN_METRICS).map((c) => c.key)).toEqual(["name"]);
    expect(shownColumns(nodes, [], withDisks).map((c) => c.key)).toEqual(["name", "cpu", "memory", "disk"]);
    expect(shownColumns(nodes, [], { ...withDisks, hidden: true }).map((c) => c.key)).toEqual(["name"]);
  });

  it("leaves off-by-default columns out until they are turned on (#378)", () => {
    const kind = kindWith([
      ["name", "text"],
      ["owner", "owner"],
      ["qos", "text"],
    ]);
    kind.columns[1].default_hidden = true;
    kind.columns[2].default_hidden = true;
    const cols = columnsFor(kind);
    expect(cols.map((c) => c.defaultHidden)).toEqual([false, true, true]);
    expect(shownColumns(cols, [], metrics).map((c) => c.key)).toEqual(["name"]);
    expect(shownColumns(cols, [], metrics, ["qos"]).map((c) => c.key)).toEqual(["name", "qos"]);
    // The owner column's cell is the owner, and links to it.
    const owner = cols[1];
    expect(owner.link).toBe("owner");
    expect(owner.text(row(["web-1", "ReplicaSet/web-5d8f", ""]), ctx)).toBe("ReplicaSet/web-5d8f");
  });

  it("tells pods and nodes apart from other kinds", () => {
    expect(isPod(kindWith([], "Pod"))).toBe(true);
    expect(isPod(kindWith([], "Pod", "metrics.k8s.io"))).toBe(false);
    expect(isNode(kindWith([], "Node"))).toBe(true);
    expect(isNode(kindWith([], "Pod"))).toBe(false);
  });

  it("colours a node's Ready cell: amber when cordoned, red when not ready", () => {
    expect(nodeReadyClass("True")).toBe("");
    expect(nodeReadyClass("True,SchedulingDisabled")).toBe("phase-Pending");
    expect(nodeReadyClass("False")).toBe("phase-Failed");
    expect(nodeReadyClass("Unknown,SchedulingDisabled")).toBe("phase-Failed");
    const [, ready] = columnsFor(kindWith([["name", "text"], ["ready", "text"]], "Node"));
    expect(ready.cls?.(row(["n1", "True,SchedulingDisabled"]))).toBe("phase-Pending");
    // Only nodes: a pod's "ready" is a count.
    const [, podReady] = columnsFor(kindWith([["name", "text"], ["ready", "text"]]));
    expect(podReady.cls).toBeUndefined();
  });
});

describe("headerLabel", () => {
  it("puts the backend's labels in sentence case (#384)", () => {
    expect(headerLabel("Controlled By")).toBe("Controlled by");
    expect(headerLabel("Nominated Node")).toBe("Nominated node");
    expect(headerLabel("Up-to-date")).toBe("Up-to-date");
    expect(headerLabel("Name")).toBe("Name");
  });

  it("keeps acronyms and mixed-case words", () => {
    expect(headerLabel("CPU")).toBe("CPU");
    expect(headerLabel("QoS")).toBe("QoS");
    expect(headerLabel("External IP")).toBe("External IP");
  });

  it("lowers a label written in capitals, as some CRDs do", () => {
    expect(headerLabel("NAME")).toBe("Name");
    expect(headerLabel("LAST SEEN")).toBe("Last seen");
    expect(headerLabel("ready")).toBe("Ready");
  });
});

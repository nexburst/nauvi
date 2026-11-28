import { describe, expect, it } from "vitest";
import { MAX_RESULTS, completeQuery, parseQuery, pushRecent, rankItems, reasonsByItem, withReasons } from "./palette";
import type { PaletteItem } from "./palette";

describe("parseQuery", () => {
  it("reads the prefixes", () => {
    expect(parseQuery("> scale")).toEqual({ scope: "actions", text: "scale" });
    expect(parseQuery(">del")).toEqual({ scope: "actions", text: "del" });
    expect(parseQuery("ns demo")).toEqual({ scope: "namespaces", text: "demo" });
    expect(parseQuery("ctx kind")).toEqual({ scope: "contexts", text: "kind" });
    expect(parseQuery("win stag")).toEqual({ scope: "windows", text: "stag" });
    expect(parseQuery("win ")).toEqual({ scope: "windows", text: "" });
    expect(parseQuery("ns ")).toEqual({ scope: "namespaces", text: "" });
    // k9s's command mode (#575).
    expect(parseQuery(":pods")).toEqual({ scope: "kinds", text: "pods" });
    expect(parseQuery(":")).toEqual({ scope: "kinds", text: "" });
  });

  it("keeps `ns` alone as a search (the Namespaces alias)", () => {
    expect(parseQuery("ns")).toEqual({ scope: "all", text: "ns" });
    expect(parseQuery("nsfoo")).toEqual({ scope: "all", text: "nsfoo" });
  });
});

const item = (id: string, group: PaletteItem["group"], label: string, terms?: string[]): PaletteItem => ({
  id,
  group,
  label,
  terms,
  run: () => {},
});

const ITEMS: PaletteItem[] = [
  item("cmd:create", "Command", "Create resource…"),
  item("action:delete", "Action", "Delete"),
  item("kind:pods", "Kind", "Pods", ["pods", "Pod", "po"]),
  item("kind:deploy", "Kind", "Deployments", ["deployments", "Deployment", "deploy"]),
  item("kind:ds", "Kind", "DaemonSets", ["daemonsets", "DaemonSet", "ds"]),
  item("kind:ns", "Kind", "Namespaces", ["namespaces", "Namespace", "ns"]),
  item("ns:demo", "Namespace", "demo"),
  item("ctx:kind", "Context", "kind-nauvi-test"),
  item("obj:web", "Object", "pods/web-1", ["web-1"]),
];
const ids = (query: string, recent: string[] = []) => rankItems(ITEMS, query, recent).map((r) => r.item.id);

describe("rankItems", () => {
  it("finds kinds by kubectl alias", () => {
    expect(ids("deploy")[0]).toBe("kind:deploy");
    expect(ids("po")[0]).toBe("kind:pods");
    expect(ids("ns")[0]).toBe("kind:ns");
  });

  it("limits the scope with a prefix", () => {
    expect(ids(">")).toEqual(["cmd:create", "action:delete"]);
    expect(ids("ns ")).toEqual(["ns:demo"]);
    expect(ids("ctx ")).toEqual(["ctx:kind"]);
    expect(ids("ns dem")).toEqual(["ns:demo"]);
  });

  it("shows objects only once something is typed", () => {
    expect(ids("")).not.toContain("obj:web");
    expect(ids("web")).toEqual(["obj:web"]);
  });

  it("puts recent items first", () => {
    const ranked = rankItems(ITEMS, "", ["ns:demo", "kind:pods"]);
    expect(ranked.slice(0, 2).map((r) => [r.item.id, r.group])).toEqual([
      ["ns:demo", "Recent"],
      ["kind:pods", "Recent"],
    ]);
    // Listed once.
    expect(ranked.filter((r) => r.item.id === "ns:demo")).toHaveLength(1);
    // A recent item wins a close match.
    expect(ids("d", ["kind:ds"])[0]).toBe("kind:ds");
  });

  it("caps the results", () => {
    const many = Array.from({ length: 200 }, (_, i) => item(`obj:${i}`, "Object", `pods/p-${i}`));
    expect(rankItems(many, "p", [])).toHaveLength(MAX_RESULTS);
  });
});

describe("pushRecent", () => {
  it("moves the pick to the front and keeps ten", () => {
    let r: string[] = [];
    for (let i = 0; i < 12; i++) r = pushRecent(r, `x${i}`);
    expect(r).toHaveLength(10);
    expect(r[0]).toBe("x11");
    expect(pushRecent(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
  });
});

describe("access reasons (#349)", () => {
  const items: PaletteItem[] = [
    { id: "dock:Shell", group: "Action", label: "Shell", access: "shell", run: () => {} },
    { id: "action:delete", group: "Action", label: "Delete", access: "delete", run: () => {} },
    { id: "action:scale", group: "Action", label: "Scale", access: "scale", run: () => {} },
    { id: "cmd:refresh", group: "Command", label: "Refresh", run: () => {} },
  ];
  const no = "Not allowed: you can't delete pods in namespace demo";

  it("maps the refused access ids to their entries", () => {
    const r = reasonsByItem(
      items,
      new Map([
        ["delete", no],
        ["refresh", "x"],
      ]),
    );
    expect([...r]).toEqual([["action:delete", no]]);
  });

  it("sets the reason on the refused entries only", () => {
    const out = withReasons(items, new Map([["action:delete", no]]));
    expect(out.map((i) => i.reason)).toEqual([undefined, no, undefined, undefined]);
    expect(withReasons(items, new Map())).toBe(items);
  });
});

describe("completeQuery", () => {
  const kind: PaletteItem = { id: "kind:v1/namespaces", group: "Kind", label: "Namespaces", complete: "namespaces", run: () => {} };
  const ns: PaletteItem = { id: "ns:kube-system", group: "Namespace", label: "kube-system", complete: "kube-system", run: () => {} };
  const cmd: PaletteItem = { id: "cmd:refresh", group: "Command", label: "Refresh", run: () => {} };

  it("keeps the prefix the user typed (#591)", () => {
    expect(completeQuery(":na", kind)).toBe(":namespaces");
    expect(completeQuery("  :na", kind)).toBe(":namespaces");
    expect(completeQuery("na", kind)).toBe("namespaces");
    expect(completeQuery("ns kube", ns)).toBe("ns kube-system");
    expect(completeQuery("NS  ku", ns)).toBe("NS kube-system");
    expect(completeQuery("ctx dev", { ...ns, complete: "kind-dev" })).toBe("ctx kind-dev");
    expect(completeQuery("win dev", { ...ns, complete: "kind-dev" })).toBe("win kind-dev");
  });

  it("has nothing for an item without a completion, or an already complete query", () => {
    expect(completeQuery("> ref", cmd)).toBeNull();
    expect(completeQuery(":namespaces", kind)).toBeNull();
    expect(completeQuery(":namespaces ", kind)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  applyPatch,
  clampWidth,
  columnOn,
  columnsChanged,
  contextToRestore,
  DEFAULT_COLUMNS,
  defaultSettings,
  EMPTY_CONTEXT,
  DEFAULT_DETAIL_WIDTH,
  MIN_DETAIL_WIDTH,
  namespacesToRestore,
  sortOf,
  themeAttribute,
  prometheusSettingError,
  toggleColumn,
  toggleHidden,
  withSort,
} from "./settings";

const ctx = (name: string, current = false) => ({ name, current, namespace: null });

describe("applyPatch", () => {
  it("changes only the fields given", () => {
    const s = applyPatch(defaultSettings(), { theme: "light", detail_width: 600 });
    expect(s.theme).toBe("light");
    expect(s.detail_width).toBe(600);
    expect(s.logs).toEqual(defaultSettings().logs);
  });

  it("replaces only the map entries given", () => {
    let s = applyPatch(defaultSettings(), {
      kinds: { a: { sort_key: "name", sort_desc: false, hidden: [], shown: [], widths: {} }, b: { sort_key: "age", sort_desc: true, hidden: [], shown: [], widths: {} } },
    });
    s = applyPatch(s, { kinds: { a: { sort_key: "status", sort_desc: false, hidden: ["node"], shown: [], widths: {} } } });
    expect(s.kinds.a).toEqual({ sort_key: "status", sort_desc: false, hidden: ["node"], shown: [], widths: {} });
    expect(s.kinds.b.sort_key).toBe("age");
  });

  it("does not change the settings it was given", () => {
    const before = defaultSettings();
    applyPatch(before, { contexts: { x: { ...EMPTY_CONTEXT, view: "v1/pods" } } });
    expect(before.contexts).toEqual({});
  });
});

describe("contextToRestore", () => {
  it("restores a remembered context that still exists", () => {
    expect(contextToRestore("prod", [ctx("dev", true), ctx("prod")])).toBe("prod");
  });
  it("falls back when it is gone, already current or never set", () => {
    expect(contextToRestore("old", [ctx("dev", true)])).toBeNull();
    expect(contextToRestore("dev", [ctx("dev", true)])).toBeNull();
    expect(contextToRestore("", [ctx("dev", true)])).toBeNull();
  });
});

describe("namespacesToRestore", () => {
  it("drops namespaces that no longer exist", () => {
    expect(namespacesToRestore(["demo", "gone"], ["demo", "default"], false)).toEqual(["demo"]);
  });
  it("uses the default scope when none is left or none was remembered", () => {
    expect(namespacesToRestore(["gone"], ["demo"], false)).toBeNull();
    expect(namespacesToRestore([], ["demo"], false)).toBeNull();
  });
  it("keeps typed namespaces when they cannot be listed", () => {
    expect(namespacesToRestore(["team-a"], [], true)).toEqual(["team-a"]);
  });
});

describe("sort", () => {
  it("round-trips through the kind settings", () => {
    const k = withSort(undefined, { key: "age", dir: "desc" });
    expect(k).toEqual({ sort_key: "age", sort_desc: true, hidden: [], shown: [], widths: {} });
    expect(sortOf(k)).toEqual({ key: "age", dir: "desc" });
    expect(sortOf(withSort(k, null))).toBeNull();
    expect(withSort({ ...k, hidden: ["x"] }, null).hidden).toEqual(["x"]);
  });
});

describe("toggleHidden", () => {
  it("hides and shows a column, never the name", () => {
    expect(toggleHidden([], "node")).toEqual(["node"]);
    expect(toggleHidden(["node", "ip"], "node")).toEqual(["ip"]);
    expect(toggleHidden([], "name")).toEqual([]);
  });
});

describe("off-by-default columns (#378)", () => {
  const node = { key: "node", defaultHidden: false };
  const qos = { key: "qos", defaultHidden: true };
  const cols = [node, qos];

  it("are off until turned on; the others are on until hidden", () => {
    const fresh = { hidden: [], shown: [] };
    expect(columnOn(fresh, node)).toBe(true);
    expect(columnOn(fresh, qos)).toBe(false);
    expect(columnOn({ hidden: ["node"], shown: ["qos"] }, node)).toBe(false);
    expect(columnOn({ hidden: ["node"], shown: ["qos"] }, qos)).toBe(true);
    // Hiding an off-by-default column does not apply to it.
    expect(columnOn({ hidden: ["qos"], shown: [] }, qos)).toBe(false);
  });

  it("toggle in `shown`, the others in `hidden`", () => {
    const fresh = { hidden: [], shown: [] };
    expect(toggleColumn(fresh, qos)).toEqual({ shown: ["qos"] });
    expect(toggleColumn({ hidden: [], shown: ["qos"] }, qos)).toEqual({ shown: [] });
    expect(toggleColumn(fresh, node)).toEqual({ hidden: ["node"] });
  });

  it("keep working with settings from before them, which have no `shown`", () => {
    const old = { hidden: ["node"] } as unknown as { hidden: string[]; shown: string[] };
    expect(columnOn(old, qos)).toBe(false);
    expect(toggleColumn(old, qos)).toEqual({ shown: ["qos"] });
    expect(columnsChanged(old, cols)).toBe(true);
  });

  it("Default columns is what a fresh install shows", () => {
    expect(columnsChanged(DEFAULT_COLUMNS, cols)).toBe(false);
    expect(columnsChanged({ hidden: [], shown: ["qos"] }, cols)).toBe(true);
    expect(columnsChanged({ hidden: ["node"], shown: [] }, cols)).toBe(true);
    // A hidden key of a column the kind no longer has changes nothing.
    expect(columnsChanged({ hidden: ["gone"], shown: [] }, cols)).toBe(false);
    expect(columnOn(DEFAULT_COLUMNS, node) && !columnOn(DEFAULT_COLUMNS, qos)).toBe(true);
  });
});

describe("clampWidth", () => {
  it("keeps the width between the minimum and 75% of the window", () => {
    expect(clampWidth(100, 1600)).toBe(MIN_DETAIL_WIDTH);
    expect(clampWidth(5000, 1600)).toBe(1200);
    expect(clampWidth(500.4, 1600)).toBe(500);
  });
  it("uses the default for a missing width", () => {
    expect(clampWidth(0, 1600)).toBe(DEFAULT_DETAIL_WIDTH);
    expect(clampWidth(Number.NaN, 1600)).toBe(DEFAULT_DETAIL_WIDTH);
  });
});

it("themeAttribute: System leaves it to the media query", () => {
  expect(themeAttribute("system")).toBeNull();
  expect(themeAttribute("light")).toBe("light");
  expect(themeAttribute("dark")).toBe("dark");
});

describe("prometheusSettingError", () => {
  it("takes empty, off and namespace/service[:port]", () => {
    for (const ok of ["", "  ", "off", "OFF", "monitoring/prometheus-k8s:web", "obs/prom", "obs/prom:9090"]) {
      expect(prometheusSettingError(ok), ok).toBe("");
    }
    for (const bad of ["prom", "obs/", "/prom", "obs/prom:", "obs/prom:9090/x", "a b/c"]) {
      expect(prometheusSettingError(bad), bad).toMatch(/^Use namespace\/service:port/);
    }
  });
});

import { describe, expect, it } from "vitest";
import { berthCode, idCode, parseBerths, pinBerth, pinnable, unpinBerth, viewLabel, DEFAULT_BERTHS } from "./berths";

const kinds = [
  { id: "v1/pods", label: "Pods", short_names: ["po"] },
  { id: "apps/v1/deployments", label: "Deployments", short_names: ["deployment", "deploy"] },
  { id: "x/v1/widgets", label: "Fancy Widgets", short_names: [] },
];

describe("berths", () => {
  it("speak kubectl: the shortest short name, else the start of the label", () => {
    expect(berthCode("v1/pods", kinds)).toBe("po");
    expect(berthCode("apps/v1/deployments", kinds)).toBe("dep");
    expect(berthCode("x/v1/widgets", kinds)).toBe("fan");
    expect(berthCode("overview", kinds)).toBe("ov");
    expect(berthCode("helm", kinds)).toBe("helm");
    expect(berthCode("gone/v1/things", kinds)).toBe("?");
    expect(viewLabel("v1/pods", kinds)).toBe("Pods");
    expect(viewLabel("port-forwards", kinds)).toBe("Port Forwards");
  });

  it("still say something while the cluster is not known", () => {
    expect(idCode("v1/pods")).toBe("pod");
    expect(idCode("apps/v1/deployments")).toBe("dep");
    expect(idCode("v1/services")).toBe("ser");
    expect(idCode("")).toBe("?");
  });

  it("are added only up to the limit, and never twice", () => {
    expect(pinBerth(["a"], "b")).toEqual({ berths: ["a", "b"], full: false });
    expect(pinBerth(["a"], "a")).toEqual({ berths: ["a"], full: false });
    expect(pinBerth(["a", "b"], "c", 2)).toEqual({ berths: ["a", "b"], full: true });
    // The Overview has its own berth; the catalog is not a place in a cluster.
    expect(pinnable("overview")).toBe(false);
    expect(pinnable("catalog")).toBe(false);
    expect(pinBerth([], "overview").berths).toEqual([]);
  });

  it("can always be removed", () => {
    expect(unpinBerth(["a", "b", "c"], "b")).toEqual(["a", "c"]);
    expect(unpinBerth(["a"], "x")).toEqual(["a"]);
  });

  it("start from the defaults, and survive a broken store", () => {
    expect(parseBerths(null)).toEqual(DEFAULT_BERTHS);
    expect(parseBerths("{nope")).toEqual(DEFAULT_BERTHS);
    expect(parseBerths("[]")).toEqual([]);
    expect(parseBerths('["v1/pods", 3]')).toEqual(["v1/pods"]);
  });
});

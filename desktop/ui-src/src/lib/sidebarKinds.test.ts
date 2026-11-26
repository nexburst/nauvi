import { describe, expect, it } from "vitest";
import { matches, normalizeFilter, splitCommon } from "./sidebarKinds";

const k = (kind: string, crd = false) => ({ category: "workloads" as const, crd, resource: { kind } });

describe("the sidebar's order", () => {
  it("puts the common kinds first, in their order, and the rest under More", () => {
    const list = [k("ReplicaSet"), k("Job"), k("Pod"), k("Deployment"), k("ReplicationController")];
    const { common, more } = splitCommon("workloads", list);
    expect(common.map((x) => x.resource.kind)).toEqual(["Pod", "Deployment", "Job"]);
    expect(more.map((x) => x.resource.kind)).toEqual(["ReplicaSet", "ReplicationController"]);
  });

  it("a CRD named like a built-in kind is not common", () => {
    expect(splitCommon("workloads", [k("Pod", true)]).more).toHaveLength(1);
  });

  it("a section without a list shows everything; Device Resources keeps all under More", () => {
    expect(splitCommon("custom", [k("Widget")]).common).toHaveLength(1);
    const devices = [{ category: "devices" as const, crd: false, resource: { kind: "DeviceClass" } }];
    expect(splitCommon("devices", devices)).toEqual({ common: [], more: devices });
  });

  it("the filter matches any name, ignoring case and spaces around it", () => {
    const f = normalizeFilter("  Deploy ");
    expect(matches(f, "Deployments", "deploy")).toBe(true);
    expect(matches(f, "Pods", "po")).toBe(false);
    expect(matches("", "anything")).toBe(true);
  });
});

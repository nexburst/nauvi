import { describe, expect, it } from "vitest";
import type { ResourceKind } from "./bindings";
import { cellLink } from "./cellLinks";

function kind(group: string, name: string, namespaced = true): ResourceKind {
  return {
    resource: { group, version: "v1", kind: name, plural: name.toLowerCase() + "s", namespaced },
    id: `${group}/v1/${name}`,
    label: name + "s",
    category: "workloads",
    crd: false,
    verbs: [],
    short_names: [],
    columns: [],
    actions: [],
  };
}

const NODE = kind("", "Node", false);
const POD = kind("", "Pod");
const RS = kind("apps", "ReplicaSet");
const PV = kind("", "PersistentVolume", false);
const KINDS = [NODE, POD, RS, PV];

describe("cell links", () => {
  it("a namespace cell shows the same kind in that namespace", () => {
    expect(cellLink(KINDS, POD, { key: "namespace" }, "demo", "demo")).toEqual({
      to: "namespace",
      namespace: "demo",
      title: "Show Pods in namespace demo",
    });
  });

  it("a node cell opens the node, an owner cell the owner", () => {
    expect(cellLink(KINDS, POD, { key: "node" }, "node-1", "demo")).toMatchObject({
      to: "object",
      kind: NODE,
      namespace: "",
      name: "node-1",
      title: "Open node node-1",
    });
    expect(cellLink(KINDS, POD, { key: "owner", link: "owner" }, "ReplicaSet/web-5d8f", "demo")).toMatchObject({
      to: "object",
      kind: RS,
      namespace: "demo",
      name: "web-5d8f",
    });
  });

  it("empty cells, other columns and kinds the cluster does not serve stay text", () => {
    expect(cellLink(KINDS, POD, { key: "namespace" }, "", "")).toBeNull();
    expect(cellLink(KINDS, POD, { key: "status" }, "Running", "demo")).toBeNull();
    expect(cellLink([POD], POD, { key: "node" }, "node-1", "demo")).toBeNull();
    expect(cellLink(KINDS, POD, { key: "owner", link: "owner" }, "Rollout.argoproj.io/x", "demo")).toBeNull();
    // A cluster-scoped kind has no namespace column to link.
    expect(cellLink(KINDS, PV, { key: "namespace" }, "demo", "")).toBeNull();
  });
});

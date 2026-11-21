import { describe, expect, it } from "vitest";
import type { ResourceKind } from "./bindings";
import { ownerKind, ownerTarget, parseOwner } from "./owner";

function kind(group: string, name: string, namespaced = true): ResourceKind {
  return {
    resource: {
      group,
      version: "v1",
      kind: name,
      plural: name.toLowerCase() + "s",
      namespaced,
    },
    id: `${group}/v1/${name}`,
    label: name,
    category: "workloads",
    crd: group.includes("."),
    verbs: [],
    short_names: [],
    columns: [],
    actions: [],
  };
}

const KINDS = [
  kind("", "Node", false),
  kind("apps", "ReplicaSet"),
  kind("batch", "Job"),
  kind("argoproj.io", "Rollout"),
  // A CRD with a built-in kind's name: only `ReplicaSet.example.com/...` means it.
  kind("example.com", "ReplicaSet"),
];

describe("parseOwner", () => {
  it("reads Kind/name and Kind.group/name", () => {
    expect(parseOwner("ReplicaSet/web-7d9f")).toEqual({
      kind: "ReplicaSet",
      group: null,
      name: "web-7d9f",
    });
    expect(parseOwner("Rollout.argoproj.io/web")).toEqual({
      kind: "Rollout",
      group: "argoproj.io",
      name: "web",
    });
  });
  it("gives up on an empty or malformed cell", () => {
    for (const cell of ["", "web", "/web", "ReplicaSet/", ".x/web", "Rollout./web"]) {
      expect(parseOwner(cell), cell).toBeNull();
    }
  });
});

describe("ownerKind", () => {
  it("finds a plain kind in the built-in groups, not in a CRD of the same name", () => {
    expect(ownerKind(KINDS, { kind: "ReplicaSet", group: null, name: "x" })?.resource.group).toBe("apps");
    expect(ownerKind(KINDS, { kind: "ReplicaSet", group: "example.com", name: "x" })?.resource.group).toBe(
      "example.com",
    );
    expect(ownerKind(KINDS, { kind: "StatefulSet", group: null, name: "x" })).toBeUndefined();
  });
});

describe("ownerTarget", () => {
  it("opens a namespaced owner in the pod's namespace and a node without one", () => {
    const rs = ownerTarget(KINDS, "ReplicaSet/web-7d9f", "shop");
    expect(rs && [rs.kind.id, rs.namespace, rs.name]).toEqual(["apps/v1/ReplicaSet", "shop", "web-7d9f"]);
    const node = ownerTarget(KINDS, "Node/kind-control-plane", "kube-system");
    expect(node && [node.kind.id, node.namespace, node.name]).toEqual(["/v1/Node", "", "kind-control-plane"]);
  });
  it("has nothing to open for an unknown kind or an empty cell", () => {
    expect(ownerTarget(KINDS, "Widget.example.org/w", "shop")).toBeNull();
    expect(ownerTarget(KINDS, "", "shop")).toBeNull();
  });
});

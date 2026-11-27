import { describe, expect, it } from "vitest";
import type { ObjectLink, ResourceKind } from "./bindings";
import { linkApiVersion, linkKind, linkProblem, linkTitle } from "./links";

const kind = (group: string, version: string, k: string, namespaced = true): ResourceKind => ({
  resource: { group, version, kind: k, plural: k.toLowerCase() + "s", namespaced },
  id: `${group ? group + "/" : ""}${version}/${k.toLowerCase()}s`,
  label: k + "s",
  category: "workloads",
  crd: false,
  verbs: [],
  short_names: [],
  columns: [],
  actions: [],
});

const link = (over: Partial<ObjectLink> = {}): ObjectLink => ({
  context: "kind-test",
  group: "",
  version: "v1",
  kind: "Pod",
  namespace: "demo",
  name: "web",
  ...over,
});

const kinds = [
  kind("", "v1", "Pod"),
  kind("", "v1", "Node", false),
  kind("apps", "v1", "Deployment"),
  kind("autoscaling", "v2", "HorizontalPodAutoscaler"),
];

describe("links", () => {
  it("names the API version", () => {
    expect(linkApiVersion(link())).toBe("v1");
    expect(linkApiVersion(link({ group: "apps" }))).toBe("apps/v1");
  });

  it("finds the kind, at the served version if the link's is gone", () => {
    expect(linkKind(kinds, link())?.id).toBe("v1/pods");
    expect(linkKind(kinds, link({ group: "apps", kind: "Deployment" }))?.id).toBe("apps/v1/deployments");
    const hpa = link({ group: "autoscaling", version: "v1", kind: "HorizontalPodAutoscaler" });
    expect(linkKind(kinds, hpa)?.id).toBe("autoscaling/v2/horizontalpodautoscalers");
    expect(linkKind(kinds, link({ group: "apps", kind: "Pod" }))).toBeUndefined();
  });

  it("says why a link can't be shown", () => {
    const pod = linkKind(kinds, link());
    expect(linkProblem(link(), "kind-test", pod)).toBe("");
    expect(linkProblem(link(), "prod", pod)).toMatch(/for the context kind-test, but this window shows prod/);
    expect(linkProblem(link({ kind: "Widget", group: "x.io" }), "kind-test", undefined)).toBe(
      "kind-test does not serve Widget (x.io/v1). Nothing was opened.",
    );
    expect(linkProblem(link({ namespace: "" }), "kind-test", pod)).toMatch(/lives in a namespace/);
    const node = linkKind(kinds, link({ kind: "Node" }));
    expect(linkProblem(link({ kind: "Node", namespace: "demo" }), "kind-test", node)).toMatch(/cluster-scoped/);
    expect(linkProblem(link({ kind: "Node", namespace: "" }), "kind-test", node)).toBe("");
  });

  it("takes a kind's table from nauvi show (#548)", () => {
    const pods = linkKind(kinds, link({ name: "" }));
    expect(linkProblem(link({ name: "", namespace: "" }), "kind-test", pods)).toBe("");
    expect(linkProblem(link({ name: "", namespace: "demo" }), "kind-test", pods)).toBe("");
    const node = linkKind(kinds, link({ kind: "Node", name: "" }));
    expect(linkProblem(link({ kind: "Node", namespace: "", name: "" }), "kind-test", node)).toBe("");
    expect(linkProblem(link({ kind: "Node", namespace: "demo", name: "" }), "kind-test", node)).toMatch(/cluster-scoped/);
    expect(linkTitle(link({ name: "", namespace: "demo" }))).toBe("the Pod table in demo");
    expect(linkTitle(link({ kind: "Node", namespace: "", name: "n1" }))).toBe("Node n1");
  });
});

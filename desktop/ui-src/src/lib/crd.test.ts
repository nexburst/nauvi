import { describe, expect, it } from "vitest";
import type { ResourceKind } from "./bindings";
import { crdInstancesKind, isCrdDefinitions } from "./crd";

const kind = (group: string, k: string, plural: string): ResourceKind => ({
  resource: { group, version: "v1", kind: k, plural, namespaced: true },
  id: `${group}/v1/${plural}`,
  label: k,
  category: "custom",
  crd: true,
  verbs: [],
  short_names: [],
  columns: [],
  actions: [],
});

describe("crd", () => {
  const widgets = kind("example.com", "Widget", "widgets");
  const gadgets = kind("example.org", "Widget", "widgets");
  const all = [kind("apiextensions.k8s.io", "CustomResourceDefinition", "customresourcedefinitions"), widgets, gadgets];

  it("recognises the definitions kind", () => {
    expect(isCrdDefinitions(all[0].resource)).toBe(true);
    expect(isCrdDefinitions(widgets.resource)).toBe(false);
  });

  it("finds a CRD's instances by <plural>.<group>", () => {
    expect(crdInstancesKind(all, "widgets.example.com")).toBe(widgets);
    expect(crdInstancesKind(all, "widgets.example.org")).toBe(gadgets);
    expect(crdInstancesKind(all, "widgets.example.net")).toBeUndefined();
    expect(crdInstancesKind(all, "widgets")).toBeUndefined();
  });
});

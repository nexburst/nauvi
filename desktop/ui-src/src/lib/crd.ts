import type { ResourceKind, ResourceRef } from "./bindings";

/** Whether `r` is the CustomResourceDefinition kind itself (the
 *  "Definitions" list under Custom Resources). */
export function isCrdDefinitions(r: ResourceRef): boolean {
  return r.group === "apiextensions.k8s.io" && r.kind === "CustomResourceDefinition";
}

/** The discovered kind of the instances of the CRD named `name`
 *  (`<plural>.<group>`, which is what every CRD must be called). */
export function crdInstancesKind(all: ResourceKind[], name: string): ResourceKind | undefined {
  const dot = name.indexOf(".");
  if (dot <= 0) return undefined;
  const plural = name.slice(0, dot);
  const group = name.slice(dot + 1);
  return all.find((k) => k.resource.plural === plural && k.resource.group === group);
}

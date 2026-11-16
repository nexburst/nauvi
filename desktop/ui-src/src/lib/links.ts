// kubeloupe:// links (#299): what an opened link points at, in the
// discovered kinds. The backend has already checked every part of the link
// and that its context is one of the user's.

import type { ObjectLink, ResourceKind } from "./bindings";

/** `apps/v1`, or `v1` for the core group. */
export function linkApiVersion(link: ObjectLink): string {
  return link.group ? `${link.group}/${link.version}` : link.version;
}

/**
 * The kind the link names: the same group, version and kind, else the same
 * group and kind at the version the cluster serves now.
 */
export function linkKind(kinds: ResourceKind[], link: ObjectLink): ResourceKind | undefined {
  const same = (k: ResourceKind) => k.resource.group === link.group && k.resource.kind === link.kind;
  return kinds.find((k) => same(k) && k.resource.version === link.version) ?? kinds.find(same);
}

/** Why the link can't be shown in a window on `current` with `kinds`, or "". */
export function linkProblem(link: ObjectLink, current: string, kind: ResourceKind | undefined): string {
  if (link.context !== current) {
    return `This link is for the context ${link.context}, but this window shows ${current || "another one"}. Nothing was opened.`;
  }
  if (!kind) return `${current} does not serve ${link.kind} (${linkApiVersion(link)}). Nothing was opened.`;
  if (kind.resource.namespaced !== (link.namespace !== "")) {
    const scope = kind.resource.namespaced ? "lives in a namespace" : "is cluster-scoped";
    return `A ${link.kind} ${scope}, but the link says otherwise. Nothing was opened.`;
  }
  return "";
}

// The Controlled By cell of a pod (#378): `Kind/name`, or `Kind.group/name`
// outside the groups of the built-in controllers (`controlled_by` in
// src/resources/columns.rs), and the kind it links to.

import type { ResourceKind } from "./bindings";

/** The groups an owner cell leaves out: core, `apps`, `batch`. */
const PLAIN_GROUPS = ["", "apps", "batch"];

export interface OwnerRef {
  kind: string;
  /** `null`: one of the plain groups, whichever serves the kind. */
  group: string | null;
  name: string;
}

/** The owner a cell names, or `null` for an empty or malformed cell. */
export function parseOwner(cell: string): OwnerRef | null {
  const slash = cell.indexOf("/");
  if (slash <= 0 || slash === cell.length - 1) return null;
  const head = cell.slice(0, slash);
  const name = cell.slice(slash + 1);
  const dot = head.indexOf(".");
  if (dot < 0) return { kind: head, group: null, name };
  if (dot === 0 || dot === head.length - 1) return null;
  return { kind: head.slice(0, dot), group: head.slice(dot + 1), name };
}

/** The discovered kind an owner is of, if the cluster serves it. */
export function ownerKind(kinds: readonly ResourceKind[], owner: OwnerRef): ResourceKind | undefined {
  const groups = owner.group === null ? PLAIN_GROUPS : [owner.group];
  for (const g of groups) {
    const k = kinds.find((k) => k.resource.group === g && k.resource.kind === owner.kind);
    if (k) return k;
  }
  return undefined;
}

/** Where a Controlled By cell of a row in `namespace` leads: the owner's
 *  kind, namespace (an owner is in its dependent's namespace, or cluster
 *  scoped) and name; `null` when there is nothing to open. */
export function ownerTarget(
  kinds: readonly ResourceKind[],
  cell: string,
  namespace: string,
): { kind: ResourceKind; namespace: string; name: string } | null {
  const owner = parseOwner(cell);
  const kind = owner && ownerKind(kinds, owner);
  if (!owner || !kind) return null;
  return {
    kind,
    namespace: kind.resource.namespaced ? namespace : "",
    name: owner.name,
  };
}

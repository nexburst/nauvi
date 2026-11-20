// Table cells that act as links (#382): a Namespace cell shows the same kind
// in that namespace, a Node cell opens the node's detail, and a Controlled By
// cell (#378) opens the owner's detail.

import type { ResourceKind } from "./bindings";
import { ownerTarget } from "./owner";

export type CellLink =
  | { to: "namespace"; namespace: string; title: string }
  | { to: "object"; kind: ResourceKind; namespace: string; name: string; title: string };

/** Where the cell `text` of column `col` (key and kind) in a row of `kind`
 *  leads, or `null` for a cell that is plain text. */
export function cellLink(
  kinds: readonly ResourceKind[],
  kind: ResourceKind,
  col: { key: string; link?: "owner" },
  text: string,
  rowNamespace: string,
): CellLink | null {
  if (!text) return null;
  if (col.link === "owner") {
    const t = ownerTarget(kinds, text, rowNamespace);
    return t ? { to: "object", ...t, title: `Open ${text}` } : null;
  }
  if (col.key === "namespace" && kind.resource.namespaced) {
    return { to: "namespace", namespace: text, title: `Show ${kind.label} in namespace ${text}` };
  }
  if (col.key === "node") {
    const node = kinds.find((k) => k.resource.group === "" && k.resource.kind === "Node");
    return node ? { to: "object", kind: node, namespace: "", name: text, title: `Open node ${text}` } : null;
  }
  return null;
}

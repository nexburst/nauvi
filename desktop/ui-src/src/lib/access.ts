/**
 * Which actions RBAC allows (#218, #340): the row menu and the bulk bar ask
 * `cmdCheckActions` (SelfSubjectAccessReviews, cached in the backend per
 * verb, kind and namespace, and dropped on a context switch) and grey out
 * what would be refused, with the missing permission as the reason; so do
 * the command palette and the keyboard Delete (#349). The backend puts a
 * read-only context's reason first (#338). A check that cannot be made
 * counts as allowed: the API server has the last word.
 */

import type { ActionAccess, ResourceRef } from "./bindings";
import { api, visibleCluster } from "./cluster";

/** The reasons of the refused actions, by id. */
export function deniedReasons(list: ActionAccess[]): Map<string, string> {
  return new Map(list.filter((a) => !a.allowed).map((a) => [a.id, a.reason]));
}

/** The distinct namespaces of `targets`, in order ("" for cluster-scoped objects). */
export function namespacesOf(targets: { namespace: string }[]): string[] {
  return [...new Set(targets.map((t) => t.namespace))];
}

/** The first reason among `reasons` (one per namespace of a bulk action), or "" when none refuses. */
export function firstDenied(reasons: (string | undefined)[]): string {
  return reasons.find((r) => !!r) ?? "";
}

/** Ask which of `ids` are refused on objects of `resource` in `namespace`.
 *  Empty when the check fails, or when the window switched to another
 *  cluster before it answered (the answer is about the old one, #349). */
export async function deniedActions(
  resource: ResourceRef,
  namespace: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const asked = visibleCluster();
  try {
    const list = await api(asked).cmdCheckActions(resource, namespace, ids);
    return visibleCluster() === asked ? deniedReasons(list) : new Map();
  } catch {
    return new Map();
  }
}

/** Why deleting `targets` (objects of `resource`) is refused: the reason
 *  of the first of their namespaces that refuses it, or "". */
export async function deleteDenied(resource: ResourceRef, targets: { namespace: string }[]): Promise<string> {
  const answers = await Promise.all(namespacesOf(targets).map((ns) => deniedActions(resource, ns, ["delete"])));
  return firstDenied(answers.map((a) => a.get("delete")));
}

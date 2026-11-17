/**
 * Which actions RBAC allows (#218, #340): the row menu and the bulk bar ask
 * `cmdCheckActions` (SelfSubjectAccessReviews, cached in the backend per
 * verb, kind and namespace, and dropped on a context switch) and grey out
 * what would be refused, with the missing permission as the reason. A check
 * that cannot be made counts as allowed: the API server has the last word.
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

/** Ask which of `ids` are refused on objects of `resource` in `namespace`. Empty when the check fails. */
export async function deniedActions(
  resource: ResourceRef,
  namespace: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  try {
    return deniedReasons(await api(visibleCluster()).cmdCheckActions(resource, namespace, ids));
  } catch {
    return new Map();
  }
}

// Why a table is empty, and the one thing to do about it (#485): the
// filter hides every row (it is shared by every table, so it may come from
// another kind), the namespace has none, the user may not list the kind,
// or there are none at all.

import { joinNames } from "./namespaces";
import { PROBLEMS_STATUS } from "./workloads";

/** A button of the empty state; `ResourceTable` knows what each does. */
export type EmptyAction = "clearFilter" | "clearStatus" | "allNamespaces" | "create";

export interface EmptyState {
  /** Which case it is, for tests and styling. */
  reason: "loading" | "denied" | "filter" | "status" | "namespace" | "none";
  title: string;
  /** A second line that says why or what else to try ("" for none). */
  detail: string;
  actions: { id: EmptyAction; label: string }[];
}

export interface EmptyInput {
  /** The kind's display name, plural ("Deployments"). */
  label: string;
  /** Its plural and API group, for "list deployments.apps". */
  plural: string;
  group: string;
  namespaced: boolean;
  /** The kind's API verbs: a "create" offers Create. */
  verbs: readonly string[];
  /** The namespaces shown (empty: all). */
  namespaces: readonly string[];
  /** The toolbar filter's text. */
  search: string;
  /** The status filter of the Workloads overview ("" for none). */
  status: string;
  /** Rows before the filters. */
  total: number;
  /** A first batch has arrived (else the rows are still coming). */
  synced: boolean;
  /** The user may not list the kind in this scope (an access check or a 403). */
  denied: boolean;
}

/** The empty state of a table with no rows to show. */
export function emptyState(i: EmptyInput): EmptyState {
  const where = scopeWords(i);
  const resource = i.group ? `${i.plural}.${i.group}` : i.plural;
  if (i.denied) {
    const all = i.namespaced && i.namespaces.length === 0;
    return {
      reason: "denied",
      title: `No access to ${i.label}${all ? " across all namespaces" : where}`,
      detail: all
        ? `Your account may not "list" ${resource} across all namespaces. Pick a namespace you have access to.`
        : `Your account may not "list" ${resource}${where}. Ask a cluster admin for access, or look elsewhere.`,
      actions: [],
    };
  }
  if (!i.synced) return { reason: "loading", title: `Loading ${i.label}…`, detail: "", actions: [] };
  if (i.total > 0 && i.search) {
    return {
      reason: "filter",
      title: `No ${i.label} match "${i.search}"`,
      detail: `The filter hides ${all(i.total)}${where}. It stays on as you go from table to table.`,
      actions: [{ id: "clearFilter", label: "Clear filter" }],
    };
  }
  if (i.total > 0 && i.status === PROBLEMS_STATUS) {
    return {
      reason: "status",
      title: `No ${i.label} need attention`,
      detail: `${i.total === 1 ? "The only one is" : `All ${i.total} are`} fine${where}.`,
      actions: [{ id: "clearStatus", label: "Show all" }],
    };
  }
  if (i.total > 0 && i.status) {
    return {
      reason: "status",
      title: `No ${i.label} with status ${i.status}`,
      detail: `The status filter hides ${all(i.total)}${where}.`,
      actions: [{ id: "clearStatus", label: "Show every status" }],
    };
  }
  const create = i.verbs.includes("create") ? [{ id: "create" as const, label: "Create…" }] : [];
  if (i.namespaced && i.namespaces.length > 0) {
    return {
      reason: "namespace",
      title: `No ${i.label}${where}`,
      detail: "Other namespaces may have some.",
      actions: [{ id: "allNamespaces", label: "All namespaces" }, ...create],
    };
  }
  return {
    reason: "none",
    title: i.namespaced ? `No ${i.label} in any namespace` : `No ${i.label} in this cluster`,
    detail: "",
    actions: create,
  };
}

/** The empty state of a list that is not a kind's table (Helm releases, Applications). */
export function listEmptyState(
  i: Pick<EmptyInput, "label" | "namespaces" | "search" | "total" | "synced">,
): EmptyState {
  return emptyState({ ...i, plural: "", group: "", namespaced: true, verbs: [], status: "", denied: false });
}

/** " in namespace demo", " in namespaces a and b", or "" for all. */
function scopeWords(i: Pick<EmptyInput, "namespaced" | "namespaces">): string {
  if (!i.namespaced || i.namespaces.length === 0) return "";
  if (i.namespaces.length === 1) return ` in namespace ${i.namespaces[0]}`;
  return ` in namespaces ${joinNames([...i.namespaces])}`;
}

/** "the only one" or "all 12". */
function all(n: number): string {
  return n === 1 ? "the only one" : `all ${n}`;
}

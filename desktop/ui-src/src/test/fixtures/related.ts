// What `cmd_get_related` returns in the fake cluster, by `kindId|rowKey`.
// Objects without an entry get `NO_RELATED` (like a kind the backend has no
// relations for).

import type { Related, RelatedGroup, RelatedItem } from "../../lib/bindings";

export const NO_RELATED: Related = { summary: [], facts: [], groups: [] };

/** A group of objects of `kind`; each row is `[name, ...cells]`. */
export function objects(
  title: string,
  apiVersion: string,
  kind: string,
  columns: string[],
  rows: { namespace: string; cells: string[] }[],
): RelatedGroup {
  const items: RelatedItem[] = rows.map((r) => ({ namespace: r.namespace, name: r.cells[0], cells: r.cells }));
  return { title, api_version: apiVersion, kind, columns, name_column: 0, items, error: "" };
}

/** A group of plain rows (not objects). */
export function plain(title: string, columns: string[], rows: string[][]): RelatedGroup {
  const items: RelatedItem[] = rows.map((cells) => ({ namespace: "", name: "", cells }));
  return { title, api_version: "", kind: "", columns, name_column: 0, items, error: "" };
}

const POD_COLUMNS = ["Name", "Ready", "Status", "Restarts", "Age"];
const RBAC = "rbac.authorization.k8s.io/v1";

export function relatedFixtures(): Record<string, Related> {
  return {
    "apps/v1/deployments|demo/web": {
      summary: ["2/2 ready", "RollingUpdate 25%/25%", "revision 4"],
      facts: [
        { label: "Rollout", value: "complete" },
        { label: "Generation", value: "observed 4 of 4" },
      ],
      groups: [
        objects(
          "ReplicaSets",
          "apps/v1",
          "ReplicaSet",
          ["Name", "Revision", "Ready", "Age"],
          [{ namespace: "demo", cells: ["web-5d8f", "4", "2/2", "1h"] }],
        ),
        objects("Pods", "v1", "Pod", POD_COLUMNS, [
          { namespace: "demo", cells: ["web-1", "1/1", "Running", "0", "1h"] },
          { namespace: "demo", cells: ["web-2", "0/1", "CrashLoopBackOff", "3", "1h"] },
        ]),
      ],
    },
    "v1/nodes|node-1": {
      summary: ["Ready", "v1.37.0"],
      facts: [{ label: "InternalIP", value: "172.18.0.2" }],
      groups: [
        objects(
          "Pods",
          "v1",
          "Pod",
          ["Name", "Namespace", "Ready", "Status", "Restarts"],
          [{ namespace: "demo", cells: ["web-1", "demo", "1/1", "Running", "0"] }],
        ),
        {
          title: "Allocated resources",
          api_version: "",
          kind: "",
          columns: ["Resource", "Requests", "Limits", "Allocatable"],
          name_column: 0,
          items: [{ namespace: "", name: "", cells: ["cpu", "750m (37%)", "1 (50%)", "2"] }],
          error: "",
        },
        objects("Taints", "", "", ["Key", "Value", "Effect"], []),
      ],
    },
    "v1/configmaps|demo/settings": {
      summary: ["2 keys"],
      facts: [],
      groups: [
        {
          ...objects("Used by pods", "v1", "Pod", ["Name", "Ready", "Status", "Used as"], []),
          error: "pods is forbidden: User cannot list pods in the namespace demo",
        },
      ],
    },
    "rbac.authorization.k8s.io/v1/roles|demo/pod-reader": {
      summary: ["2 rules"],
      facts: [],
      groups: [
        plain(
          "Rules",
          ["API groups", "Resources", "Resource names", "Verbs"],
          [
            ["core", "pods, pods/log", "all", "get, list"],
            ["apps", "deployments", "web", "patch"],
          ],
        ),
        objects(
          "Role bindings",
          RBAC,
          "RoleBinding",
          ["Name", "Role", "Subjects"],
          [{ namespace: "demo", cells: ["web-reads-pods", "Role/pod-reader", "ServiceAccount:demo/web,User:alice"] }],
        ),
      ],
    },
    "rbac.authorization.k8s.io/v1/rolebindings|demo/web-reads-pods": {
      summary: ["Role/pod-reader", "2 subjects"],
      facts: [],
      groups: [
        objects("Role", RBAC, "Role", ["Name", "Kind"], [{ namespace: "demo", cells: ["pod-reader", "Role"] }]),
        objects("Service accounts", "v1", "ServiceAccount", ["Name", "Namespace"], [{ namespace: "demo", cells: ["web", "demo"] }]),
        plain("Users and groups", ["Kind", "Name"], [["User", "alice"]]),
      ],
    },
    "v1/serviceaccounts|demo/web": {
      summary: [],
      facts: [],
      groups: [
        objects("Role bindings", RBAC, "RoleBinding", ["Name", "Role", "Subjects"], [
          { namespace: "demo", cells: ["web-reads-pods", "Role/pod-reader", "ServiceAccount:demo/web,User:alice"] },
        ]),
        objects("Cluster role bindings", RBAC, "ClusterRoleBinding", ["Name", "Role", "Subjects"], []),
        objects("Pods", "v1", "Pod", POD_COLUMNS, [{ namespace: "demo", cells: ["web-1", "1/1", "Running", "0", "1h"] }]),
      ],
    },
    "policy/v1/poddisruptionbudgets|demo/web": {
      summary: ["1 disruption allowed", "2/1 healthy"],
      facts: [
        { label: "Min available", value: "1" },
        { label: "Expected pods", value: "2" },
      ],
      groups: [
        objects("Pods", "v1", "Pod", POD_COLUMNS, [
          { namespace: "demo", cells: ["web-1", "1/1", "Running", "0", "1h"] },
          { namespace: "demo", cells: ["web-2", "1/1", "Running", "3", "1h"] },
        ]),
      ],
    },
    "apiextensions.k8s.io/v1/customresourcedefinitions|widgets.example.com": {
      summary: ["Widget", "Namespaced", "1 version"],
      facts: [
        { label: "Group", value: "example.com" },
        { label: "Plural", value: "widgets" },
        { label: "Storage version", value: "v1" },
      ],
      groups: [
        plain("Versions", ["Name", "Served", "Storage", "Deprecated"], [["v1", "yes", "yes", "no"]]),
        plain("Printer columns", ["Version", "Name", "Type", "JSON path", "Priority"], []),
      ],
    },
    "v1/pods|demo/web-1": {
      summary: [],
      facts: [],
      groups: [
        objects(
          "ConfigMaps",
          "v1",
          "ConfigMap",
          ["Name", "Used as"],
          [{ namespace: "demo", cells: ["settings", "volume config, envFrom (app)"] }],
        ),
        objects(
          "Secrets",
          "v1",
          "Secret",
          ["Name", "Used as"],
          [{ namespace: "demo", cells: ["db-creds", "env PASSWORD (app)"] }],
        ),
      ],
    },
  };
}

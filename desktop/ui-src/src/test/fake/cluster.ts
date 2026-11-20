// Contexts, namespaces, discovery, access checks and metrics (`commands/cluster.rs`).

import { fullContext } from "../fixtures/catalog";
import { kindOf, served } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function clusterHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    cmdListContexts: () => cluster.contexts.map(fullContext),
    cmdSetContext: (name) => {
      cluster.contexts = cluster.contexts.map((c) => ({ ...c, current: c.name === name }));
      // Like the backend (ADR 0007): the old cluster stays connected, its
      // log streams and forwards run on.
      return null;
    },
    cmdListNamespaces: () => served(s, "namespaces"),
    cmdDefaultNamespace: () => cluster.defaultNamespace,
    cmdDiscover: () => served(s, "kinds"),
    cmdServerVersion: () => {
      if (!cluster.serverVersion) throw "the API server did not say its version in time";
      return cluster.serverVersion;
    },
    cmdCheckAccess: (kinds, namespace) =>
      kinds.map((r) => {
        const id = kindOf(s, r).id;
        const clusterWide = r.namespaced && namespace === null;
        const allowed = !cluster.denied.includes(id) && !(clusterWide && cluster.deniedClusterWide.includes(id));
        return { id, allowed };
      }),
    cmdGetMetrics: (namespace, what) => {
      const m = cluster.metrics;
      const pods = what === "pods" ? m.pods.filter((p) => !namespace || p.namespace === namespace) : [];
      const nodes = what === "nodes" ? m.nodes : [];
      // Like the backend: the sparklines of just what was returned.
      const keys = [...pods.map((p) => `${p.namespace}/${p.name}`), ...nodes.map((n) => n.name)];
      const sparks = Object.fromEntries(keys.filter((k) => k in m.sparks).map((k) => [k, m.sparks[k]]));
      return { available: m.available, pods, nodes, sparks, since: keys.some((k) => k in m.sparks) ? m.since : 0 };
    },
  } satisfies AreaHandlers;
}

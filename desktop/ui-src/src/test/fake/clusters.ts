// Connecting a window to more clusters than the one it shows
// (`commands/clusters.rs`, ADR 0007). The fake serves every cluster from one
// `FakeCluster` (`byCluster` changes what one of them serves); it keeps
// which clusters are connected, and refuses, like the backend, a login
// command of an added kubeconfig that was not allowed (#201).

import type { AreaHandlers, FakeState } from "./state";

export function clustersHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    cmdClusterConnect: () => {
      const id = s.target;
      const ctx = cluster.contexts.find((c) => c.name === id);
      if (!ctx) throw `There is no context ${id} in your kubeconfigs`;
      if (ctx.source && ctx.login_command) {
        const answer = cluster.catalog.answers[`${ctx.source}\n${ctx.login_command}`];
        if (answer !== true) {
          const why = answer === false ? "you chose not to run it" : "you have not allowed it yet";
          throw `Login to \`${id}\` was not started: it runs \`${ctx.login_command}\` (from ${ctx.source}), and ${why}. Open the cluster catalog and choose Check to allow it.`;
        }
      }
      // What logging in would have started.
      if (ctx.login_plugin) cluster.catalog.pluginRuns[id] = (cluster.catalog.pluginRuns[id] ?? 0) + 1;
      s.connected.add(id);
      return null;
    },
    cmdClusterReconnect: () => {
      // Like the backend: a fresh session; what the old one ran stops (the
      // fake keeps one list of streams and forwards for every cluster).
      s.logStreams.clear();
      cluster.forwards = [];
      return null;
    },
    cmdClusterDisconnect: () => {
      s.connected.delete(s.target);
      return null;
    },
  } satisfies AreaHandlers;
}

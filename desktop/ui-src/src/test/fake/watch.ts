// Table and detail watches (`commands/watch.rs`).

import { findRow, kindOf, rowsOf, sendWatch } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function watchHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    cmdWatchStart: (resource, namespace, onEvent) => {
      const kind = kindOf(s, resource);
      const id = `watch-${++s.watchSeq}`;
      s.watches.push({ id, kind, namespace });
      s.watchChannels.set(id, onEvent);
      // Of the cluster the call names (`byCluster`), looked up now.
      const rows = rowsOf(s, kind);
      // Like the backend: the full list first, then "live", on the channel.
      setTimeout(() => {
        const denied = namespace
          ? cluster.deniedNamespaces.includes(namespace)
          : cluster.deniedClusterWide.includes(kind.id);
        if (denied) {
          // Like the backend: a 403 ends the watch with one "forbidden".
          sendWatch(s, id, { type: "state", state: "forbidden", error: `${kind.resource.plural} is forbidden` });
          return;
        }
        const applied = rows.filter((r) => !namespace || r.namespace === namespace);
        sendWatch(s, id, { type: "batch", snapshot: true, applied, deleted: [] });
        // Like the backend: a kind without the watch verb is polled.
        if (kind.verbs.includes("watch")) sendWatch(s, id, { type: "state", state: "live" });
        else sendWatch(s, id, { type: "state", state: "polling", interval_secs: 30 });
      }, 0);
      return id;
    },
    cmdWatchStop: (id) => {
      const i = s.watches.findIndex((w) => w.id === id);
      if (i >= 0) s.watches.splice(i, 1);
      s.detailWatches.delete(id);
      return null;
    },
    cmdDetailWatch: (resource, namespace, name, onEvent) => {
      const { kind, row } = findRow(s, resource, namespace, name);
      const id = `detail-${++s.detailSeq}`;
      s.detailWatches.set(id, `${kind.id}|${row.key}`);
      s.detailChannels.set(id, onEvent);
      return id;
    },
  } satisfies AreaHandlers;
}

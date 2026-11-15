// Table and detail watches (`commands/watch.rs`).

import { events } from "../../lib/bindings";
import { findRow, kindOf, rowsOf } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function watchHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    cmdWatchStart: (resource, namespace) => {
      const kind = kindOf(s, resource);
      const id = `watch-${++s.watchSeq}`;
      s.watches.push({ id, kind, namespace });
      // Like the backend: the full list first, then "live". Sent after the
      // reply so the store knows the id (it also buffers early events).
      setTimeout(() => {
        const denied = namespace
          ? cluster.deniedNamespaces.includes(namespace)
          : cluster.deniedClusterWide.includes(kind.id);
        if (denied) {
          // Like the backend: a 403 ends the watch with one "forbidden".
          void events.watchState.emit({ id, state: "forbidden", error: `${kind.resource.plural} is forbidden` });
          return;
        }
        const applied = rowsOf(s, kind).filter((r) => !namespace || r.namespace === namespace);
        void events.watchBatch.emit({ id, snapshot: true, applied, deleted: [] });
        void events.watchState.emit({ id, state: "live" });
      }, 0);
      return id;
    },
    cmdWatchStop: (id) => {
      const i = s.watches.findIndex((w) => w.id === id);
      if (i >= 0) s.watches.splice(i, 1);
      s.detailWatches.delete(id);
      return null;
    },
    cmdDetailWatch: (resource, namespace, name) => {
      const { kind, row } = findRow(s, resource, namespace, name);
      const id = `detail-${++s.detailSeq}`;
      s.detailWatches.set(id, `${kind.id}|${row.key}`);
      return id;
    },
  } satisfies AreaHandlers;
}

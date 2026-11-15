// Actions, bulk delete and node drains (`commands/actions.rs`).

import { events } from "../../lib/bindings";
import { findRow, kindOf, removeRow, rowKey } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function actionsHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    cmdRunAction: (resource, namespace, name, action, replicas) => {
      const { kind, row } = findRow(s, resource, namespace, name);
      const label = `${kind.resource.kind.toLowerCase()} ${row.key}`;
      switch (action) {
        case "delete":
        case "forceDelete":
          removeRow(s, kind, row.key);
          return `Deleted ${label}`;
        case "scale":
          return `Scaled ${label} to ${replicas}`;
        default:
          return `${action} ${label}: done`;
      }
    },
    cmdBulkDelete: (resource, items) => {
      const kind = kindOf(s, resource);
      return items.map(({ namespace, name }) => {
        const key = rowKey(namespace, name);
        const error = cluster.bulkErrors[key] ?? "";
        if (!error) removeRow(s, kind, key);
        return { key, error };
      });
    },
    cmdDrainNode: (node) => {
      const drainId = `drain-${++s.drainSeq}`;
      setTimeout(() => {
        void events.drainProgress.emit({ drainId, event: { type: "cordoned", node } });
        void events.drainFinished.emit({
          drainId,
          error: "",
          summary: { evicted: 0, failed: 0, skipped: 0, still_terminating: 0 },
        });
      }, 0);
      return drainId;
    },
    cmdCancelDrain: () => null,
  } satisfies AreaHandlers;
}

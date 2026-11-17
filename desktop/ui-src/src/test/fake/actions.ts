// Actions, bulk delete and node drains (`commands/actions.rs`).

import { events } from "../../lib/bindings";
import { addRow, findRow, kindOf, removeRow, rowKey } from "./state";
import type { AreaHandlers, FakeState } from "./state";
import { readOnlyReason } from "./gate";

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
        case "evict": {
          const error = cluster.evictErrors[row.key];
          if (error) throw error;
          removeRow(s, kind, row.key);
          return `Evicted Pod/${row.key}`;
        }
        case "scale":
          return `Scaled ${label} to ${replicas}`;
        case "cordon":
        case "uncordon": {
          // The node's Ready cell, as the backend computes it (#100).
          const i = kind.columns.findIndex((c) => c.key === "ready");
          const ready = (row.cells[i] ?? "True").split(",")[0];
          const cells = [...row.cells];
          cells[i] = action === "cordon" ? `${ready},SchedulingDisabled` : ready;
          addRow(s, kind, { ...row, cells });
          return `${action === "cordon" ? "Cordoned" : "Uncordoned"} Node/${row.name}`;
        }
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
    cmdCheckActions: async (_resource, namespace, ids) => {
      const out = ids.map((id) => {
        // A read-only context refuses every change, whatever RBAC says (#338).
        const ro = id === "logs" || id === "portForward" ? undefined : readOnlyReason(s);
        const reason = ro ?? cluster.deniedActions[`${namespace}/${id}`] ?? cluster.deniedActions[id];
        return { id, allowed: reason === undefined, reason: reason ?? "" };
      });
      if (cluster.checkActionsDelayMs > 0) await new Promise((r) => setTimeout(r, cluster.checkActionsDelayMs));
      return out;
    },
  } satisfies AreaHandlers;
}

// Table and detail watches (`commands/watch.rs`).

import { findRow, kindOf, rowsOf, sendWatch } from "./state";
import type { AreaHandlers, FakeState } from "./state";
import type { CustomColumn, ResourceKind, ResourceRow } from "../../lib/bindings";
import { sourceError } from "../../lib/customColumns";
import { FAKE_ANNOTATIONS, FAKE_LABELS } from "../fixtures/cluster";

/** A custom column's cell (#547), from the fake objects' labels and
 *  annotations, and a few field paths that other cells already hold. */
function customCell(kind: ResourceKind, row: ResourceRow, c: CustomColumn): string {
  const cell = (key: string) => row.cells[kind.columns.findIndex((d) => d.key === key)] ?? "";
  switch (c.source) {
    case "label":
      return FAKE_LABELS[row.name]?.[c.value.trim()] ?? "";
    case "annotation":
      return FAKE_ANNOTATIONS[row.name]?.[c.value.trim()] ?? "";
    case "field": {
      const fields: Record<string, string> = {
        ".metadata.name": row.name,
        ".metadata.namespace": row.namespace,
        ".spec.nodeName": cell("node"),
        ".status.podIP": cell("ip"),
        ".status.qosClass": cell("qos"),
      };
      return fields[c.value.trim()] ?? "";
    }
  }
}

export function watchHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    cmdWatchStart: (resource, namespace, custom, onEvent) => {
      const kind = kindOf(s, resource);
      // Like the backend: a column it cannot read is refused (#547).
      for (const c of custom) {
        const err = sourceError(c.source, c.value);
        if (err) throw `Column "${c.label}": ${err}`;
      }
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
        const applied = rows
          .filter((r) => !namespace || r.namespace === namespace)
          .map((r) => (custom.length ? { ...r, cells: [...r.cells, ...custom.map((c) => customCell(kind, r, c))] } : r));
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

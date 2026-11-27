// The Vulns column (#535): off by default, offered only while image
// security is on for the cluster, and filled from the listing the app
// already holds, joined by workload (watch rows stay untouched). The
// listing comes in through `setVulnsSource` (stores/imageFindings), so this
// stays free of stores.

import type { ColumnDef, ImageSecuritySettings_Serialize as ImageSecuritySettings, ResourceKind } from "./bindings";
import type { Column, Row } from "./columns";
import { podWorkload, vulnsCell, workloadKey, type FindingsIndex, type VulnsCell } from "./imageFindings";

export interface VulnsSource {
  /** Image security is on for the cluster on screen. */
  on(): boolean;
  /** The joined listing, `null` until it is read. */
  index(): FindingsIndex | null;
  settings(): ImageSecuritySettings;
}

let source: VulnsSource = { on: () => false, index: () => null, settings: () => ({}) as ImageSecuritySettings };

export function setVulnsSource(s: VulnsSource) {
  source = s;
}

const EMPTY: VulnsCell = { text: "", sort: -2, title: "" };

/** The cell of `row` of `kind`: a pod by its owner (Controlled By), a workload by itself. */
export function vulnsOf(kind: ResourceKind, ownerAt: number, row: Row): VulnsCell {
  const index = source.index();
  if (!index) return EMPTY;
  const isPod = kind.resource.group === "" && kind.resource.kind === "Pod";
  const w = isPod ? podWorkload(row.name, ownerAt >= 0 ? (row.cells[ownerAt] ?? "") : "") : { kind: kind.resource.kind, name: row.name };
  const images = index.byWorkload.get(workloadKey(w.kind, row.namespace, w.name));
  return images ? vulnsCell(images, source.settings()) : EMPTY;
}

/** The column for `def` of `kind`, with `base` (key, label, fit) from columns.ts. */
export function vulnsColumn(
  base: Pick<Column, "key" | "label" | "fit" | "defaultHidden">,
  kind: ResourceKind,
): Column {
  const ownerAt = kind.columns.findIndex((c: ColumnDef) => c.kind === "owner");
  return {
    ...base,
    text: (r) => vulnsOf(kind, ownerAt, r).text,
    sort: (r) => vulnsOf(kind, ownerAt, r).sort,
    title: (r) => vulnsOf(kind, ownerAt, r).title,
    available: () => source.on(),
  };
}

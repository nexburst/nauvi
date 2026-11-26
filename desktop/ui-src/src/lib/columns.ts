import type { ColumnDef, NodeDisk, NodeUsage, PodUsage, ResourceKind, ResourceRow, Spark, TimeZone } from "./bindings";
import { diskPercent, diskText } from "./metricsAddons";
import { createdAt, formatAge, formatCpu, formatMemory } from "./format";
import { columnOn } from "./settings";
import { containersSummary, parseContainers, worstRank } from "./containerStates";
import { rolloutRank, rolloutTitle } from "./rolloutStatus";
import { CELL_PAD, type Fit, type Measure } from "./columnFit";
import type { IconName } from "./icons/icons";

export type Row = ResourceRow;

/** Polled metrics, keyed like the rows they merge into. */
export interface Metrics {
  pods: Map<string, PodUsage>;
  nodes: Map<string, NodeUsage>;
  /** Usage history for the sparklines (#47), keyed like `pods` or `nodes`. */
  sparks: Map<string, Spark>;
  /** Epoch ms the history of what is shown starts at (0 = none yet). */
  since: number;
  /** Root filesystem use by node name, from Prometheus (#225); empty or
   *  missing without node-exporter, and then the Disk column is hidden. */
  disks?: Map<string, NodeDisk>;
  /** Hidden for the cluster (#327): the metric columns are not shown. */
  hidden?: boolean;
}

/** Things a cell may depend on besides the row itself. */
export interface Ctx {
  metrics: Metrics;
  /** Wall clock (ms), ticked by the live store so ages stay fresh. */
  now: number;
}

export interface Column {
  key: string;
  label: string;
  /** How its width is fitted to its values (#482). */
  fit: Fit;
  text(row: Row, ctx: Ctx): string;
  /** Value to sort by; numbers sort numerically. */
  sort(row: Row, ctx: Ctx): string | number;
  /** Optional CSS class for the cell. */
  cls?(row: Row): string;
  /** Values of the cell's sparkline, oldest first (metric columns only). */
  spark?(row: Row, ctx: Ctx): readonly number[];
  /** The cell's tooltip, when it is not the cell's text (the Age column's
   *  creation time, #380). */
  title?(row: Row, zone: TimeZone): string;
  /** Whether the column has anything to show; shown when missing. */
  shown?(metrics: Metrics): boolean;
  /** Off until the user turns it on in the column chooser (#378). */
  defaultHidden: boolean;
  /** The cell links to the object it names (Controlled By, #378). */
  link?: "owner";
  /** The cell is drawn as one state square per container (#379). */
  draw?: "containers" | "rollout";
}

/** The columns to draw: not hidden by the user (an off-by-default one only
 *  once turned on, in `shown`), and with data where they need it. */
export function shownColumns(
  cols: Column[],
  hidden: readonly string[],
  metrics: Metrics,
  shown: readonly string[] = [],
): Column[] {
  const picks = { hidden: [...hidden], shown: [...shown] };
  return cols.filter((c) => columnOn(picks, c) && (c.shown?.(metrics) ?? true));
}

export const EMPTY_METRICS: Metrics = { pods: new Map(), nodes: new Map(), sparks: new Map(), since: 0 };
/** What the tables get while metrics are hidden for the cluster (#327). */
export const HIDDEN_METRICS: Metrics = { ...EMPTY_METRICS, hidden: true };
/** A metric column is shown unless metrics are hidden. */
const notHidden = (m: Metrics) => !m.hidden;
const NO_SPARK: readonly number[] = [];

export function isPod(kind: ResourceKind): boolean {
  return kind.resource.group === "" && kind.resource.kind === "Pod";
}
export function isNode(kind: ResourceKind): boolean {
  return kind.resource.group === "" && kind.resource.kind === "Node";
}

// Widths, px with the cell's padding: see `Fit` in columnFit.ts.

function fitFor(def: ColumnDef): Fit {
  switch (def.kind) {
    case "age":
      // Never cut (#482): as wide as `9m59s` at least, about the widest age.
      return { min: 56, max: 120, grow: 0, give: 0, sample: "9m59s" };
    // As wide as their values and sparkline (#482): "—" without metrics
    // does not hold 120 px.
    case "podCpu":
    case "podMemory":
      return { min: 64, max: 140, grow: 0, give: 0 };
    case "nodeCpu":
      return { min: 140, max: 220, grow: 0, give: 0 };
    case "nodeMemory":
      return { min: 160, max: 240, grow: 0, give: 0 };
    case "nodeDisk":
      return { min: 170, max: 240, grow: 0, give: 0 };
  }
  // Name takes the spare width (#384, #482) and gives way last; the end of
  // a cut name stays, where generated names differ.
  if (def.key === "name") return { min: 240, max: 640, grow: 2, give: 3, middle: true };
  // Then the places it runs in.
  if (def.key === "namespace" || def.key === "node" || def.key === "nominated")
    return { min: 88, max: 320, grow: 1, give: 2, middle: true };
  if (def.key === "message") return { min: 240, max: 100000, grow: 3, give: 1 };
  // Short values ("1/1", "12", "Running") are as wide as they and their
  // header are, and are never cut.
  if (def.kind === "number" || def.key === "ready" || def.key === "restarts")
    return { min: 48, max: 120, grow: 0, give: 0 };
  if (def.kind === "owner") return { min: 160, max: 360, grow: 0, give: 1, middle: true };
  if (def.kind === "containers") return { min: 72, max: 260, grow: 0, give: 1 };
  if (def.kind === "rollout") return { min: 96, max: 220, grow: 0, give: 0 };
  // "CrashLoopBackOff" behind its icon; a longer reason is cut, with the
  // whole text in the cell's title.
  if (def.kind === "status") return { min: 80, max: 240, grow: 0, give: 0 };
  // Other text (QoS, IP, labels) gives way first, but a value up to about
  // 15 characters ("Burstable", "10.244.0.5") is never cut.
  return { min: 120, max: 360, grow: 0, give: 1 };
}

/** The px drawn before a status cell's text: its icon and the gap. */
export const STATUS_ICON_PX = 20;

/**
 * The status icon of a cell classed `cls` (`phase-Running`), next to its
 * colour (#482), so the state does not rest on colour alone: the same
 * tones as the `phase-*` classes in app.css. `null`: no icon, the text
 * stays in line with the others.
 */
export function statusIcon(cls: string): IconName | null {
  const phase = cls.startsWith("phase-") ? cls.slice(6) : "";
  if (["Succeeded", "Complete", "Completed"].includes(phase)) return "check";
  if (["Running", "Active", "Bound", "Normal"].includes(phase)) return "ok";
  if (["Pending", "Terminating", "Released", "ContainerCreating"].includes(phase)) return "pending";
  if (phase === "Warning") return "warning";
  if (["Failed", "Lost"].includes(phase)) return "failed";
  if (["Error", "CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull"].includes(phase)) return "error";
  return null;
}

/** The px a cell of `col` showing `text` takes, padding included: what is
 *  drawn in it (squares, an icon) as well as the text. */
export function cellWidth(col: Column, text: string, measure: Measure): number {
  if (col.draw === "containers") return CELL_PAD + parseContainers(text).length * 13;
  if (col.draw === "rollout") return CELL_PAD + 16 + measure(text);
  const lead = col.cls ? STATUS_ICON_PX : 0;
  // A metric's sparkline may follow its value.
  const spark = col.spark && text !== "—" ? SPARK_PX : 0;
  return CELL_PAD + lead + (text ? measure(text) : 0) + spark;
}

/** A sparkline and its gap (Sparkline.svelte). */
export const SPARK_PX = 38;

/** A column label in sentence case (#384): "Controlled By" -> "Controlled
 *  by". A word with a capital after its first letter (CPU, QoS, IP) is kept.
 *  A label with no lower case at all and a space or a run of four capitals
 *  (a CRD's "NAME", "LAST SEEN") is shouting, and is lowered first. */
export function headerLabel(label: string): string {
  const shouted = !/[a-z]/.test(label) && /\s|[A-Z]{4}/.test(label);
  return (shouted ? label.toLowerCase() : label)
    .split(" ")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : /^.[^A-Z]*$/.test(w) ? w.toLowerCase() : w))
    .join(" ");
}

/** Number to sort a numeric cell by ("3", or the leading number of "1/2"). */
function numeric(text: string): number {
  const n = parseFloat(text);
  return Number.isNaN(n) ? -1 : n;
}

function column(def: ColumnDef, index: number): Column {
  const base = { key: def.key, label: headerLabel(def.label), fit: fitFor(def), defaultHidden: def.default_hidden };
  const cell = (r: Row) => r.cells[index] ?? "";
  switch (def.kind) {
    case "age":
      return {
        ...base,
        text: (r, c) => formatAge(r.created, c.now, ""),
        title: (r, zone) => createdAt(r.created, zone),
        sort: (r) => r.created,
      };
    case "podCpu":
      return {
        ...base,
        text: (r, c) => {
          const m = c.metrics.pods.get(r.key);
          return m ? formatCpu(m.cpu_millicores) : "—";
        },
        sort: (r, c) => c.metrics.pods.get(r.key)?.cpu_millicores ?? -1,
        spark: (r, c) => c.metrics.sparks.get(r.key)?.cpu ?? NO_SPARK,
        shown: notHidden,
      };
    case "podMemory":
      return {
        ...base,
        text: (r, c) => {
          const m = c.metrics.pods.get(r.key);
          return m ? formatMemory(m.memory_bytes) : "—";
        },
        sort: (r, c) => c.metrics.pods.get(r.key)?.memory_bytes ?? -1,
        spark: (r, c) => c.metrics.sparks.get(r.key)?.memory ?? NO_SPARK,
        shown: notHidden,
      };
    case "nodeCpu":
      return {
        ...base,
        text: (r, c) => {
          const m = c.metrics.nodes.get(r.name);
          if (!m) return "—";
          return (
            formatCpu(m.cpu_millicores) +
            (m.cpu_capacity_millicores ? " / " + formatCpu(m.cpu_capacity_millicores) : "")
          );
        },
        sort: (r, c) => c.metrics.nodes.get(r.name)?.cpu_millicores ?? -1,
        spark: (r, c) => c.metrics.sparks.get(r.name)?.cpu ?? NO_SPARK,
        shown: notHidden,
      };
    case "nodeMemory":
      return {
        ...base,
        text: (r, c) => {
          const m = c.metrics.nodes.get(r.name);
          if (!m) return "—";
          return (
            formatMemory(m.memory_bytes) +
            (m.memory_capacity_bytes ? " / " + formatMemory(m.memory_capacity_bytes) : "")
          );
        },
        sort: (r, c) => c.metrics.nodes.get(r.name)?.memory_bytes ?? -1,
        spark: (r, c) => c.metrics.sparks.get(r.name)?.memory ?? NO_SPARK,
        shown: notHidden,
      };
    case "nodeDisk":
      return {
        ...base,
        text: (r, c) => {
          const d = c.metrics.disks?.get(r.name);
          return d ? diskText(d) : "—";
        },
        sort: (r, c) => {
          const d = c.metrics.disks?.get(r.name);
          return d ? diskPercent(d) : -1;
        },
        shown: (m) => !m.hidden && (m.disks?.size ?? 0) > 0,
      };
    case "number":
      return { ...base, text: cell, sort: (r) => numeric(cell(r)) };
    case "status":
      return { ...base, text: cell, sort: cell, cls: (r) => `phase-${cell(r)}` };
    case "owner":
      return { ...base, text: cell, sort: cell, link: "owner" };
    case "containers":
      // Sorted by the worst container's state: descending puts broken first.
      return {
        ...base,
        text: cell,
        sort: (r) => worstRank(parseContainers(cell(r))),
        title: (r) => containersSummary(parseContainers(cell(r))),
        draw: "containers",
      };
    case "rollout":
      // Sorted by how bad: descending puts Failed first (#381).
      return {
        ...base,
        text: cell,
        sort: (r) => rolloutRank(cell(r)),
        title: (r) => rolloutTitle(cell(r), r.problem),
        draw: "rollout",
      };
    default:
      return { ...base, text: cell, sort: cell };
  }
}

/**
 * A node's Ready cell (`True`, `False`, `Unknown`, with `,SchedulingDisabled`
 * when it is cordoned, as `kubectl get nodes` shows it): amber when cordoned,
 * red when not ready.
 */
export function nodeReadyClass(text: string): string {
  if (!text.startsWith("True")) return "phase-Failed";
  if (text.includes("SchedulingDisabled")) return "phase-Pending";
  return "";
}

/** Node tables: the Ready cell is coloured, and as wide as "True,SchedulingDisabled". */
function forNodes(cols: Column[]): Column[] {
  return cols.map((c) =>
    c.key === "ready"
      ? { ...c, fit: { min: 80, max: 260, grow: 0, give: 0 }, cls: (r: Row) => nodeReadyClass(c.text(r, NO_CTX)) }
      : c,
  );
}
const NO_CTX: Ctx = { metrics: EMPTY_METRICS, now: 0 };

const cache = new WeakMap<ResourceKind, Column[]>();

/**
 * Columns of a kind. Which columns exist, and how their cells are computed,
 * is declared by the backend's registry (`src/resources.rs`) and arrives with
 * discovery; this only decides how to render and sort each kind of column.
 */
export function columnsFor(kind: ResourceKind): Column[] {
  let cols = cache.get(kind);
  if (!cols) {
    cols = kind.columns.map(column);
    if (isNode(kind)) cols = forNodes(cols);
    cache.set(kind, cols);
  }
  return cols;
}

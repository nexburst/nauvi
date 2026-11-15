/** Lines kept per stream; older ones fall off the front. */
/** A workload whose pods' logs are merged into one stream. */
export interface WorkloadRef {
  /** Deployment, StatefulSet, DaemonSet, Job or ReplicaSet (case-insensitive; `deploy`, `sts`, `ds` also work). */
  kind: string;
  namespace: string;
  name: string;
}

/** Kinds whose pods' logs can be streamed together. */
export const WORKLOAD_KINDS = ["Deployment", "StatefulSet", "DaemonSet", "Job", "ReplicaSet"];

export const LOG_BUFFER_MAX = 50_000;

/** Where a line of a workload stream came from. */
export interface LineTag {
  pod: string;
  container: string;
}

/** A line of a workload stream, as sent by the backend. */
export interface TaggedText extends LineTag {
  line: string;
}

/**
 * Bounded line buffer, deliberately outside reactive state: it is trimmed in
 * chunks (10% over the cap) so appending stays amortised O(1) per line.
 *
 * Lines of a workload stream carry a small integer tag (an index into
 * `tags`, 0 = untagged) so the per-line cost stays one number.
 */
export class LogBuffer {
  lines: string[] = [];
  tagIds: number[] = [];
  tags: LineTag[] = [{ pod: "", container: "" }];
  private tagIndex = new Map<string, number>();

  /** Append untagged lines (single-pod logs). */
  push(batch: string[]) {
    for (const l of batch) {
      this.lines.push(l);
      this.tagIds.push(0);
    }
    this.trim();
  }

  /** Append lines tagged with their pod and container. */
  pushTagged(batch: TaggedText[]) {
    for (const l of batch) {
      const key = l.pod + "\0" + l.container;
      let id = this.tagIndex.get(key);
      if (id === undefined) {
        id = this.tags.length;
        this.tags.push({ pod: l.pod, container: l.container });
        this.tagIndex.set(key, id);
      }
      this.lines.push(l.line);
      this.tagIds.push(id);
    }
    this.trim();
  }

  private trim() {
    if (this.lines.length > LOG_BUFFER_MAX + LOG_BUFFER_MAX / 10) {
      const drop = this.lines.length - LOG_BUFFER_MAX;
      this.lines.splice(0, drop);
      this.tagIds.splice(0, drop);
    }
  }

  clear() {
    this.lines = [];
    this.tagIds = [];
  }
}

/**
 * The line count in the viewer's status: "1,234 lines", and "50,000+ lines"
 * once the buffer is full. The buffer itself runs up to 10% over the cap
 * between trims, so the count is capped here (#113).
 */
export function lineCountLabel(count: number): string {
  return count >= LOG_BUFFER_MAX ? `${LOG_BUFFER_MAX.toLocaleString()}+ lines` : `${count.toLocaleString()} lines`;
}

/** Case-insensitive substring match; an empty filter matches everything. */
export function logMatches(text: string, filterLower: string): boolean {
  return !filterLower || text.toLowerCase().includes(filterLower);
}

/** Distinct colours that read on the dark log background. */
export const POD_COLORS = [
  "#4fb3ff",
  "#ff9f43",
  "#4cd964",
  "#d070e0",
  "#f5d90a",
  "#6c9cff",
  "#ff6b6b",
  "#5fd3a2",
  "#a88bff",
  "#ffb48a",
  "#58d6e8",
  "#e58fd8",
];

/** Stable colour for a pod name (FNV-1a over its bytes, like the CLI). */
export function podColor(pod: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < pod.length; i++) {
    h ^= pod.charCodeAt(i) & 0xff;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return POD_COLORS[h % POD_COLORS.length];
}

/** The bracketed label a workload line is prefixed with. */
export function linePrefix(tag: LineTag, withContainer: boolean): string {
  return withContainer ? `[${tag.pod}/${tag.container}]` : `[${tag.pod}]`;
}

/** The pod log viewer's container choice that merges all of them. */
export const ALL_CONTAINERS = "*";

/** "All containers" is offered for pods with more than one regular container. */
export function offerAllContainers(containers: readonly { init: boolean }[]): boolean {
  return containers.filter((c) => !c.init).length > 1;
}

/** The label and colour of a merged line: by pod for a workload, by container for one pod. */
export function tagLabel(tag: LineTag, byContainer: boolean, withContainer: boolean): { prefix: string; color: string } {
  if (byContainer) return { prefix: `[${tag.container}]`, color: podColor(tag.container) };
  return { prefix: linePrefix(tag, withContainer), color: podColor(tag.pod) };
}

export interface Segment {
  text: string;
  hit: boolean;
}

/** Split `text` into plain and highlighted (case-insensitive match) segments. */
export function splitHighlights(text: string, filter: string): Segment[] {
  if (!filter) return [{ text, hit: false }];
  const lower = text.toLowerCase();
  const needle = filter.toLowerCase();
  const out: Segment[] = [];
  let pos = 0;
  for (;;) {
    const i = lower.indexOf(needle, pos);
    if (i < 0) break;
    if (i > pos) out.push({ text: text.slice(pos, i), hit: false });
    out.push({ text: text.slice(i, i + needle.length), hit: true });
    pos = i + needle.length;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false });
  return out;
}

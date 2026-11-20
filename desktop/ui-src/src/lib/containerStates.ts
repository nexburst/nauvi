// The Pods table's Containers cell (#379): `init:setup=done app=ready
// sidecar=waiting:CrashLoopBackOff`, as `src/resources/pod_containers.rs`
// writes it, read back into one square per container.

import { BAD_WAITING, type Tone } from "./containers";

export type ContainerState = "ready" | "running" | "waiting" | "done" | "failed" | "unknown";

/** How a square is drawn. Each look has its own shape, so the state does not
 *  rest on colour alone: filled (ok), half filled (not ready yet), filled with
 *  a cross (broken), hollow (finished), dashed (no status yet). */
export type Look = "ok" | "warn" | "bad" | "done" | "unknown";

export interface Square {
  name: string;
  init: boolean;
  state: ContainerState;
  reason: string;
  /** Exit code of a failed container, else null. */
  exit: number | null;
  look: Look;
}

const STATES = new Set<string>(["ready", "running", "waiting", "done", "failed", "unknown"]);

function lookOf(state: ContainerState, reason: string): Look {
  switch (state) {
    case "ready":
      return "ok";
    case "running":
      return "warn";
    case "waiting":
      return BAD_WAITING.has(reason) ? "bad" : "warn";
    case "failed":
      return "bad";
    case "done":
      return "done";
    default:
      return "unknown";
  }
}

/** The colour of a look, as the detail panel's container states use it. */
export function lookTone(look: Look): Tone {
  return look === "done" || look === "unknown" ? "muted" : look;
}

/** One square per entry of the cell, in order (init containers first). */
export function parseContainers(cell: string): Square[] {
  const out: Square[] = [];
  for (const entry of cell.split(" ")) {
    if (!entry) continue;
    const init = entry.startsWith("init:");
    const body = init ? entry.slice(5) : entry;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const [raw = "", reason = "", code] = body.slice(eq + 1).split(":");
    const state = (STATES.has(raw) ? raw : "unknown") as ContainerState;
    const exit = state === "failed" && code !== undefined && /^-?\d+$/.test(code) ? Number(code) : null;
    out.push({
      name: body.slice(0, eq),
      init,
      state,
      reason,
      exit,
      look: lookOf(state, reason),
    });
  }
  return out;
}

const WORDS: Record<ContainerState, string> = {
  ready: "running, ready",
  running: "running, not ready",
  waiting: "waiting",
  done: "completed",
  failed: "terminated with an error",
  unknown: "no status yet",
};

/** `sidecar: waiting, CrashLoopBackOff`; `init container setup: completed`;
 *  `app: terminated with an error, OOMKilled, exit 137`. */
export function squareText(s: Square): string {
  let text = `${s.init ? "init container " : ""}${s.name}: ${WORDS[s.state]}`;
  if (s.reason) text += `, ${s.reason}`;
  if (s.exit !== null) text += `, exit ${s.exit}`;
  return text;
}

/** What a screen reader hears and the cell's tooltip: every container. */
export function containersSummary(squares: readonly Square[]): string {
  if (!squares.length) return "No containers";
  const n = squares.length;
  return `${n} container${n === 1 ? "" : "s"}: ${squares.map(squareText).join("; ")}`;
}

const RANK: Record<Look, number> = {
  ok: 0,
  done: 1,
  unknown: 2,
  warn: 3,
  bad: 4,
};

/**
 * Sort key: the worst container's state, then how many containers are in
 * it. Descending puts the pods with a broken container first; a pod without
 * containers (no cell) sorts below every pod with one.
 */
export function worstRank(squares: readonly Square[]): number {
  if (!squares.length) return -1;
  const worst = Math.max(...squares.map((s) => RANK[s.look]));
  return worst * 100 + squares.filter((s) => RANK[s.look] === worst).length;
}

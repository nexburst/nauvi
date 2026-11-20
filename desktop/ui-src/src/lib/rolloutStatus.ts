// The Status cell of Deployments, StatefulSets and DaemonSets (#381), as
// `src/resources/workload_status.rs` writes it: one word, drawn with the same
// shapes as the Pods table's container squares (#379), so the state does not
// rest on colour alone.

import { lookTone, type Look } from "./containerStates";
import type { Tone } from "./containers";

export type Rollout = "Running" | "Scaling" | "Updating" | "Paused" | "Scaled down" | "No nodes" | "Terminating" | "Failed";

interface Info {
  look: Look;
  /** What the word means, for the tooltip. */
  means: string;
  /** Sort rank: descending puts the broken ones first. */
  rank: number;
}

const INFO: Record<Rollout, Info> = {
  Running: { look: "ok", means: "every wanted pod is there and ready", rank: 0 },
  "Scaled down": { look: "done", means: "zero replicas wanted", rank: 1 },
  "No nodes": { look: "done", means: "no node runs this DaemonSet's pods", rank: 1 },
  Paused: { look: "done", means: "the rollout is paused", rank: 2 },
  Scaling: { look: "warn", means: "fewer or more pods than wanted, or not all ready yet", rank: 3 },
  Updating: { look: "warn", means: "a rollout is replacing pods of an older revision", rank: 4 },
  Terminating: { look: "warn", means: "being deleted", rank: 5 },
  Failed: { look: "bad", means: "the rollout is stuck: past its deadline, or a pod could not be created", rank: 6 },
};

function info(word: string): Info | undefined {
  return Object.hasOwn(INFO, word) ? INFO[word as Rollout] : undefined;
}

/** The shape of a status word; a word this version does not know is dashed. */
export function rolloutLook(word: string): Look {
  return info(word)?.look ?? "unknown";
}

export function rolloutTone(word: string): Tone {
  return lookTone(rolloutLook(word));
}

/** Sort key: Failed highest, Running lowest, no status below everything. */
export function rolloutRank(word: string): number {
  if (!word) return -1;
  return info(word)?.rank ?? 1;
}

/** The tooltip: the word, then why (the row's problem) or what it means. */
export function rolloutTitle(word: string, problem: string): string {
  if (!word) return "";
  if (problem) return `${word}: ${problem}`;
  const means = info(word)?.means;
  return means ? `${word}: ${means}` : word;
}

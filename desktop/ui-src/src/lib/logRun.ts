// Which run of a container a log tab shows (#493): the words for the dock's
// context line, and when to offer the previous run instead.
//
// What the kubelet serves (`validateContainerLogStatus`): the current run's
// log while the container runs or has finished; while it waits to restart
// (CrashLoopBackOff) the log of the run that ended last, the same one
// "Previous" shows; with "Previous" the run before the current one
// (`lastState.terminated`), and an error when there is none.

import type { ContainerDetail, StateInfo } from "./bindings";

/** "exited with code 1, 93s ago"; the reason when it says more than the code. */
export function endedText(s: StateInfo): string {
  const reason = s.reason && s.reason !== "Error" && s.reason !== "Completed" ? ` (${s.reason})` : "";
  const ago = s.since ? `, ${s.since} ago` : "";
  return `exited with code ${s.exit_code}${reason}${ago}`;
}

const terminated = (s: StateInfo) => s.state === "terminated";

/**
 * The run the tab shows, in words for the context line, or "" when there is
 * nothing to tell apart (a container that never restarted, current run).
 * `c`: the container's status, unknown until the pod has been read.
 */
export function runLabel(c: ContainerDetail | undefined, previous: boolean): string {
  if (previous) {
    if (!c) return "previous run";
    if (terminated(c.last_state)) return `previous run, ${endedText(c.last_state)}`;
    return "previous run (it has not restarted)";
  }
  if (!c) return "";
  const s = c.state;
  if (s.state === "waiting" && terminated(c.last_state)) {
    const why = s.reason ? `: ${s.reason}` : "";
    return `last run, ${endedText(c.last_state)}; waiting to restart${why}`;
  }
  if (s.state === "waiting") return `waiting to start${s.reason ? `: ${s.reason}` : ""}`;
  if (terminated(s)) return `last run, ${endedText(s)}`;
  if (s.state === "running" && c.restarts > 0) {
    const n = c.restarts === 1 ? "1 restart" : `${c.restarts} restarts`;
    return `current run, started ${s.since ? `${s.since} ago` : "recently"} after ${n}`;
  }
  return "";
}

/**
 * Whether to offer the previous run: the current one runs but has not
 * logged anything, and an earlier one ended. `crashed`: it ended with an
 * error, so the offer can say "the run that crashed".
 */
export function previousOffer(
  c: ContainerDetail | undefined,
  previous: boolean,
  lines: number,
): { crashed: boolean } | null {
  if (previous || !c || lines > 0) return null;
  if (c.state.state !== "running" || !terminated(c.last_state)) return null;
  return { crashed: c.last_state.exit_code !== 0 };
}

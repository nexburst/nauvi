/**
 * "Why it's failing" (#496): what the pod panel leads with for a pod that
 * needs a look, from what the panel already has — the containers' states,
 * the pod's phase and its newest Warning event. The words, not the state
 * name: "Image registry.invalid/api:1.2 cannot be pulled: host
 * registry.invalid not found" rather than "ImagePullBackOff".
 */

import type { ContainerDetail, PodExtras, RelatedEvent } from "./bindings";
import { eventHeadline } from "./eventText";
import { endedText } from "./logRun";

export interface PodWhy {
  /** One line: what is wrong. */
  headline: string;
  /** The container it is about ("" when the pod itself is). */
  container: string;
  /** The state's reason as Kubernetes names it (CrashLoopBackOff), "" if none. */
  reason: string;
  /** "Last run exited with code 1, 2m ago" when a run ended. */
  lastRun: string;
  /** The message the container left when it ended (its termination log). */
  termination: string;
  /** The raw message the headline sums up, when it is longer. */
  detail: string;
  /** It runs again after a run that ended: "Previous logs" shows that run. */
  previous: boolean;
  /** The newest Warning event. */
  warning: RelatedEvent | null;
}

/** Waiting reasons that are a normal step, not a failure. */
const STARTING = new Set(["", "ContainerCreating", "PodInitializing"]);

/** Why an image pull failed, in words ("" when the message says nothing we know). */
export function pullCause(message: string): string {
  const host = /lookup (\S+?)(?: on \S+)?: no such host/i.exec(message);
  if (host) return `host ${host[1]} not found`;
  if (/pull access denied|unauthorized|authorization failed|authentication required|403 Forbidden/i.test(message))
    return "access denied (does it need a pull secret?)";
  if (/toomanyrequests|rate limit/i.test(message)) return "the registry's rate limit was hit";
  if (/no match for platform/i.test(message)) return "no build of the image for this node's platform";
  if (/manifest unknown|: not found\s*$|code = NotFound/i.test(message)) return "no such image or tag";
  if (/i\/o timeout|connection refused|TLS handshake timeout|deadline exceeded|network is unreachable/i.test(message))
    return "the registry did not answer";
  return "";
}

function pullHeadline(c: ContainerDetail, message: string): string {
  const image = /image "([^"]+)"/i.exec(message)?.[1] ?? c.image;
  const cause = pullCause(message);
  return `Image ${image} cannot be pulled${cause ? `: ${cause}` : ""}`;
}

const isTerminated = (s: { state: string }) => s.state === "terminated";

/** The container that is failing, init containers first (they block the rest). */
function failing(containers: ContainerDetail[]): ContainerDetail | undefined {
  const real = containers.filter((c) => c.kind !== "ephemeral");
  return (
    real.find((c) => c.state.state === "waiting" && !STARTING.has(c.state.reason)) ??
    real.find((c) => isTerminated(c.state) && c.state.exit_code !== 0) ??
    // Running again after a crash, and not ready yet.
    real.find((c) => c.state.state === "running" && !c.ready && isTerminated(c.last_state) && c.last_state.exit_code !== 0)
  );
}

function containerHeadline(c: ContainerDetail): string {
  const s = c.state;
  const last = c.last_state;
  const oom = (x: { reason: string }) => x.reason === "OOMKilled";
  if (s.state === "waiting") {
    if (s.reason === "ImagePullBackOff" || s.reason === "ErrImagePull") return pullHeadline(c, s.message);
    if (s.reason === "InvalidImageName") return `Image name ${c.image} is not valid`;
    if (s.reason === "CrashLoopBackOff") {
      if (oom(last)) return `Container ${c.name} keeps running out of memory`;
      return `Container ${c.name} keeps crashing`;
    }
    if (/^(CreateContainerConfigError|CreateContainerError|RunContainerError)$/.test(s.reason))
      return `Container ${c.name} cannot start${s.message ? `: ${s.message}` : ""}`;
    return `Container ${c.name} is waiting: ${s.reason}${s.message ? ` (${s.message})` : ""}`;
  }
  if (isTerminated(s)) {
    // Between two runs of a crash loop (it restarts after a delay).
    if (c.restarts > 0) return oom(s) ? `Container ${c.name} keeps running out of memory` : `Container ${c.name} keeps crashing`;
    if (oom(s)) return `Container ${c.name} was killed: out of memory`;
    return `Container ${c.name} ${endedText(s)}`;
  }
  if (oom(last)) return `Container ${c.name} ran out of memory and restarted`;
  return `Container ${c.name} restarted after it ${endedText(last)}`;
}

/** The headline already says the message (a short one, quoted whole). */
function said(headline: string, message: string) {
  return !message || headline.includes(message);
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * The summary, or null when nothing is wrong. `events`: the pod's, newest
 * first. `verdict`: what the table says is wrong with the row ("" for
 * nothing), so a pod the table flags always gets an answer.
 */
/**
 * Warnings that still apply: a FailedScheduling is over once the pod has a
 * node. `events` newest first.
 */
function liveWarnings(pod: PodExtras, events: RelatedEvent[]): RelatedEvent[] {
  return events.filter((e) => e.type === "Warning" && !(e.reason === "FailedScheduling" && pod.node));
}

/**
 * The newest warning if nothing normal happened after it (a Scheduled, a
 * Pulled, a Started): otherwise it is history, not why the pod is in
 * trouble now. By time when both have one, else by the list's order.
 */
function currentWarning(pod: PodExtras, events: RelatedEvent[]): RelatedEvent | null {
  const w = liveWarnings(pod, events)[0];
  if (!w) return null;
  const at = events.indexOf(w);
  const later = events.some((e, i) => e.type !== "Warning" && (e.time > 0 && w.time > 0 ? e.time > w.time : i < at));
  return later ? null : w;
}

export function podWhy(pod: PodExtras, events: RelatedEvent[], verdict = ""): PodWhy | null {
  const c = failing(pod.containers);
  // With a failing container the newest warning goes with it (a crash loop
  // has Started events between its BackOffs); without one, only a warning
  // nothing normal followed.
  const warning = c ? (liveWarnings(pod, events)[0] ?? null) : currentWarning(pod, events);
  if (c) {
    const headline = containerHeadline(c);
    const ended = isTerminated(c.state) ? c.state : isTerminated(c.last_state) ? c.last_state : null;
    // A crash loop's "back-off 5m0s restarting failed container=..." says nothing new.
    const message = c.state.state === "waiting" && c.state.reason !== "CrashLoopBackOff" ? c.state.message : "";
    return {
      headline,
      container: c.name,
      reason: c.state.reason || (ended?.reason ?? ""),
      lastRun: ended && !headline.includes(endedText(ended)) ? `Last run ${endedText(ended)}` : "",
      termination: ended && ended.message && !said(headline, ended.message) ? ended.message.trim() : "",
      detail: said(headline, message) ? "" : message,
      // While it waits or has ended, its log is the run that ended; the
      // previous run is worth a button only once it runs again.
      previous: c.state.state === "running" && isTerminated(c.last_state),
      warning,
    };
  }
  const base = { container: "", lastRun: "", termination: "", previous: false, warning };
  if (pod.phase === "Failed") {
    const headline = pod.reason === "Evicted" ? `Evicted: ${pod.message}` : `The pod failed${pod.reason ? `: ${pod.reason}` : ""}`;
    return { ...base, headline, reason: pod.reason, detail: said(headline, pod.message) ? "" : pod.message };
  }
  // Pending (not scheduled), probes failing, or something only an event says.
  if (warning && (verdict || pod.phase === "Pending")) {
    const headline = cap(eventHeadline(warning.reason, warning.message));
    return { ...base, headline, reason: warning.reason, detail: said(headline, warning.message) ? "" : warning.message };
  }
  if (verdict) return { ...base, headline: verdict, reason: "", detail: "" };
  return null;
}

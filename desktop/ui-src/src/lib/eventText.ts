/**
 * Events in words (#484): the reason as a phrase ("Failed scheduling" for
 * `FailedScheduling`) and a one-line summary of the messages people see
 * most (the scheduler's "0/3 nodes are available: ...", back-off). The raw
 * reason and the full message stay next to them (a tooltip, the line below).
 */

/** Reasons whose words are not just the split name. */
const REASONS: Record<string, string> = {
  BackOff: "Back-off restarting",
  FailedAttachVolume: "Failed to attach volume",
  FailedCreate: "Failed to create",
  FailedCreatePodSandBox: "Failed to create pod sandbox",
  FailedKillPod: "Failed to stop pod",
  FailedMount: "Failed to mount volume",
  FailedPostStartHook: "Post-start hook failed",
  FailedPreStopHook: "Pre-stop hook failed",
  Killing: "Stopping container",
  OOMKilling: "Killed: out of memory",
  ProbeWarning: "Probe warning",
  SuccessfulCreate: "Created",
  SuccessfulDelete: "Deleted",
  Unhealthy: "Probe failed",
};

/**
 * The reason in words: "Failed scheduling", "Back-off restarting", "Node not
 * ready". A back-off on an image reads "Back-off pulling image". Anything
 * that is not a CamelCase name comes back as it is.
 */
export function reasonWords(reason: string, message = ""): string {
  if (reason === "BackOff" && /^Back-off pulling image/i.test(message)) return "Back-off pulling image";
  const known = REASONS[reason];
  if (known) return known;
  if (!/^[A-Za-z0-9]+$/.test(reason)) return reason;
  const words = reason.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+|\d+/g);
  if (!words || words.join("") !== reason) return reason;
  return words
    .map((w, i) => {
      if (i === 0) return w[0].toUpperCase() + w.slice(1);
      // Acronyms (OOM, PVC, DNS) keep their capitals.
      return w.length > 1 && w === w.toUpperCase() ? w : w.toLowerCase();
    })
    .join(" ");
}

/** What a scheduler predicate in "0/3 nodes are available: ..." means. */
const SCHEDULER: { test: RegExp; what: string }[] = [
  { test: /untolerated taint|had taints? that the pod didn't tolerate/i, what: "taints the pod does not tolerate" },
  { test: /didn't match pod's node affinity|didn't match node selector/i, what: "no match for the pod's node selector or affinity" },
  { test: /were unschedulable|unschedulable/i, what: "cordoned" },
  { test: /didn't have free ports/i, what: "the pod's host ports in use" },
  { test: /volume node affinity conflict/i, what: "its volumes in another zone" },
  { test: /too many pods/i, what: "no room for more pods" },
  { test: /didn't match pod (anti-)?affinity rules|pod anti-affinity/i, what: "pod affinity rules not met" },
];

/** Resource names in words: cpu → CPU, ephemeral-storage → ephemeral storage. */
function resourceWords(name: string): string {
  switch (name) {
    case "cpu":
      return "CPU";
    case "memory":
      return "memory";
    case "ephemeral-storage":
      return "ephemeral storage";
    case "pods":
      return "pod slots";
    default:
      return name;
  }
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

function nodes(n: number): string {
  return `${n} ${n === 1 ? "node" : "nodes"}`;
}

/** "No node has enough CPU and memory" for the scheduler's message. */
function schedulerSummary(message: string): string {
  if (/^no nodes available to schedule pods/i.test(message)) return "The cluster has no nodes to run the pod on";
  const m = /^0\/(\d+) nodes are available:\s*(.*)$/is.exec(message);
  if (!m) return "";
  // What comes after "preemption:" is about evicting other pods: noise here.
  const body = m[2].split(/\.?\s*preemption:/i)[0].replace(/\.\s*$/, "");
  if (/unbound immediate PersistentVolumeClaims/i.test(body)) return "A volume claim of the pod is not bound yet";
  const short: string[] = [];
  const parts: string[] = [];
  const insufficient: string[] = [];
  let insufficientNodes = 0;
  for (const raw of body.split(/,\s*(?=\d+ )/)) {
    const item = raw.trim();
    const count = /^(\d+)\s+/.exec(item);
    const n = count ? Number(count[1]) : 0;
    const lack = /Insufficient\s+(\S+)/i.exec(item);
    if (lack) {
      const r = resourceWords(lack[1]);
      if (!insufficient.includes(r)) insufficient.push(r);
      insufficientNodes = Math.max(insufficientNodes, n);
      continue;
    }
    const known = SCHEDULER.find((s) => s.test.test(item));
    if (known) {
      parts.push(n ? `${nodes(n)} with ${known.what}` : known.what);
      short.push(known.what);
    }
  }
  if (insufficient.length && !parts.length) return `No node has enough ${joinAnd(insufficient)}`;
  if (!insufficient.length && parts.length === 1) {
    const what = short[0];
    return what === "cordoned" ? "Every node is cordoned" : `No node fits: ${what}`;
  }
  if (insufficient.length) {
    const lacking = insufficientNodes ? `${nodes(insufficientNodes)} short of ${joinAnd(insufficient)}` : `not enough ${joinAnd(insufficient)}`;
    parts.unshift(lacking);
  }
  return parts.length ? `No node fits: ${parts.join(", ")}` : "";
}

/**
 * A short line for the messages that are long and alike: the scheduler's
 * "0/3 nodes are available: 3 Insufficient cpu, ..." becomes "No node has
 * enough CPU", "Back-off restarting failed container app in pod
 * web_demo(1c9e...)" becomes "Container app keeps failing". "" when the
 * message says it well enough itself.
 */
export function eventSummary(reason: string, message: string): string {
  if (reason === "FailedScheduling") return schedulerSummary(message);
  const restart = /^Back-off restarting failed container (\S+)/i.exec(message);
  if (restart) return `Container ${restart[1]} keeps failing; restarting it after a delay`;
  const pull = /^Back-off pulling image "([^"]+)"/i.exec(message);
  if (pull) return `Cannot pull image ${pull[1]}; retrying after a delay`;
  const failedPull = /^Failed to pull image "([^"]+)"/i.exec(message);
  if (failedPull) return `Cannot pull image ${failedPull[1]}`;
  const probe = /^(Readiness|Liveness|Startup) probe failed:/i.exec(message);
  if (probe) return `${probe[1]} probe failed`;
  const mount = /^MountVolume\.\S+ failed for volume "([^"]+)"\s*:\s*(.*)$/is.exec(message);
  if (mount) return `Cannot mount volume ${mount[1]}: ${mount[2].split("\n")[0]}`;
  return "";
}

/** The line to show for an event where there is room for one: its summary,
 *  or the message itself (the full message goes in a tooltip). */
export function eventHeadline(reason: string, message: string): string {
  return eventSummary(reason, message) || message;
}

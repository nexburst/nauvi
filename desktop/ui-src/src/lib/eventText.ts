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

/**
 * What a scheduler predicate in "0/3 nodes are available: ..." means, as
 * phrases that read after a count ("1 node is cordoned", "2 nodes are
 * cordoned") and for the case where it rules out every node.
 */
const SCHEDULER: { test: RegExp; one: string; many: string; all: string }[] = [
  {
    test: /untolerated taint|had taints? that the pod didn't tolerate/i,
    one: "has a taint the pod does not tolerate",
    many: "have taints the pod does not tolerate",
    all: "Every node has a taint the pod does not tolerate",
  },
  {
    test: /didn't match pod's node affinity|didn't match node selector/i,
    one: "does not match the pod's node selector or affinity",
    many: "do not match the pod's node selector or affinity",
    all: "No node matches the pod's node selector or affinity",
  },
  {
    test: /were unschedulable|was unschedulable/i,
    one: "is cordoned",
    many: "are cordoned",
    all: "Every node is cordoned",
  },
  {
    test: /didn't have free ports/i,
    one: "has the pod's host ports in use",
    many: "have the pod's host ports in use",
    all: "Every node has the pod's host ports in use",
  },
  {
    test: /volume node affinity conflict/i,
    one: "cannot reach the pod's volumes (another zone)",
    many: "cannot reach the pod's volumes (another zone)",
    all: "No node can reach the pod's volumes (another zone)",
  },
  {
    test: /^\d+ too many pods$/i,
    one: "runs as many pods as it can",
    many: "run as many pods as they can",
    all: "Every node runs as many pods as it can",
  },
  {
    test: /didn't match pod (anti-)?affinity rules|didn't satisfy existing pods anti-affinity rules/i,
    one: "does not meet the pod's (anti-)affinity rules",
    many: "do not meet the pod's (anti-)affinity rules",
    all: "No node meets the pod's (anti-)affinity rules",
  },
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

/**
 * "No node has enough CPU and memory" for the scheduler's message. "" when
 * any part of it is not one we know: a summary that leaves a reason out
 * would say something false, so the raw message stands alone then.
 */
function schedulerSummary(message: string): string {
  if (/^no nodes available to schedule pods/i.test(message)) return "The cluster has no nodes to run the pod on";
  const m = /^0\/(\d+) nodes are available:\s*(.*)$/is.exec(message);
  if (!m) return "";
  const total = Number(m[1]);
  // What comes after "preemption:" is about evicting other pods: noise here.
  const body = m[2].split(/\.?\s*preemption:/i)[0].replace(/\.\s*$/, "").trim();
  if (/^pod has unbound immediate PersistentVolumeClaims$/i.test(body)) return "A volume claim of the pod is not bound yet";
  // Nodes short of each resource, in the order the message names them.
  const lacking = new Map<string, number>();
  const known: { n: number; s: (typeof SCHEDULER)[number] }[] = [];
  for (const raw of body.split(/,\s*(?=\d+ )/)) {
    const item = raw.trim();
    const count = /^(\d+)\s+/.exec(item);
    if (!count) return "";
    const n = Number(count[1]);
    const lack = /^\d+ Insufficient (\S+)$/i.exec(item);
    if (lack) {
      const r = resourceWords(lack[1]);
      lacking.set(r, Math.max(lacking.get(r) ?? 0, n));
      continue;
    }
    const s = SCHEDULER.find((x) => x.test.test(item));
    if (!s) return "";
    known.push({ n, s });
  }
  // One reason that rules out every node.
  const counts = new Set(lacking.values());
  if (!known.length && lacking.size && counts.size === 1 && counts.has(total)) {
    return `No node has enough ${joinAnd([...lacking.keys()])}`;
  }
  if (!lacking.size && known.length === 1 && known[0].n === total) return known[0].s.all;
  // Otherwise each reason with its count; resources short on as many nodes
  // go together ("2 nodes short of CPU and memory").
  const parts: string[] = [];
  const byCount = new Map<number, string[]>();
  for (const [r, n] of lacking) byCount.set(n, [...(byCount.get(n) ?? []), r]);
  for (const [n, rs] of byCount) parts.push(`${nodes(n)} short of ${joinAnd(rs)}`);
  for (const { n, s } of known) parts.push(`${nodes(n)} ${n === 1 ? s.one : s.many}`);
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

// The one line at the top of a dock tab (#386): what the tab is attached to,
// so the pod, container and namespace stay visible once the detail panel is
// closed. The component is `components/DockContext.svelte`.

import type { DockTabSpec } from "./dock";
import { ALL_CONTAINERS } from "./logs";

/** An object a part of the line opens: its kind by API group and name. */
export interface ContextLink {
  group: string;
  kind: string;
  /** Empty for cluster-scoped kinds (namespaces, nodes). */
  namespace: string;
  name: string;
}

/** A piece of the line: plain text, or text that opens `link`. */
export interface ContextPart {
  text: string;
  link?: ContextLink;
  /** Shown in a monospace face (names, containers, images). */
  code?: boolean;
  /** Which run of the container a log tab shows (#493): stands out a little. */
  run?: boolean;
}

/** What the log options are set to (unused by shells). */
export interface LogOptions {
  /** The container picked; `ALL_CONTAINERS` or empty for all of them. */
  container?: string;
  /** The "since" option: "all", or seconds. */
  since?: string;
  /** Which run of the container is shown (#493, `logRun.ts`); empty: say nothing. */
  run?: string;
}

/** The "since" option in words, as the log picker shows it. */
export function sinceLabel(since: string | undefined): string {
  if (!since || since === "all") return "all time";
  const s = Number(since);
  if (!Number.isFinite(s) || s <= 0) return "all time";
  if (s % 3600 === 0) return `the last ${s / 3600}h`;
  if (s % 60 === 0) return `the last ${s / 60}m`;
  return `the last ${s}s`;
}

/** The API group of a workload kind with merged logs. */
export function workloadGroup(kind: string): string {
  return kind.toLowerCase() === "job" ? "batch" : "apps";
}

const text = (t: string): ContextPart => ({ text: t });
const code = (t: string): ContextPart => ({ text: t, code: true });
const ns = (namespace: string): ContextPart => ({
  text: namespace,
  code: true,
  link: { group: "", kind: "Namespace", namespace: "", name: namespace },
});
const pod = (namespace: string, name: string): ContextPart => ({
  text: name,
  code: true,
  link: { group: "", kind: "Pod", namespace, name },
});

function containerParts(container: string | null | undefined, fallback: string): ContextPart[] {
  if (!container || container === ALL_CONTAINERS) return [text(`, ${fallback}`)];
  return [text(", container "), code(container)];
}

/**
 * The parts of a tab's line. `container` is the shell's or the picked log
 * container (`null`/empty: the default one, or all of them for logs).
 */
export function dockContext(spec: DockTabSpec, opts: LogOptions & { shellContainer?: string | null } = {}): ContextPart[] {
  switch (spec.type) {
    case "podLogs":
      return [
        text("Logs of pod "),
        pod(spec.pod.namespace, spec.pod.name),
        text(" in namespace "),
        ns(spec.pod.namespace),
        ...containerParts(opts.container, "all containers"),
        ...(opts.run ? [text(", "), { text: opts.run, run: true }] : []),
        text(`, from ${sinceLabel(opts.since)}`),
      ];
    case "workloadLogs": {
      const kind = spec.workload.kind;
      return [
        text(`Logs of ${kind.toLowerCase()} `),
        {
          text: spec.workload.name,
          code: true,
          link: { group: workloadGroup(kind), kind, namespace: spec.workload.namespace, name: spec.workload.name },
        },
        text(" in namespace "),
        ns(spec.workload.namespace),
        text(", all pods"),
        ...containerParts(opts.container, "all containers"),
        text(`, from ${sinceLabel(opts.since)}`),
      ];
    }
    case "terminal":
      return [
        text("Shell into pod "),
        pod(spec.pod.namespace, spec.pod.name),
        ...containerParts(opts.shellContainer ?? spec.container, "default container"),
        text(", in namespace "),
        ns(spec.pod.namespace),
      ];
    case "attach":
      return [
        text("Attached to pod "),
        pod(spec.pod.namespace, spec.pod.name),
        ...containerParts(spec.container, "default container"),
        text(", in namespace "),
        ns(spec.pod.namespace),
      ];
    case "debug":
      return [
        text("Debug container "),
        code(spec.image),
        text(" in pod "),
        pod(spec.pod.namespace, spec.pod.name),
        text(", sharing the processes of "),
        code(spec.target),
        text(", in namespace "),
        ns(spec.pod.namespace),
      ];
    case "nodeShell":
      return [
        text("Root shell on node "),
        { text: spec.node, code: true, link: { group: "", kind: "Node", namespace: "", name: spec.node } },
        text(", through a pod in namespace "),
        ns(spec.namespace),
      ];
    case "localShell":
      return [text("Shell on this machine, kubectl pointed at namespace "), code(spec.namespace)];
    case "askAi":
      return [
        text("AI CLI on this machine (then your shell), kubectl pointed at namespace "),
        code(spec.namespace),
      ];
  }
}

/** The line as plain text (for its tooltip and the tests). */
export function contextText(parts: readonly ContextPart[]): string {
  return parts.map((p) => p.text).join("");
}

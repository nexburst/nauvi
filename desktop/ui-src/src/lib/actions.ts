import type { ActionDef, ActionId, DrainEvent, ResourceRef } from "./bindings";
import type { Row } from "./columns";

/** One object an action is applied to. */
export interface ActionTarget {
  /** Empty for cluster-scoped kinds. */
  namespace: string;
  name: string;
}

/** How many names a confirmation lists before saying "and N more". */
const LISTED = 8;

export function targetLabel(t: ActionTarget): string {
  return t.namespace ? `${t.namespace}/${t.name}` : t.name;
}

/** A readable list of the exact objects: names, then "and N more". */
export function listTargets(targets: ActionTarget[]): string[] {
  const names = targets.slice(0, LISTED).map(targetLabel);
  if (targets.length > LISTED) names.push(`…and ${targets.length - LISTED} more`);
  return names;
}

/**
 * An action needs a dialog if it is destructive or asks for input, and
 * whenever it hits several objects at once.
 */
export function needsDialog(action: ActionDef, targets: ActionTarget[]): boolean {
  return action.destructive || action.input !== "none" || targets.length > 1;
}

/** Scaling to 0 stops the workload, so it reads as destructive. */
export function isDestructive(action: ActionDef, replicas: number): boolean {
  return action.destructive || (action.id === "scale" && replicas === 0);
}

const VERB: Record<ActionId, string> = {
  delete: "Delete",
  forceDelete: "Force delete",
  scale: "Scale",
  restart: "Restart",
  cordon: "Cordon",
  uncordon: "Uncordon",
  drain: "Drain",
  trigger: "Trigger",
  suspend: "Suspend",
  resume: "Resume",
  portForward: "Port forward",
  debug: "Debug",
  nodeShell: "Shell",
  attach: "Attach",
  evict: "Evict",
};

export interface Copy {
  title: string;
  /** The sentence above the list of objects. */
  lead: string;
  /** Warning shown under the list, if any. */
  warning: string;
  /** Text of the confirm button. */
  button: string;
}

/** The wording of the confirmation: names the kind, the count and the effect. */
export function confirmCopy(action: ActionDef, kind: string, count: number, replicas: number): Copy {
  const noun = count === 1 ? kind : `${count} ${kind}s`;
  const verb = VERB[action.id];
  switch (action.id) {
    case "delete":
      return {
        title: `Delete ${noun}`,
        lead: count === 1 ? `This permanently deletes the ${kind}:` : `This permanently deletes ${count} ${kind}s:`,
        warning: "",
        button: count === 1 ? "Delete" : `Delete ${count}`,
      };
    case "forceDelete":
      return {
        title: `Force delete ${noun}`,
        lead: "This removes the pod from the API immediately, with a grace period of 0:",
        warning:
          "Its containers may keep running on the node, and a StatefulSet pod may be replaced while the old one is still alive. Use this only for pods stuck terminating.",
        button: "Force delete",
      };
    case "evict":
      return {
        title: `Evict ${noun}`,
        lead: "This asks the API server to evict the pod, as a node drain does:",
        warning:
          "A PodDisruptionBudget that would be violated blocks the eviction. A pod without a controller is not recreated.",
        button: "Evict",
      };
    case "drain":
      return {
        title: `Drain ${noun}`,
        lead: "This cordons the node, then evicts its pods (DaemonSet and mirror pods are left alone):",
        warning:
          "Pods without a controller are not recreated elsewhere. Evictions blocked by a PodDisruptionBudget are retried until the timeout.",
        button: "Drain",
      };
    case "scale":
      return {
        title: `Scale ${noun}`,
        lead: "Set the number of replicas of:",
        warning: replicas === 0 ? "Scaling to 0 stops every pod of this workload until it is scaled up again." : "",
        button: replicas === 0 ? "Scale to 0" : `Scale to ${replicas}`,
      };
    default:
      return { title: `${verb} ${noun}`, lead: `${verb}:`, warning: "", button: verb };
  }
}

/** "3/5" in a workload's ready column: the desired count is the second number. */
export function replicasFromRow(row: Row | undefined, columnKeys: string[]): number {
  const i = columnKeys.indexOf("ready");
  const m = i >= 0 ? /^(\d+)\/(\d+)$/.exec(row?.cells[i] ?? "") : null;
  return m ? Number(m[2]) : 1;
}

/** One progress line of a drain, in plain words. */
export function drainLine(ev: DrainEvent): string {
  switch (ev.type) {
    case "cordoned":
      return `Node ${ev.node} cordoned`;
    case "planned": {
      const extra = ev.unmanaged > 0 ? ` (${ev.unmanaged} without a controller will not be recreated)` : "";
      return `${ev.to_evict} pods to evict, ${ev.skipped} skipped${extra}`;
    }
    case "evicted":
      return `Evicted ${ev.namespace}/${ev.name}`;
    case "waitingOnPdb":
      return `${ev.namespace}/${ev.name}: blocked by a PodDisruptionBudget, retrying`;
    case "failed":
      return `${ev.namespace}/${ev.name}: failed. ${ev.error}`;
  }
}

export function sameResource(a: ResourceRef, b: ResourceRef): boolean {
  return a.group === b.group && a.version === b.version && a.kind === b.kind && a.plural === b.plural;
}

/** What a detail panel action is checked and drawn as: an ActionId, or
 *  one of the panel's own entries. */
export type PanelActionId = ActionId | "logs" | "shell" | "edit" | "link";

/** One icon in the detail panel's action header (#218). */
export type PanelAction<Spec> = {
  id: PanelActionId;
  /** The row menu's label: the button's accessible name. */
  label: string;
  /** The tooltip: the label without its "…". */
  tip: string;
  danger: boolean;
} & ({ run: "dock"; spec: Spec } | { run: "edit" } | { run: "link" } | { run: "action"; action: ActionDef });

/**
 * The detail panel's actions: the row menu's dock entries (Logs, Shell) and
 * registry actions, plus Edit (the YAML editor) and Copy link (#299).
 * Opening things comes first, then the other actions, Edit, Copy link, and
 * the destructive ones last.
 */
export function panelActions<Spec>(dock: { label: string; spec: Spec }[], actions: ActionDef[]): PanelAction<Spec>[] {
  const fromRegistry = (a: ActionDef): PanelAction<Spec> => ({
    id: a.id,
    label: a.label,
    tip: a.label.replace("…", ""),
    danger: a.destructive,
    run: "action",
    action: a,
  });
  return [
    ...dock.map(
      (d): PanelAction<Spec> => ({
        id: d.label === "Shell" ? "shell" : "logs",
        label: d.label,
        tip: d.label,
        danger: false,
        run: "dock",
        spec: d.spec,
      }),
    ),
    ...actions.filter((a) => !a.destructive).map(fromRegistry),
    { id: "edit", label: "Edit", tip: "Edit YAML", danger: false, run: "edit" },
    { id: "link", label: "Copy link", tip: "Copy link", danger: false, run: "link" },
    ...actions.filter((a) => a.destructive).map(fromRegistry),
  ];
}

/**
 * Per-context read-only and protected modes (#338). The backend enforces
 * them (`desktop/src/state/mutation.rs`): a read-only context refuses every
 * change, a protected one needs its context name typed with each change.
 * This module is what the UI needs to say so.
 */

import type { ContextMode } from "./bindings";
import type { MutatingCommand } from "./cluster";

export const CONTEXT_MODES: { mode: ContextMode; label: string; hint: string }[] = [
  { mode: "normal", label: "Normal", hint: "Changes go ahead after the usual confirmations." },
  {
    mode: "protected",
    label: "Protected",
    hint: "Every change (actions, deletes, edits, Helm, terminals) asks you to type the context name first.",
  },
  {
    mode: "readOnly",
    label: "Read-only",
    hint: "Every change is refused, terminals included. Logs and port-forwards still work.",
  },
];

/** The badge text of a mode ("" for normal). */
export function modeLabel(mode: ContextMode | undefined): string {
  if (mode === "readOnly") return "Read-only";
  if (mode === "protected") return "Protected";
  return "";
}

/** The badge tooltip. */
export function modeTitle(mode: ContextMode | undefined, name: string): string {
  if (mode === "readOnly") return `${name} is read-only: changes to this cluster are turned off`;
  if (mode === "protected") return `${name} is protected: every change asks you to type the context name`;
  return "";
}

/** Whether a call only validates (a dry run), which the backend lets through
 *  on a protected context without a confirmation. Mirrors `dry_run` in
 *  `mutation.rs`: the `dryRun` argument, or `request.dry_run`. */
export function isDryRun(command: MutatingCommand, args: unknown[]): boolean {
  switch (command) {
    case "cmdApplyResourceYaml":
      return args[5] === true;
    case "cmdApplyManifests":
      return args[2] === true;
    case "cmdHelmInstall":
    case "cmdHelmUpgrade":
    case "cmdMetricsAddonInstall":
      return (args[0] as { dry_run?: unknown } | undefined)?.dry_run === true;
    default:
      return false;
  }
}

/** `forceDelete` -> `Force delete`. */
function words(id: string): string {
  const w = id.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`);
  return w.charAt(0).toUpperCase() + w.slice(1);
}

function at(ns: unknown, name: unknown): string {
  return ns ? `${ns}/${name}` : String(name);
}

/** One line saying what a call is about to change, for the confirmation. */
export function describeMutation(command: MutatingCommand, args: unknown[]): string {
  const kind = (args[0] as { kind?: string } | undefined)?.kind ?? "object";
  switch (command) {
    case "cmdRunAction":
      return `${words(String(args[3] ?? "run"))} ${kind} ${at(args[1], args[2])}`;
    case "cmdDeleteResource":
      return `Delete ${kind} ${at(args[1], args[2])}`;
    case "cmdBulkDelete":
      return `Delete ${(args[1] as unknown[] | undefined)?.length ?? 0} ${kind} objects`;
    case "cmdApplyResourceYaml":
      return `Apply the edited YAML of ${kind} ${at(args[1], args[2])}`;
    case "cmdPatchData":
      return `Save the edited data of ${kind} ${at(args[1], args[2])}`;
    case "cmdApplyManifests":
      return "Create or update the objects of the manifest";
    case "cmdDrainNode":
      return `Drain node ${args[0]}`;
    case "cmdExecStart":
      return `Open a shell in pod ${at(args[0], args[1])}`;
    case "cmdAttachStart":
      return `Attach to pod ${at(args[0], args[1])}`;
    case "cmdDebugStart":
      return `Add a debug container to pod ${at(args[1], args[2])}`;
    case "cmdNodeShellStart":
      return `Open a root shell on node ${args[1]}`;
    case "cmdNodeShellCleanup":
      return "Delete the node shell pods left behind";
    case "cmdLocalShellStart":
      return "Open a local terminal with this cluster's kubeconfig";
    case "cmdHelmInstall":
      return `Install Helm release ${(args[0] as { name?: string } | undefined)?.name ?? ""}`.trim();
    case "cmdHelmUpgrade":
      return `Upgrade Helm release ${(args[0] as { name?: string } | undefined)?.name ?? ""}`.trim();
    case "cmdHelmRollback":
      return `Roll back Helm release ${at(args[0], args[1])} to revision ${args[2]}`;
    case "cmdHelmUninstall":
      return `Uninstall Helm release ${at(args[0], args[1])}`;
    case "cmdMetricsAddonInstall":
      return "Install the metrics add-on";
  }
}

// Read-only and protected contexts (#338). The mode is kept in the
// settings and changed only through `cmd_set_context_mode`; the backend
// refuses or checks every change. Here: what the badges read, and the
// typed confirmation a protected context asks for before each change,
// which `api(id)` waits for (`setMutationGuard`).

import { commands } from "../bindings";
import type { ContextMode, MutationTarget } from "../bindings";
import { setMutationGuard } from "../cluster";
import type { MutatingCommand } from "../cluster";
import { describeMutation, isDryRun } from "../contextMode";
import { app, currentContextName } from "./app.svelte";
import { contextSettings, settings } from "./settings.svelte";

/** A change waiting for the user to type the context name. */
export interface PendingConfirm {
  /** The cluster id. */
  id: string;
  /** The context name to type. */
  name: string;
  /** What the change does, in one line. */
  what: string;
  resolve: (typed: string | null) => void;
}

class ProtectUi {
  /** Oldest first; the dialog shows the first. */
  queue = $state.raw<PendingConfirm[]>([]);
}
export const protect = new ProtectUi();

/** The mode of the cluster `id` (default: this window's). */
export function contextMode(id: string = currentContextName()): ContextMode {
  return contextSettings(id || currentContextName()).mode ?? "normal";
}

/** The name the user types to confirm a change to `id`: its context's name
 *  in its kubeconfig (what the backend compares). */
export function contextNameOf(id: string): string {
  const key = id || currentContextName();
  return app.contexts.find((c) => c.name === key)?.context ?? key;
}

/** Change the mode of `id`; the settings come back from the backend. */
export async function setContextMode(
  id: string,
  mode: ContextMode,
): Promise<void> {
  settings.current = await commands.cmdSetContextMode(id, mode);
}

/** Ask the user to type the context name. Resolves to what they typed, or
 *  null when they cancel. */
export function askConfirmation(
  id: string,
  what: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const entry: PendingConfirm = {
      id,
      name: contextNameOf(id),
      what,
      resolve: (typed) => {
        protect.queue = protect.queue.filter((p) => p !== entry);
        resolve(typed);
      },
    };
    protect.queue = [...protect.queue, entry];
  });
}

/** The `cluster` a mutating call sends: on a protected context (not for a
 *  dry run), the id with the typed confirmation. */
export async function mutationTarget(
  id: string,
  command: MutatingCommand,
  args: unknown[],
): Promise<MutationTarget | null> {
  if (contextMode(id) !== "protected" || isDryRun(command, args)) return id;
  const typed = await askConfirmation(id, describeMutation(command, args));
  return typed === null ? null : { id, confirm: typed };
}

setMutationGuard(mutationTarget);

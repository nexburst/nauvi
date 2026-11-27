/**
 * Which cluster a command is for (ADR 0007, #333).
 *
 * Every cluster-scoped command in `bindings.ts` takes `cluster: string` as
 * its first parameter (the backend's `Cluster` extractor reads it). Call
 * them through `api(id)`, which fills it in:
 *
 *     await api(visibleCluster()).cmdListNamespaces();
 *
 * Commands that are not about one cluster (settings, kubeconfig sources,
 * helm repositories, the window, ...) are listed in `GLOBAL_COMMANDS` and
 * stay on `commands`. `cluster.test.ts` checks this list against
 * `bindings.ts`.
 *
 * A cluster's id is its context name. A window can be connected to several
 * (the cluster tree, `stores/clusters.svelte.ts`) and shows one.
 */

import { commands } from "./bindings";
import type { MutationTarget } from "./bindings";

type Commands = typeof commands;
export type CommandName = keyof Commands;

/** The commands without a `cluster` parameter, sorted. */
export const GLOBAL_COMMANDS = [
  "cmdAddKubeconfigSource",
  "cmdAnswerExecCommand",
  "cmdAskAiSetup",
  "cmdAskAiSkillRemove",
  "cmdAutostartEnabled",
  "cmdAutostartSet",
  "cmdCheckContext",
  "cmdDiagnostics",
  "cmdDiscardAndClose",
  "cmdExecCommands",
  "cmdGetClusterProxy",
  "cmdGetSettings",
  "cmdHelmChartShow",
  "cmdHelmChartVersions",
  "cmdHelmRepoAdd",
  "cmdHelmRepoList",
  "cmdHelmRepoRemove",
  "cmdHelmRepoUpdate",
  "cmdHelmSearch",
  "cmdHelmVersion",
  "cmdHelpOpen",
  "cmdKubeconfigSources",
  "cmdLogUiError",
  "cmdMetricsAddons",
  "cmdOpenWindow",
  "cmdPasteKubeconfig",
  "cmdPortforwardListAll",
  "cmdRegistryTags",
  "cmdRemoveKubeconfigSource",
  "cmdSaveCsv",
  "cmdSaveLogs",
  "cmdSetClusterProxy",
  "cmdSetContextMode",
  "cmdSetUnsaved",
  "cmdSetZoom",
  "cmdTakeLink",
  "cmdUpdateCheck",
  "cmdUpdateInstall",
  "cmdUpdateSettings",
] as const satisfies readonly CommandName[];

/**
 * The commands that change a cluster (#338), sorted: in `bindings.ts` their
 * `cluster` is a `MutationTarget`, which the backend's gate checks against
 * the context's read-only or protected mode (port-forwards: confirmed on
 * a protected context, allowed on a read-only one). `api(id)` asks the guard set
 * by `stores/contextMode.svelte.ts` for it, which asks the user to type the
 * context name on a protected context. `cluster.test.ts` checks this list
 * against `bindings.ts`.
 */
export const MUTATING_COMMANDS = [
  "cmdApplyManifests",
  "cmdApplyResourceYaml",
  "cmdAskAiStart",
  "cmdAttachStart",
  "cmdBulkDelete",
  "cmdDebugStart",
  "cmdDeleteResource",
  "cmdDrainNode",
  "cmdExecStart",
  "cmdHelmInstall",
  "cmdHelmRollback",
  "cmdHelmUninstall",
  "cmdHelmUpgrade",
  "cmdLocalShellStart",
  "cmdMetricsAddonInstall",
  "cmdNodeShellCleanup",
  "cmdNodeShellStart",
  "cmdPatchData",
  "cmdPortforwardStart",
  "cmdPortforwardStartSaved",
  "cmdRunAction",
] as const satisfies readonly CommandName[];

export type MutatingCommand = (typeof MUTATING_COMMANDS)[number];
const MUTATING = new Set<string>(MUTATING_COMMANDS);

export function isMutatingCommand(name: string): name is MutatingCommand {
  return MUTATING.has(name);
}

/** What a mutating call sends as its `cluster`: `id`, or `{ id, confirm }`
 *  with the typed context name. `null`: the user cancelled. */
export type MutationGuard = (id: string, command: MutatingCommand, args: unknown[]) => Promise<MutationTarget | null>;

let guard: MutationGuard = async (id) => id;

/** Set how mutating calls get their `cluster` (the protected-mode prompt). */
export function setMutationGuard(g: MutationGuard) {
  guard = g;
}

/** What a cancelled confirmation throws, like a backend error. */
export const CANCELLED = "Cancelled: nothing was changed";

export type GlobalCommand = (typeof GLOBAL_COMMANDS)[number];
export type ClusterCommand = Exclude<CommandName, GlobalCommand>;

/** A command with its `cluster` parameter filled in. `never` if the
 *  command does not start with a string (or a `MutationTarget`, which a
 *  string is), so a misfiled one fails to type. */
type Bound<F> = F extends (cluster: string, ...rest: infer A) => infer R ? (...rest: A) => R : never;

/** The cluster-scoped commands of one cluster. */
export type ClusterApi = { [K in ClusterCommand]: Bound<Commands[K]> };

const GLOBAL = new Set<string>(GLOBAL_COMMANDS);

export function isClusterCommand(name: string): name is ClusterCommand {
  return name in commands && !GLOBAL.has(name);
}

const apis = new Map<string, ClusterApi>();

/** The cluster-scoped commands, each called with `cluster` = `id`. */
export function api(id: string): ClusterApi {
  let a = apis.get(id);
  if (!a) {
    const bound: Record<string, (...args: unknown[]) => unknown> = {};
    for (const name of Object.keys(commands)) {
      if (!isClusterCommand(name)) continue;
      const cmd = commands[name] as (...args: unknown[]) => unknown;
      bound[name] = isMutatingCommand(name)
        ? async (...args: unknown[]) => {
            const target = await guard(id, name, args);
            if (target === null) throw CANCELLED;
            return cmd(target, ...args);
          }
        : (...args: unknown[]) => cmd(id, ...args);
    }
    a = bound as unknown as ClusterApi;
    apis.set(id, a);
  }
  return a;
}

let visible = "";

/** The cluster this window shows (its current context; `""` before the
 *  contexts are loaded or without a kubeconfig). */
export function visibleCluster(): string {
  return visible;
}

/** Set by the app store whenever it (re)loads the contexts. */
export function setVisibleCluster(id: string) {
  visible = id;
}

const switchHooks: (() => void)[] = [];

/**
 * Run `reset` whenever the window shows another cluster: a store that
 * holds what one cluster sent forgets it, so nothing of it shows for the
 * next one (ADR 0007).
 */
export function onClusterSwitch(reset: () => void) {
  switchHooks.push(reset);
}

/** The window shows another cluster now: reset every store that asked. */
export function clusterSwitched() {
  for (const reset of switchHooks) reset();
}

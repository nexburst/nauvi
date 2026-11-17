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
 * A cluster's id is its context name. For now each window still has one
 * session, so the backend only requires the value.
 */

import { commands } from "./bindings";

type Commands = typeof commands;
export type CommandName = keyof Commands;

/** The commands without a `cluster` parameter, sorted. */
export const GLOBAL_COMMANDS = [
  "cmdAddKubeconfigSource",
  "cmdAnswerExecCommand",
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
  "cmdRemoveKubeconfigSource",
  "cmdSaveCsv",
  "cmdSaveLogs",
  "cmdSetClusterProxy",
  "cmdSetUnsaved",
  "cmdSetZoom",
  "cmdTakeLink",
  "cmdUpdateCheck",
  "cmdUpdateInstall",
  "cmdUpdateSettings",
] as const satisfies readonly CommandName[];

export type GlobalCommand = (typeof GLOBAL_COMMANDS)[number];
export type ClusterCommand = Exclude<CommandName, GlobalCommand>;

/** A command with its `cluster` parameter filled in. `never` if the
 *  command does not start with a string, so a misfiled one fails to type. */
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
      bound[name] = (...args: unknown[]) => cmd(id, ...args);
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

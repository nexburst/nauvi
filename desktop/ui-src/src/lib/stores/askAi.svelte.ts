// Ask AI (#376): which AI CLIs this machine has, the dialog that starts one,
// and the dock tab it opens. The backend finds the CLIs on PATH (no CLI is
// installed or downloaded) and writes the nauvi skill (#466) when one starts.

import { commands } from "../bindings";
import type { AskAiSetup } from "../bindings";
import { askAiTitle } from "../askAi";
import type { AiObject, AskAiScope } from "../askAi";
import { localShellNamespace } from "../dock";
import { aiContextList, clearAiContext } from "./aiContext.svelte";
import { app, currentContextName } from "./app.svelte";
import { contextMode } from "./contextMode.svelte";
import { openDockTab } from "./dock.svelte";
import { settings, updateSettings } from "./settings.svelte";

/** The dialog: open with `scope`; `namespace` is where kubectl points. */
export const askAi = $state({
  /** What `cmd_ask_ai_setup` answered (`null`: not yet). */
  setup: null as AskAiSetup | null,
  scope: null as AskAiScope | null,
  /** The terminal's namespace. */
  namespace: "",
});

/** Ask the backend again (after a settings change, or on start). */
export async function loadAskAiSetup(): Promise<void> {
  try {
    askAi.setup = await commands.cmdAskAiSetup();
  } catch {
    // Without an answer the action stays hidden; the dialog asks again.
  }
}

/** Whether Ask AI is offered: a CLI was found or a command is set. */
export function askAiAvailable(): boolean {
  return (askAi.setup?.found.length ?? 0) > 0;
}

/** Whether the rows' Ask AI (Problem groups, Warning groups, the table's
 *  menu, #607) is offered: a CLI was found and the context is not
 *  read-only (nauvi opens no terminals there). */
export function askAiOffered(context: string = currentContextName()): boolean {
  return askAiAvailable() && contextMode(context) !== "readOnly";
}

/** Open the dialog about `scope` (default: the cluster or the one selected
 *  namespace on screen). */
export function openAskAi(scope?: Omit<AskAiScope, "context">) {
  const context = currentContextName();
  const ctx = app.contexts.find((c) => c.name === context);
  const selected = app.selectedNamespaces;
  const s: AskAiScope = scope
    ? { context, ...scope }
    : { context, namespace: selected.length === 1 ? selected[0] : "", kind: "", name: "" };
  askAi.scope = s;
  askAi.namespace = s.namespace || localShellNamespace(selected, ctx?.namespace);
  void loadAskAiSetup();
}

/** Open the dialog about several objects (#608): the rows selected in a
 *  table, or (no `objects`) the context's AI context list, which starting
 *  then empties. kubectl points at their namespace when they share one. */
export function openAskAiAbout(objects?: readonly AiObject[]) {
  const list = objects ?? aiContextList();
  if (list.length === 0) return;
  const spaces = new Set(list.map((o) => o.namespace).filter((n) => n !== ""));
  openAskAi({
    namespace: spaces.size === 1 ? [...spaces][0] : "",
    kind: "",
    name: "",
    objects: [...list],
    fromList: !objects,
  });
}

export function closeAskAi() {
  askAi.scope = null;
}

let seq = 0;

/** Start `cli` with `prompt` in a dock tab, and remember the pick. */
export function startAskAi(cli: string, prompt: string) {
  const scope = askAi.scope;
  if (!scope) return;
  if (settings.current.ask_ai_cli !== cli) updateSettings({ ask_ai_cli: cli });
  openDockTab({
    type: "askAi",
    seq: ++seq,
    context: scope.context,
    namespace: askAi.namespace,
    cli,
    prompt,
    title: askAiTitle(scope),
  });
  // The list went to this session; a cancelled dialog keeps it.
  if (scope.fromList) clearAiContext(scope.context);
  askAi.scope = null;
}

/** Remove the nauvi skill of place `id` (Settings, AI); throws the
 *  backend's reason. */
export async function removeAskAiSkill(id: string): Promise<void> {
  askAi.setup = await commands.cmdAskAiSkillRemove(id);
}

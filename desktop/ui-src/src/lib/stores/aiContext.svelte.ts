// The AI context list (#608): one list per context, in memory only (gone
// when the app closes). Switching contexts keeps each list; an Ask AI
// started with a list empties it, a cancelled one keeps it.

import { addRefused, objectKey, withObject, withoutObject } from "../aiContext";
import type { AiObject } from "../askAi";
import { currentContextName } from "./app.svelte";

/** The lists by context name. Replaced, never changed in place. */
let lists = $state.raw<Record<string, readonly AiObject[]>>({});

/** The list panel under the header's Ask AI. */
export const aiContextPanel = $state({ open: false });

/** The list of `context` (default: the one on screen). */
export function aiContextList(context: string = currentContextName()): readonly AiObject[] {
  return lists[context] ?? [];
}

/** Why `o` cannot be added to the list of `context` ("": it can). */
export function aiContextRefused(o: AiObject, context: string = currentContextName()): string {
  return addRefused(aiContextList(context), o);
}

/** Whether `o` is in the list of `context`. */
export function inAiContext(o: AiObject, context: string = currentContextName()): boolean {
  const key = objectKey(o);
  return aiContextList(context).some((e) => objectKey(e) === key);
}

/** Add `o` to the list of `context`; the reason it was refused, or "". */
export function addToAiContext(o: AiObject, context: string = currentContextName()): string {
  if (!context) return "No cluster is selected.";
  const list = aiContextList(context);
  const refused = addRefused(list, o);
  if (refused) return refused;
  lists = { ...lists, [context]: withObject(list, o) };
  return "";
}

/** Remove the object of `key` from the list of `context`. */
export function removeFromAiContext(key: string, context: string = currentContextName()) {
  lists = { ...lists, [context]: withoutObject(aiContextList(context), key) };
}

/** Empty the list of `context`. */
export function clearAiContext(context: string = currentContextName()) {
  if (!lists[context]) return;
  lists = Object.fromEntries(Object.entries(lists).filter(([c]) => c !== context));
}

/**
 * The AI context list (#608): the objects the user collects to hand to the
 * next Ask AI together. One list per context, at most `AI_CONTEXT_MAX`
 * objects, references only (kind, namespace, name, the reason nauvi showed).
 * Pure functions; the store (`stores/aiContext.svelte.ts`) keeps the lists.
 */

import type { AiObject } from "./askAi";

/** At most this many objects in one list. */
export const AI_CONTEXT_MAX = 20;

/** Why the 21st object is refused. */
export const AI_CONTEXT_FULL = `The list holds ${AI_CONTEXT_MAX} objects. Remove one to add another.`;

/** Why an object already in the list is not added again. */
export const AI_CONTEXT_HAS = "Already in the Ask AI list.";

/** One object's identity in a list: its kind, namespace and name. */
export function objectKey(o: Pick<AiObject, "kind" | "namespace" | "name">): string {
  return `${o.kind}\u0000${o.namespace}\u0000${o.name}`;
}

/** Why `o` cannot be added to `list` ("": it can). */
export function addRefused(list: readonly AiObject[], o: AiObject): string {
  if (list.some((e) => objectKey(e) === objectKey(o))) return AI_CONTEXT_HAS;
  if (list.length >= AI_CONTEXT_MAX) return AI_CONTEXT_FULL;
  return "";
}

/** `list` with `o` at its end, or `list` itself when it is refused. */
export function withObject(list: readonly AiObject[], o: AiObject): readonly AiObject[] {
  if (!o.kind || !o.name || addRefused(list, o)) return list;
  return [...list, o];
}

/** `list` without the object of `key`. */
export function withoutObject(list: readonly AiObject[], key: string): readonly AiObject[] {
  return list.filter((e) => objectKey(e) !== key);
}

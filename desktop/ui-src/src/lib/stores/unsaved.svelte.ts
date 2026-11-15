// Unsaved-changes guard. An editor with edits the user has not saved
// registers here; whatever would drop them (closing the panel, opening
// another object, switching view or context) goes through `whenDiscarded`
// or `confirmDiscard`, which ask "Discard changes?" first.

/** Shown by `UnsavedDialog` while a discard waits for an answer. */
export const unsaved = $state({ asking: false });

/** Owner id → what to do when the user discards its edits. */
const owners = new Map<string, () => void>();
let waiting: ((discard: boolean) => void)[] = [];
/** Told when the window starts or stops having unsaved edits. */
let listener: ((hasUnsaved: boolean) => void) | null = null;

/** Call `fn` whenever `hasUnsaved()` changes (`null`: stop). */
export function onUnsavedChange(fn: ((hasUnsaved: boolean) => void) | null) {
  listener = fn;
}

function changed(before: number) {
  if (before > 0 !== owners.size > 0) listener?.(owners.size > 0);
}

/** `id` has unsaved edits; `onDiscard` runs if the user discards them. */
export function markUnsaved(id: string, onDiscard: () => void) {
  const before = owners.size;
  owners.set(id, onDiscard);
  changed(before);
}

/** `id` has nothing unsaved (any more). */
export function markSaved(id: string) {
  const before = owners.size;
  owners.delete(id);
  changed(before);
}

export function hasUnsaved(): boolean {
  return owners.size > 0;
}

/**
 * Resolves `true` right away if nothing is unsaved, otherwise asks the user
 * and resolves with their answer. On `true` every owner's `onDiscard` has run.
 */
export function confirmDiscard(): Promise<boolean> {
  if (owners.size === 0) return Promise.resolve(true);
  unsaved.asking = true;
  return new Promise((resolve) => waiting.push(resolve));
}

/** The user's answer to the dialog. */
export function answerDiscard(discard: boolean) {
  unsaved.asking = false;
  if (discard) {
    const discards = [...owners.values()];
    const before = owners.size;
    owners.clear();
    changed(before);
    for (const fn of discards) fn();
  }
  const resolve = waiting;
  waiting = [];
  for (const r of resolve) r(discard);
}

/**
 * Run `fn` now if nothing is unsaved (synchronously, so callers behave as
 * before), or once the user agrees to discard. Never if they keep editing.
 */
export function whenDiscarded(fn: () => void): void {
  if (owners.size === 0) {
    fn();
    return;
  }
  void confirmDiscard().then((ok) => {
    if (ok) fn();
  });
}

// Confirm dialogs from the keyboard (#575): where the focus starts, Tab and
// Shift+Tab kept inside the dialog, and ←/→ between its buttons. On macOS
// Tab skips buttons unless "Keyboard navigation" is on, so the dialog moves
// the focus itself instead of leaving it to the engine.

const FOCUSABLE = [
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "a[href]",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Where a dialog's keyboard starts: its first field (a type-to-confirm or
 * replicas field), else its confirm button, else its last button (Close).
 */
export function defaultFocus(dialog: HTMLElement): HTMLElement | null {
  return (
    dialog.querySelector<HTMLElement>("input:not(:disabled)") ??
    dialog.querySelector<HTMLElement>("button.confirm:not(:disabled)") ??
    [...dialog.querySelectorAll<HTMLElement>(".buttons button:not(:disabled)")].at(-1) ??
    null
  );
}

/** Focus `dialog`'s default element, unless the focus is already inside it. */
export function focusDefault(dialog: HTMLElement) {
  if (!dialog.contains(document.activeElement)) defaultFocus(dialog)?.focus();
}

/** The index Tab (or Shift+Tab) moves to from `at` among `count` elements. */
export function tabIndex(at: number, count: number, back: boolean): number {
  if (count === 0) return -1;
  if (at < 0) return back ? count - 1 : 0;
  return (at + (back ? count - 1 : 1)) % count;
}

/**
 * A keydown in `dialog`: Tab and Shift+Tab go round its own elements, and
 * ←/→ move between the buttons of its button row. Returns whether it took
 * the key.
 */
export function dialogKeydown(e: KeyboardEvent, dialog: HTMLElement): boolean {
  if (e.altKey || e.ctrlKey || e.metaKey) return false;
  const active = document.activeElement;
  if (e.key === "Tab") {
    const all = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
    e.preventDefault();
    const next = all[tabIndex(all.indexOf(active as HTMLElement), all.length, e.shiftKey)];
    next?.focus();
    return true;
  }
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return false;
  if (!(active instanceof HTMLButtonElement) || !dialog.contains(active)) return false;
  const row = active.closest(".buttons");
  if (!row) return false;
  const buttons = [...row.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const next = buttons[buttons.indexOf(active) + (e.key === "ArrowLeft" ? -1 : 1)];
  if (!next) return false;
  e.preventDefault();
  next.focus();
  return true;
}

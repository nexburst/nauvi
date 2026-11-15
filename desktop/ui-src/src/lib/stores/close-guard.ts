// Closing the window or quitting the app with unsaved edits (#173). The
// backend is told whether this window has unsaved edits; while it has, it
// stops the close or quit and sends `unsaved-close-requested`, and the same
// "Discard changes?" dialog as in the app decides.

import { commands, events } from "../bindings";
import { thisWindow } from "../window";
import { confirmDiscard, hasUnsaved, onUnsavedChange } from "./unsaved.svelte";

/** Start the guard; returns the function that stops it. */
export function startCloseGuard(): () => void {
  const report = (unsaved: boolean) => void commands.cmdSetUnsaved(unsaved).catch(() => {});
  onUnsavedChange(report);
  report(hasUnsaved());
  const stop = events.unsavedCloseRequested(thisWindow()).listen((e) => {
    const quit = e.payload.quit;
    void confirmDiscard().then((discard) => {
      if (discard) void commands.cmdDiscardAndClose(quit).catch(() => {});
    });
  });
  return () => {
    onUnsavedChange(null);
    void stop.then((un) => un());
  };
}

// Saving files through the save dialog (`commands/files.rs`). The fake
// "dialog" answers with the suggested name in Downloads;
// `cluster.saveDialogCancels` makes the next ones answer as if the user
// cancelled.

import type { AreaHandlers, FakeState } from "./state";

export function filesHandlers(s: FakeState) {
  return {
    cmdSaveCsv: (filename) => {
      if (s.cluster.saveDialogCancels > 0) {
        s.cluster.saveDialogCancels--;
        return null;
      }
      return `/home/tester/Downloads/${filename}`;
    },
  } satisfies AreaHandlers;
}

// The local shell at the selected context (`commands/local_shell.rs`).

import type { AreaHandlers, FakeState } from "./state";

export function localShellHandlers(s: FakeState) {
  return {
    // `namespace` as asked.
    cmdLocalShellStart: (namespace) => ({
      session: `local-${++s.sessionSeq}`,
      context: s.cluster.contexts.find((c) => c.current)?.name ?? "",
      namespace: namespace ?? "default",
    }),
    cmdLocalShellInput: () => null,
    cmdLocalShellResize: () => null,
    cmdLocalShellClose: () => null,
  } satisfies AreaHandlers;
}

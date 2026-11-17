// The local shell at the selected context (`commands/local_shell.rs`).

import { fakeKubectl } from "./kubectl";
import type { AreaHandlers, FakeState } from "./state";

export function localShellHandlers(s: FakeState) {
  return {
    // `namespace` as asked. A downloaded kubectl is used with the setting on (#331).
    cmdLocalShellStart: (namespace) => {
      const k = fakeKubectl(s);
      return {
        session: `local-${++s.sessionSeq}`,
        context: s.cluster.contexts.find((c) => c.current)?.name ?? "",
        namespace: namespace ?? "default",
        kubectl: s.cluster.settings.kubectl_match && k.downloaded ? k.server : "",
      };
    },
    cmdLocalShellInput: () => null,
    cmdLocalShellResize: () => null,
    cmdLocalShellClose: () => null,
  } satisfies AreaHandlers;
}

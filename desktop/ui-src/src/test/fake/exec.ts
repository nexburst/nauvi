// Exec and attach sessions (`commands/exec.rs`).

import { events } from "../../lib/bindings";
import type { AreaHandlers, FakeState } from "./state";

export function execHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    cmdExecStart: () => `exec-${++s.sessionSeq}`,
    // Writes its note into the session before returning the id, like the backend.
    cmdAttachStart: async (namespace, name, container) => {
      if (cluster.attachError) throw cluster.attachError;
      const session = `attach-${++s.sessionSeq}`;
      await events.execOutput.emit({
        session,
        stream: "stderr",
        data: `Attached to ${name}/${container ?? "app"} in ${namespace}. Closing this tab detaches. The process keeps running.\r\n`,
      });
      return session;
    },
    cmdExecInput: () => null,
    cmdExecResize: () => null,
    cmdExecClose: () => null,
  } satisfies AreaHandlers;
}

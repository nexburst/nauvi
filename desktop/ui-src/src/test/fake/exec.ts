// Exec and attach sessions (`commands/exec.rs`).

import { sendTerm, startTerm } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function execHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    cmdExecStart: (_namespace, _name, _container, _cols, _rows, onOutput) =>
      startTerm(s, `exec-${++s.sessionSeq}`, onOutput),
    // Writes its note into the session before returning the id, like the backend.
    cmdAttachStart: (namespace, name, container, _cols, _rows, onOutput) => {
      if (cluster.attachError) throw cluster.attachError;
      const session = startTerm(s, `attach-${++s.sessionSeq}`, onOutput);
      sendTerm(
        s,
        session,
        `Attached to ${name}/${container ?? "app"} in ${namespace}. Closing this tab detaches. The process keeps running.\r\n`,
      );
      return session;
    },
    cmdExecAck: () => null,
    cmdExecInput: () => null,
    cmdExecResize: () => null,
    cmdExecClose: () => null,
  } satisfies AreaHandlers;
}

// Debug containers and node shells (`commands/debug.rs`).

import { events } from "../../lib/bindings";
import type { AreaHandlers, FakeState } from "./state";

export function debugHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    // Writes progress into the session first, like the backend.
    cmdDebugStart: async (session, namespace, name, target, image) => {
      await events.execOutput.emit({ session, stream: "stderr", data: `Adding a debug container (${image})…\r\n` });
      if (cluster.debugError) throw cluster.debugError;
      await events.execOutput.emit({
        session,
        stream: "stderr",
        data: `Attached to debugger-abcde (target ${target || "first"}) in ${namespace}/${name}\r\n`,
      });
      return session;
    },
    cmdNodeShellStart: async (session, node, namespace) => {
      await events.execOutput.emit({ session, stream: "stderr", data: `Starting pod ${namespace}/node-shell-${node}-abcde…\r\n` });
      if (cluster.nodeShellError) throw cluster.nodeShellError;
      await events.execOutput.emit({ session, stream: "stdout", data: `root@${node}:/# ` });
      return session;
    },
    cmdNodeShellLeftovers: () => structuredClone(cluster.nodeShellLeftovers),
    cmdNodeShellCleanup: () => {
      const n = cluster.nodeShellLeftovers.length;
      cluster.nodeShellLeftovers = [];
      return n;
    },
  } satisfies AreaHandlers;
}

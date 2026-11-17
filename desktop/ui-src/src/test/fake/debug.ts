// Debug containers and node shells (`commands/debug.rs`).

import { sendTerm, startTerm } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function debugHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    // Writes progress into the session first, like the backend.
    cmdDebugStart: async (session, namespace, name, target, image, _cols, _rows, onOutput) => {
      startTerm(s, session, onOutput);
      sendTerm(s, session, `Adding a debug container (${image})…\r\n`);
      if (cluster.debugError) throw cluster.debugError;
      sendTerm(s, session, `Attached to debugger-abcde (target ${target || "first"}) in ${namespace}/${name}\r\n`);
      return session;
    },
    cmdNodeShellStart: async (session, node, namespace, _cols, _rows, onOutput) => {
      startTerm(s, session, onOutput);
      sendTerm(s, session, `Starting pod ${namespace}/node-shell-${node}-abcde…\r\n`);
      if (cluster.nodeShellError) throw cluster.nodeShellError;
      sendTerm(s, session, `root@${node}:/# `);
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

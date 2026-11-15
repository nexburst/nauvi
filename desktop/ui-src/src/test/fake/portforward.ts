// Port forwards (`commands/portforward.rs`).

import type { ForwardInfo } from "../../lib/bindings";
import type { AreaHandlers, FakeState } from "./state";

export function portforwardHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    // Like the backend: no local port means the remote one if >= 1024, else 40000 + it.
    cmdPortforwardStart: (target, remote, local) => {
      const same = (f: ForwardInfo) =>
        f.target.kind === target.kind && f.target.namespace === target.namespace && f.target.name === target.name;
      const existing = local === null ? cluster.forwards.find((f) => same(f) && f.remote === remote) : undefined;
      if (existing) return existing;
      const remotePort = /^\d+$/.test(remote) ? Number(remote) : 8080;
      const port = local ?? (remotePort >= 1024 ? remotePort : 40000 + remotePort);
      const localPort = port === 0 ? 45000 + s.sessionSeq : port;
      if (local !== null && cluster.forwards.some((f) => f.local_port === localPort)) {
        throw `local port ${localPort} is already in use: pick another one, or leave it empty for a free one`;
      }
      const f: ForwardInfo = {
        id: `pf-${++s.sessionSeq}`,
        target,
        remote,
        remote_port: remotePort,
        local_port: localPort,
        url: `http://127.0.0.1:${localPort}`,
        started_at: Date.now(),
        status: { pod: target.kind === "pod" ? target.name : `${target.name}-1`, connections: 0, total_connections: 0, last_error: "" },
      };
      cluster.forwards.push(f);
      return f;
    },
    cmdPortforwardStop: (id) => {
      cluster.forwards = cluster.forwards.filter((f) => f.id !== id);
      return null;
    },
    // A copy, like real IPC: the app must see a new list after the tests change this one.
    cmdPortforwardList: () => JSON.parse(JSON.stringify(cluster.forwards)) as ForwardInfo[],
    cmdServicePorts: (namespace, name) => cluster.servicePorts[`${namespace}/${name}`] ?? [],
  } satisfies AreaHandlers;
}

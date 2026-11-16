// Port forwards (`commands/portforward.rs`). Saved forwards live in the
// fake settings, by context, so they come back after a reload (a restart).

import type { ForwardInfo, ForwardTarget, SavedForward } from "../../lib/bindings";
import { copy, saveSettings } from "./state";
import type { AreaHandlers, FakeState } from "./state";

const sameTarget = (a: ForwardTarget, b: ForwardTarget) =>
  a.kind === b.kind && a.namespace === b.namespace && a.name === b.name;

export function portforwardHandlers(s: FakeState) {
  const { cluster } = s;
  const ctx = () => cluster.contexts.find((c) => c.current)?.name ?? "";
  const saved = (): SavedForward[] => cluster.settings.forwards[ctx()] ?? [];
  const store = (list: SavedForward[]) => {
    const forwards = { ...cluster.settings.forwards };
    if (list.length > 0) forwards[ctx()] = list;
    else delete forwards[ctx()];
    saveSettings(s, { ...cluster.settings, forwards });
  };
  let idSeq = 0;
  const check = (f: SavedForward) => {
    if (!/^\d+$/.test(f.remote) && !/^[a-z0-9-]+$/.test(f.remote)) throw `invalid remote port '${f.remote}'`;
    if (f.local_port !== "" && !/^\d+$/.test(f.local_port)) {
      throw `the local port must be a number between 0 and 65535, or empty, not "${f.local_port}"`;
    }
  };

  // Like the backend: no local port means the remote one if >= 1024, else 40000 + it.
  const run = (f: SavedForward): ForwardInfo => {
    cluster.forwards = cluster.forwards.filter((r) => r.saved_id !== f.id);
    const local = f.local_port === "" ? null : Number(f.local_port);
    const remotePort = /^\d+$/.test(f.remote) ? Number(f.remote) : 8080;
    const port = local ?? (remotePort >= 1024 ? remotePort : 40000 + remotePort);
    const localPort = port === 0 ? 45000 + s.sessionSeq : port;
    if (local !== null && cluster.forwards.some((r) => r.local_port === localPort)) {
      throw `local port ${localPort} is already in use: pick another one, or leave it empty for a free one`;
    }
    const target = f.target;
    const info: ForwardInfo = {
      id: `pf-${++s.sessionSeq}`,
      saved_id: f.id,
      target,
      remote: f.remote,
      remote_port: remotePort,
      local_port: localPort,
      url: `${f.https ? "https" : "http"}://127.0.0.1:${localPort}`,
      started_at: Date.now(),
      status: { pod: target.kind === "pod" ? target.name : `${target.name}-1`, connections: 0, total_connections: 0, last_error: "" },
    };
    cluster.forwards.push(info);
    return info;
  };
  const upsert = (f: SavedForward): SavedForward => {
    check(f);
    const list = saved();
    if (f.id === "") {
      const added = { ...f, id: `fwd-${Date.now()}-${++idSeq}` };
      store([...list, added]);
      return added;
    }
    if (!list.some((g) => g.id === f.id)) throw "this port-forward was deleted in the meantime";
    store(list.map((g) => (g.id === f.id ? f : g)));
    return f;
  };

  return {
    cmdPortforwardStart: (target, remote, local) => {
      const existing =
        local === null ? cluster.forwards.find((f) => sameTarget(f.target, target) && f.remote === remote) : undefined;
      if (existing) return existing;
      const localText = local === null ? "" : String(local);
      const known = saved().find((f) => sameTarget(f.target, target) && f.remote === remote && f.local_port === localText);
      if (known) return run(known);
      const added = upsert({
        id: "",
        target,
        remote,
        local_port: localText,
        https: false,
        open_in_browser: false,
        auto_start: false,
      });
      try {
        return run(added);
      } catch (e) {
        store(saved().filter((f) => f.id !== added.id));
        throw e;
      }
    },
    cmdPortforwardStop: (id) => {
      cluster.forwards = cluster.forwards.filter((f) => f.id !== id);
      return null;
    },
    // A copy, like real IPC: the app must see a new list after the tests change this one.
    cmdPortforwardList: () => copy(cluster.forwards),
    cmdPortforwardSaved: () => copy(saved()),
    cmdPortforwardSave: (forward) => upsert(forward),
    cmdPortforwardStartSaved: (id) => {
      const f = saved().find((g) => g.id === id);
      if (!f) throw "this port-forward was deleted in the meantime";
      return run(f);
    },
    cmdPortforwardDelete: (id) => {
      cluster.forwards = cluster.forwards.filter((f) => f.saved_id !== id);
      store(saved().filter((f) => f.id !== id));
      return null;
    },
    cmdPortforwardElsewhere: () => copy(cluster.forwardsElsewhere),
    cmdPortforwardAutostart: () => {
      const failed: { saved_id: string; error: string }[] = [];
      for (const f of saved()) {
        const runs = (id: string) => cluster.forwards.some((r) => r.saved_id === id) || cluster.forwardsElsewhere.includes(id);
        if (!f.auto_start || runs(f.id)) continue;
        try {
          run(f);
        } catch (e) {
          failed.push({ saved_id: f.id, error: String(e) });
        }
      }
      return failed;
    },
    cmdServicePorts: (namespace, name) => cluster.servicePorts[`${namespace}/${name}`] ?? [],
  } satisfies AreaHandlers;
}

// The Kubernetes version of each cluster, for the status bar (#387). The
// backend reads it once per connection (`cmd_server_version` keeps it in
// the session), so asking again on every switch is cheap and picks up a
// reconnect. A cluster that does not say shows nothing, never an error.

import { api } from "../cluster";

class Versions {
  /** `v1.31.2` by cluster id; missing: unknown (not asked yet, or it failed). */
  byId = $state.raw(new Map<string, string>());
}
export const versions = new Versions();

/** Ask cluster `id` for its version and keep the answer. */
export async function loadServerVersion(id: string): Promise<void> {
  if (!id) return;
  let v = "";
  try {
    v = await api(id).cmdServerVersion();
  } catch {
    // Unknown: shown as nothing.
  }
  if ((versions.byId.get(id) ?? "") === v) return;
  const next = new Map(versions.byId);
  if (v) next.set(id, v);
  else next.delete(id);
  versions.byId = next;
}

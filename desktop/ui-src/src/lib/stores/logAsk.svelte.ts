// A log tab asked for one container and run (#496): "Logs" and "Previous
// logs" in the pod panel's "Why it's failing" open the pod's log tab on the
// container that fails, and on its previous run. The tab takes the ask when
// it starts, and an open tab switches to it; either way the ask is used up,
// so a later tab of that pod (L, the row's Logs) starts as usual.

import { visibleCluster } from "../cluster";

export interface LogAsk {
  container: string;
  previous: boolean;
  /** Each ask is new, also when it asks the same again. */
  seq: number;
}

const asks = $state<Record<string, LogAsk>>({});
let seq = 0;

const key = (cluster: string, namespace: string, name: string) => `${cluster}\u0000${namespace}/${name}`;

/** Ask the pod's log tab (in the cluster shown) for `container` and run. */
export function askLogs(namespace: string, name: string, container: string, previous: boolean) {
  asks[key(visibleCluster(), namespace, name)] = { container, previous, seq: ++seq };
}

/** The newest ask for a pod's log tab, if any. */
export function logAsk(cluster: string, namespace: string, name: string): LogAsk | undefined {
  return asks[key(cluster, namespace, name)];
}

/** Use up the ask: the tab that read it applies it once. */
export function takeLogAsk(cluster: string, namespace: string, name: string): LogAsk | undefined {
  const k = key(cluster, namespace, name);
  const a = asks[k];
  if (a) delete asks[k];
  return a;
}

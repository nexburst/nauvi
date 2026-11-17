// Usage history (#47) of the fake cluster: what `cmd_usage_history` returns
// and the sparklines `cmd_get_metrics` sends.

import type { NodeDisk, SeriesView, Spark, UsageReference, UsageSample } from "../../lib/bindings";

/** One object's metrics-server history and reference lines. */
export interface UsageFixture {
  history: SeriesView;
  reference: UsageReference;
}

/** The fake cluster's Prometheus. */
export interface FakePrometheus {
  /** `namespace/service:port` as detected ("" = none found). */
  detected: string;
  /** Why none was found, when `detected` is "". */
  note: string;
  /** Make every query fail with this reason ("" = they work). */
  failure: string;
  /** Series by `pods|namespace/name|range`, `nodes|name|range`, `workloads|Kind|namespace/name|range` or `cluster|1h`. */
  series: Record<string, SeriesView>;
  /** Root filesystems node-exporter reports (`cmd_node_disk_usage`). */
  disks: NodeDisk[];
}

export const NO_PROMETHEUS: FakePrometheus = {
  detected: "",
  note: "No Prometheus Service found (looked for prometheus-k8s, kube-prometheus-stack-prometheus, prometheus-operated, prometheus-server and the label app.kubernetes.io/name=prometheus).",
  failure: "",
  series: {},
  disks: [],
};

const MI = 1024 * 1024;
const STEP_MS = 20_000;

export const NO_REFERENCE: UsageReference = {
  cpu_request: 0,
  cpu_limit: 0,
  memory_request: 0,
  memory_limit: 0,
  cpu_allocatable: 0,
  memory_allocatable: 0,
};

/** `n` samples 20 s apart ending now, from `cpu(i)` and `mem(i)`. */
function series(n: number, cpu: (i: number) => number, mem: (i: number) => number): UsageSample[] {
  const end = Date.now();
  return Array.from({ length: n }, (_, i) => ({
    t: end - (n - 1 - i) * STEP_MS,
    cpu_millicores: Math.round(cpu(i)),
    memory_bytes: Math.round(mem(i)),
  }));
}

function sum(a: UsageSample[], b: UsageSample[]): UsageSample[] {
  return a.map((s, i) => ({
    t: s.t,
    cpu_millicores: s.cpu_millicores + b[i].cpu_millicores,
    memory_bytes: s.memory_bytes + b[i].memory_bytes,
  }));
}

/** By `pods|namespace/name`, `nodes|name` or `workloads|Kind|namespace/name`; others have no history. */
export function usageFixtures(): Record<string, UsageFixture> {
  // web-1: memory climbing towards its 128Mi limit.
  const app = series(
    12,
    (i) => 80 + 10 * Math.sin(i),
    (i) => (40 + 5 * i) * MI,
  );
  const sidecar = series(
    12,
    () => 5,
    () => 8 * MI,
  );
  const web1 = sum(app, sidecar);
  const node = series(
    12,
    (i) => 700 + 20 * i,
    () => 2 * 1024 * MI,
  );
  return {
    "pods|demo/web-1": {
      history: {
        since: web1[0].t,
        samples: web1,
        containers: [
          { name: "app", samples: app },
          { name: "sidecar", samples: sidecar },
        ],
      },
      // The pod's requests and limits, from its spec: app has 100m/64Mi
      // requests and a 128Mi memory limit; the sidecar has none.
      reference: { ...NO_REFERENCE, cpu_request: 100, memory_request: 64 * MI },
    },
    // The Deployment demo/web: its pods web-1 and web-2, summed.
    "workloads|Deployment|demo/web": {
      history: { since: web1[0].t, samples: sum(web1, web1), containers: [] },
      reference: { ...NO_REFERENCE, cpu_request: 200, memory_request: 128 * MI, memory_limit: 256 * MI },
    },
    "nodes|node-1": {
      history: { since: node[0].t, samples: node, containers: [] },
      reference: {
        ...NO_REFERENCE,
        cpu_allocatable: 3800,
        memory_allocatable: 7 * 1024 * MI,
      },
    },
  };
}

/** Sparklines of the table rows that have history (keyed like the rows). */
export function sparkFixtures(): Record<string, Spark> {
  const u = usageFixtures();
  const spark = (s: UsageSample[]): Spark => ({
    cpu: s.map((x) => x.cpu_millicores),
    memory: s.map((x) => x.memory_bytes),
  });
  return {
    "demo/web-1": spark(u["pods|demo/web-1"].history.samples),
    "node-1": spark(u["nodes|node-1"].history.samples),
  };
}

/** A Prometheus with 1h series (120 points, 30 s apart) for demo/web-1 and node-1. */
export function prometheusFixture(): FakePrometheus {
  const at = (s: UsageSample[]) => s.map((x, i) => ({ ...x, t: Date.now() - (s.length - 1 - i) * 30_000 }));
  const app = at(
    series(
      120,
      (i) => 60 + (i % 10),
      (i) => (30 + i / 4) * MI,
    ),
  );
  const sidecar = at(
    series(
      120,
      () => 4,
      () => 6 * MI,
    ),
  );
  const node = at(
    series(
      120,
      (i) => 600 + i,
      () => 2 * 1024 * MI,
    ),
  );
  const total = sum(app, sidecar);
  return {
    detected: "monitoring/prometheus-k8s:web",
    disks: [{ name: "node-1", mountpoint: "/", used_bytes: 21.5 * 1024 ** 3, size_bytes: 50 * 1024 ** 3 }],
    note: "",
    failure: "",
    series: {
      "pods|demo/web-1|1h": {
        since: total[0].t,
        samples: total,
        containers: [
          { name: "app", samples: app },
          { name: "sidecar", samples: sidecar },
        ],
      },
      "nodes|node-1|1h": { since: node[0].t, samples: node, containers: [] },
      "workloads|Deployment|demo/web|1h": { since: total[0].t, samples: sum(total, total), containers: [] },
      // The overview's chart (#328): the nodes summed.
      "cluster|1h": { since: node[0].t, samples: sum(node, node), containers: [] },
    },
  };
}

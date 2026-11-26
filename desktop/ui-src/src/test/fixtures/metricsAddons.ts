// One-click metrics (#225): the add-ons `cmd_metrics_addons` lists (as in
// src/helm/addons.rs) and what the fake install does.

import type { HelmDeployResult, MetricsAddon, MetricsAddonRequest } from "../../lib/bindings";

export interface FakeMetricsAddons {
  /** Add-on ids `cmd_metrics_addon_access` refuses, with the reason. */
  denied: Record<string, string>;
  /** Every install (not dry runs), oldest first. */
  installed: MetricsAddonRequest[];
  /** Make the next dry runs and installs fail with this ("" = they work). */
  failure: string;
}

export function noAddons(): FakeMetricsAddons {
  return { denied: {}, installed: [], failure: "" };
}

export const ADDONS: MetricsAddon[] = [
  {
    id: "metrics-server",
    title: "metrics-server",
    summary:
      "Live CPU and memory of pods and nodes: the usage columns, the overview's usage bars and kubectl top.",
    components: ["metrics-server (a Deployment and the metrics.k8s.io API)"],
    repo_url: "https://kubernetes-sigs.github.io/metrics-server/",
    chart: "metrics-server",
    version: "3.14.0",
    app_version: "0.9.0",
    release: "metrics-server",
    namespace: "kube-system",
    values:
      "# Changes to the chart's defaults; everything else is as the chart sets it.\nreplicas: 1\nresources:\n  requests:\n    cpu: 100m\n    memory: 200Mi\n",
    options: [
      {
        id: "kubelet-insecure-tls",
        label: "Skip kubelet TLS verification (--kubelet-insecure-tls)",
        detail:
          "Needed on kind, minikube and other clusters whose kubelets have self-signed certificates. metrics-server then trusts any kubelet certificate; leave it off on other clusters.",
        arg: "--kubelet-insecure-tls",
      },
    ],
  },
  {
    id: "prometheus",
    title: "Prometheus",
    summary: "Usage history (1h, 6h, 24h) in the charts and a Disk column on Nodes.",
    components: ["Prometheus server", "kube-state-metrics", "node-exporter (a DaemonSet on every node)"],
    repo_url: "https://prometheus-community.github.io/helm-charts",
    chart: "prometheus",
    version: "29.47.2",
    app_version: "v3.16.0",
    release: "prometheus",
    namespace: "monitoring",
    values:
      "# A small Prometheus: the server, kube-state-metrics and node-exporter.\nalertmanager:\n  enabled: false\nprometheus-pushgateway:\n  enabled: false\nserver:\n  retention: 7d\n",
    options: [],
  },
];

/** Like `install_metrics_addon`: a dry run renders, an install records the request. */
export function installAddon(fake: FakeMetricsAddons, req: MetricsAddonRequest): HelmDeployResult {
  const addon = ADDONS.find((a) => a.id === req.addon);
  if (!addon) throw `unknown add-on ${req.addon}`;
  const verb = req.dry_run ? "Dry run of the install" : "Install";
  if (fake.failure) throw `${verb} of ${req.name} failed: ${fake.failure}`;
  if (/^\s*[-[]/.test(req.values)) throw "The values must be a YAML mapping (key: value), not a single value or a list";
  const args = req.options.map((o) => addon.options.find((x) => x.id === o)?.arg ?? o);
  const what = `${req.namespace}/${req.name}`;
  const manifest =
    `---\napiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: ${req.name}\n  namespace: ${req.namespace}\n` +
    `spec:\n  template:\n    spec:\n      containers:\n        - name: ${addon.chart}\n          args:\n` +
    ["--cert-dir=/tmp", ...args].map((a) => `            - ${a}\n`).join("") +
    `---\napiVersion: rbac.authorization.k8s.io/v1\nkind: ClusterRole\nmetadata:\n  name: system:${req.name}\n`;
  const result: HelmDeployResult = {
    name: req.name,
    namespace: req.namespace,
    revision: 1,
    status: req.dry_run ? "pending-install" : "deployed",
    chart: addon.chart,
    chart_version: addon.version,
    app_version: addon.app_version,
    notes: `${addon.title} is installed.\n`,
    manifest,
    previous_manifest: "",
    secrets_hidden: !req.reveal,
    resources: [],
    dry_run: req.dry_run,
    summary: req.dry_run ? "Dry run: 2 objects would be created. Nothing has been applied yet" : `Installed ${what} (revision 1)`,
  };
  if (!req.dry_run) fake.installed.push(structuredClone(req));
  return result;
}

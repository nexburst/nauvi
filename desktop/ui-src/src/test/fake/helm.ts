// Helm releases (`commands/helm.rs`).

import { helmGet, helmList, helmRollback, helmUninstall } from "../fixtures/helm";
import type { AreaHandlers, FakeState } from "./state";

export function helmHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    cmdHelmList: (namespaces) => helmList(cluster.helm, namespaces),
    cmdHelmCharts: (keys) =>
      keys.map((k) => {
        try {
          const r = helmGet(cluster.helm, k.namespace, k.name, k.revision, false);
          const { chart, chart_version, app_version } = r;
          return { ...k, chart, chart_version, app_version, error: "" };
        } catch (e) {
          return { ...k, chart: "", chart_version: "", app_version: "", error: String(e) };
        }
      }),
    cmdHelmGet: (namespace, name, revision, reveal) => helmGet(cluster.helm, namespace, name, revision, reveal),
    cmdHelmVersion: () => {
      if (!cluster.helm.version) {
        throw "helm is not installed or not on PATH. Install it (https://helm.sh/docs/intro/install/) to install, upgrade, roll back or uninstall releases and to browse charts.";
      }
      return cluster.helm.version;
    },
    cmdHelmRollback: (namespace, name, revision) => helmRollback(cluster.helm, namespace, name, revision),
    cmdHelmUninstall: (namespace, name) => helmUninstall(cluster.helm, namespace, name),
  } satisfies AreaHandlers;
}

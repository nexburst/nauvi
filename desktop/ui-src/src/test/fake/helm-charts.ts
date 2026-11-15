// Helm repositories, chart search, install and upgrade (`commands/helm_charts.rs`).

import { chartVersions, deploy, repoAdd, repoRemove, repoUpdate, search, show } from "../fixtures/helmCharts";
import { copy } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function helmChartsHandlers(s: FakeState) {
  const { cluster } = s;
  /** The namespaces that exist, for installs (`--create-namespace`). */
  const namespaceNames = () => [
    ...(cluster.namespaces ?? []).map((n) => n.name),
    ...cluster.helm.revisions.map((r) => r.namespace),
  ];
  return {
    cmdHelmRepoList: () => copy(cluster.helm.charts.repos),
    cmdHelmRepoAdd: (name, url) => repoAdd(cluster.helm.charts, name.trim(), url.trim()),
    cmdHelmRepoRemove: (name) => repoRemove(cluster.helm.charts, name),
    cmdHelmRepoUpdate: (names) => repoUpdate(cluster.helm.charts, names),
    cmdHelmSearch: (query, allVersions) => search(cluster.helm.charts, query, allVersions),
    cmdHelmChartVersions: (chart) => chartVersions(cluster.helm.charts, chart),
    cmdHelmChartShow: (chart, version) => show(cluster.helm.charts, chart, version),
    cmdHelmInstall: (request) => deploy(cluster.helm, namespaceNames(), "install", request),
    cmdHelmUpgrade: (request) => deploy(cluster.helm, namespaceNames(), "upgrade", request),
  } satisfies AreaHandlers;
}

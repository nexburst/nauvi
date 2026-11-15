// Pure helpers for Helm charts (#80): the charts view, the repositories
// and the install/upgrade dialog.

import type { HelmChartVersion, HelmDeployRequest } from "./bindings";

/** `app.view` of the Helm charts view. */
export const HELM_CHARTS_VIEW = "helm-charts";

/** The repository of `repo/chart` (empty for a bare name). */
export function repoOf(chart: string): string {
  const i = chart.indexOf("/");
  return i < 0 ? "" : chart.slice(0, i);
}

/** The chart name without its repository. */
export function bareName(chart: string): string {
  return chart.slice(chart.lastIndexOf("/") + 1);
}

/** Charts whose name, description or app version contain the search text, sorted by name. */
export function filterCharts(charts: readonly HelmChartVersion[], search: string): HelmChartVersion[] {
  const q = search.trim().toLowerCase();
  const out = q
    ? charts.filter((c) => `${c.name} ${c.description} ${c.app_version}`.toLowerCase().includes(q))
    : [...charts];
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Why `name` is not a valid Helm release name; empty if it is. Mirrors the backend's check. */
export function releaseNameError(name: string): string {
  if (!name) return "Enter a release name.";
  if (name.length > 53) return "A release name has at most 53 characters.";
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) {
    return "Use lowercase letters, digits, '-' and '.', starting with a letter or digit.";
  }
  return "";
}

/** Why `ns` is not a valid namespace name; empty if it is. */
export function namespaceError(ns: string): string {
  if (!ns) return "Enter a namespace.";
  if (ns.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(ns)) {
    return "A namespace is lowercase letters, digits and '-', starting and ending with a letter or digit.";
  }
  return "";
}

/** A release name to start from: the chart's name, made valid. */
export function defaultReleaseName(chart: string): string {
  const name = bareName(chart)
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 53);
  return name || "release";
}

/** Versions grouped by `repo/chart`, in the order found (newest first within each). */
export function chartSources(versions: readonly HelmChartVersion[]): Map<string, HelmChartVersion[]> {
  const out = new Map<string, HelmChartVersion[]>();
  for (const v of versions) out.set(v.name, [...(out.get(v.name) ?? []), v]);
  return out;
}

/** `preferred` if it is one of `versions`, else the first (newest); empty when there are none. */
export function pickVersion(versions: readonly HelmChartVersion[], preferred: string): string {
  if (preferred && versions.some((v) => v.version === preferred)) return preferred;
  return versions[0]?.version ?? "";
}

/**
 * The values text after the chart's defaults change (another version):
 * the new defaults if the text was still the old defaults, else the
 * user's edits, kept.
 */
export function nextValues(current: string, oldDefaults: string, newDefaults: string): string {
  return current === oldDefaults ? newDefaults : current;
}

/** Whether two requests deploy the same thing (a preview is still valid). */
export function sameDeploy(a: HelmDeployRequest | null, b: HelmDeployRequest | null): boolean {
  if (!a || !b) return false;
  return (
    a.name === b.name &&
    a.namespace === b.namespace &&
    a.chart === b.chart &&
    a.version === b.version &&
    a.values === b.values &&
    a.create_namespace === b.create_namespace &&
    a.reveal === b.reveal &&
    a.storage === b.storage
  );
}

/** What to say when a release's chart is in no configured repository. */
export function notInRepos(chart: string): string {
  return `Chart ${chart} is not in any configured repository. Add the repository it came from (Helm → Charts, or Settings), then try again.`;
}

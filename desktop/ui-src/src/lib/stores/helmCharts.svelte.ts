// State of Helm charts (#80): the configured repositories, the charts in
// them, the selected chart, and the install/upgrade dialog.

import { commands } from "../bindings";

import { api, visibleCluster } from "../cluster";
import type { HelmChartVersion, HelmDeployRequest, HelmDeployResult, HelmRepo, HelmStorage } from "../bindings";
import { setNotice } from "./actions.svelte";

class ChartsStore {
  repos = $state.raw<HelmRepo[]>([]);
  reposLoaded = $state(false);
  reposError = $state("");
  /** Newest version of every chart in every repository. */
  charts = $state.raw<HelmChartVersion[]>([]);
  chartsLoaded = $state(false);
  chartsError = $state("");
  /** `repo/chart` of the chart whose details are open. */
  selected = $state<string | null>(null);
  /** A repository change or update is running. */
  repoBusy = $state(false);
  /** Repositories that could not be updated (or why the last change failed). */
  repoWarnings = $state.raw<string[]>([]);
  /** The open install/upgrade dialog. */
  deploy = $state.raw<DeployTarget | null>(null);
}
export const charts = new ChartsStore();

/** What the install/upgrade dialog works on. */
export type DeployTarget =
  | { mode: "install"; chart: string; version: string; namespace: string }
  | {
      mode: "upgrade";
      /** The chart name the release records (no repository). */
      chart: string;
      /** The release's chart version. */
      version: string;
      namespace: string;
      name: string;
      /** The release's user values. */
      values: string;
      /** Where the release is stored. */
      storage: HelmStorage;
    };

let chartsGen = 0;

/** Read the repositories, then every chart in them. */
export async function loadCharts() {
  const gen = ++chartsGen;
  try {
    const repos = await commands.cmdHelmRepoList();
    if (gen !== chartsGen) return;
    charts.repos = repos;
    charts.reposError = "";
  } catch (e) {
    if (gen !== chartsGen) return;
    charts.repos = [];
    charts.reposError = String(e);
  }
  charts.reposLoaded = true;
  if (charts.repos.length === 0) {
    charts.charts = [];
    charts.chartsError = "";
    charts.chartsLoaded = true;
    return;
  }
  try {
    const list = await commands.cmdHelmSearch("", false);
    if (gen !== chartsGen) return;
    charts.charts = list;
    charts.chartsError = "";
  } catch (e) {
    if (gen !== chartsGen) return;
    charts.charts = [];
    charts.chartsError = String(e);
  }
  charts.chartsLoaded = true;
  if (charts.selected && !charts.charts.some((c) => c.name === charts.selected)) charts.selected = null;
}

export function selectChart(name: string | null) {
  charts.selected = name;
}

async function repoChange(run: () => Promise<string>): Promise<boolean> {
  if (charts.repoBusy) return false;
  charts.repoBusy = true;
  charts.repoWarnings = [];
  try {
    setNotice(true, await run());
    return true;
  } catch (e) {
    charts.repoWarnings = [String(e)];
    return false;
  } finally {
    charts.repoBusy = false;
    await loadCharts();
  }
}

/** `helm repo add`; true when it was added. */
export function addRepo(name: string, url: string): Promise<boolean> {
  return repoChange(() => commands.cmdHelmRepoAdd(name, url));
}

export function removeRepo(name: string): Promise<boolean> {
  return repoChange(() => commands.cmdHelmRepoRemove(name));
}

/** `helm repo update` (empty: all); unreachable repositories become warnings. */
export async function updateRepos(names: string[] = []): Promise<boolean> {
  if (charts.repoBusy) return false;
  charts.repoBusy = true;
  charts.repoWarnings = [];
  try {
    const r = await commands.cmdHelmRepoUpdate(names);
    charts.repoWarnings = r.failed;
    if (r.updated.length > 0) {
      setNotice(true, `Updated ${r.updated.length === 1 ? "repository" : "repositories"} ${r.updated.join(", ")}`);
    }
    return r.failed.length === 0;
  } catch (e) {
    charts.repoWarnings = [String(e)];
    return false;
  } finally {
    charts.repoBusy = false;
    await loadCharts();
  }
}

export function openDeploy(target: DeployTarget) {
  charts.deploy = target;
}

export function closeDeploy() {
  charts.deploy = null;
}

/** Run an install or upgrade (or its dry run). */
export function runDeploy(mode: "install" | "upgrade", request: HelmDeployRequest): Promise<HelmDeployResult> {
  return mode === "install" ? api(visibleCluster()).cmdHelmInstall(request) : api(visibleCluster()).cmdHelmUpgrade(request);
}

/**
 * What `App.svelte` shows besides the resource tables: the views, side
 * panels, banners and dialogs of each area, and what starts with the app.
 *
 * Every list here is append-only, one entry per line with a trailing comma,
 * so branches that add different features do not touch the same lines of
 * `App.svelte`. Add a new entry at the end of its list (the order of the
 * banners, side panels and dialogs is their order on the page).
 */

import type { Component } from "svelte";
import { CATALOG_VIEW } from "./catalog";
import { PORT_FORWARDS_VIEW } from "./forwards";
import { HELM_VIEW } from "./helm";
import { HELM_CHARTS_VIEW } from "./helmCharts";
import { WORKLOADS_VIEW } from "./workloads";
import { app } from "./stores/app.svelte";
import { listenDrain } from "./stores/actions.svelte";
import { catalog, listenKubeconfigs } from "./stores/catalog.svelte";
import { createUi } from "./stores/create.svelte";
import { checkLeftovers } from "./stores/debug.svelte";
import { helm } from "./stores/helm.svelte";
import { charts } from "./stores/helmCharts.svelte";
import { keyboard, listenMouseButtons } from "./stores/keyboard.svelte";
import { live } from "./stores/live.svelte";
import { metricsInstall } from "./stores/metricsInstall.svelte";
import { trackHistory } from "./stores/navigation.svelte";
import { listenUpdates, startupCheck } from "./stores/updates.svelte";
import ActionDialog from "./components/ActionDialog.svelte";
import ActionNotice from "./components/ActionNotice.svelte";
import CatalogView from "./components/catalog/CatalogView.svelte";
import ClusterSettings from "./components/catalog/ClusterSettings.svelte";
import CommandPalette from "./components/CommandPalette.svelte";
import CreateDialog from "./components/CreateDialog.svelte";
import ErrorBanner from "./components/ErrorBanner.svelte";
import HelmChartDetail from "./components/helm/HelmChartDetail.svelte";
import HelmChartsView from "./components/helm/HelmChartsView.svelte";
import HelmConfirm from "./components/helm/HelmConfirm.svelte";
import HelmDeployDialog from "./components/helm/HelmDeployDialog.svelte";
import HelmDetail from "./components/helm/HelmDetail.svelte";
import HelmView from "./components/helm/HelmView.svelte";
import MetricsInstallDialog from "./components/helm/MetricsInstallDialog.svelte";
import NodeShellLeftovers from "./components/NodeShellLeftovers.svelte";
import Overview from "./components/Overview.svelte";
import PortForwards from "./components/PortForwards.svelte";
import SettingsDialog from "./components/SettingsDialog.svelte";
import ShortcutHelp from "./components/ShortcutHelp.svelte";
import UnsavedDialog from "./components/UnsavedDialog.svelte";
import UpdateBanner from "./components/UpdateBanner.svelte";
import WorkloadsOverview from "./components/WorkloadsOverview.svelte";

/** A view of its own (not a resource table), shown when `app.view` is `id`. */
export interface View {
  id: string;
  component: Component<any>;
  /** Whether the table toolbar (namespaces, filter) shows above it. */
  toolbar: boolean;
}

/** A component shown while `when()` holds, recreated when `key()` changes. */
export interface Slot {
  component: Component<any>;
  props: () => Record<string, unknown>;
  when: () => boolean;
  key: () => unknown;
}

interface Options<P> {
  when?: () => boolean;
  key?: () => unknown;
  props?: () => P;
}

/** A `Slot`, with its props type-checked against the component. */
function slot<P extends Record<string, any>>(component: Component<P>, opts: Options<P> = {}): Slot {
  return {
    component,
    props: (opts.props ?? (() => ({}))) as () => Record<string, unknown>,
    when: opts.when ?? (() => true),
    key: opts.key ?? (() => undefined),
  };
}

export const VIEWS: View[] = [
  { id: CATALOG_VIEW, component: CatalogView, toolbar: false },
  { id: "overview", component: Overview, toolbar: false },
  { id: HELM_VIEW, component: HelmView, toolbar: true },
  { id: HELM_CHARTS_VIEW, component: HelmChartsView, toolbar: true },
  { id: WORKLOADS_VIEW, component: WorkloadsOverview, toolbar: true },
  { id: PORT_FORWARDS_VIEW, component: PortForwards, toolbar: false },
];

/** Above the view. */
export const BANNERS: Slot[] = [
  slot(ErrorBanner),
  slot(ActionNotice),
  slot(UpdateBanner),
  slot(NodeShellLeftovers),
];

/** Right of the view, after the resource detail panel. */
export const SIDE_PANELS: Slot[] = [
  slot(HelmDetail, {
    when: () => app.view === HELM_VIEW && !!helm.selected,
    key: () => `${helm.selected?.namespace}/${helm.selected?.name}`,
    props: () => ({ target: helm.selected! }),
  }),
  slot(HelmChartDetail, {
    when: () => app.view === HELM_CHARTS_VIEW && !!charts.selected,
    key: () => charts.selected,
    props: () => ({ chart: charts.selected! }),
  }),
];

/** Dialogs and overlays, after the dock and the footer. */
export const DIALOGS: Slot[] = [
  slot(ActionDialog),
  slot(HelmConfirm),
  slot(HelmDeployDialog, { when: () => !!charts.deploy, key: () => charts.deploy, props: () => ({ target: charts.deploy! }) }),
  slot(CreateDialog, { when: () => createUi.open }),
  slot(UnsavedDialog),
  slot(CommandPalette, { when: () => keyboard.palette }),
  slot(ShortcutHelp, { when: () => keyboard.help }),
  slot(SettingsDialog, { when: () => keyboard.settings }),
  slot(ClusterSettings, {
    when: () => catalog.settingsFor !== null,
    key: () => catalog.settingsFor,
    props: () => ({ id: catalog.settingsFor! }),
  }),
  slot(MetricsInstallDialog, {
    when: () => metricsInstall.addon !== null,
    key: () => metricsInstall.addon,
    props: () => ({ id: metricsInstall.addon! }),
  }),
];

/** Event subscriptions, made before the first watch starts; each returns its unlisten. */
export const LISTENERS: (() => Promise<() => void>)[] = [
  () => live.listen(),
  listenDrain,
  listenUpdates,
  listenKubeconfigs,
  listenMouseButtons,
  // Back/forward (#223): records each place the window shows.
  async () => trackHistory(),
];

/** Started once the app has its settings and context (`startApp`). */
export const AFTER_START: (() => Promise<void>)[] = [
  checkLeftovers,
  // The update check waits for the settings (its on/off switch).
  startupCheck,
];

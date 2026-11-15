<script lang="ts">
  import { onMount, untrack } from "svelte";
  import Header from "./lib/components/Header.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import ErrorBanner from "./lib/components/ErrorBanner.svelte";
  import ActionDialog from "./lib/components/ActionDialog.svelte";
  import ActionNotice from "./lib/components/ActionNotice.svelte";
  import UpdateBanner from "./lib/components/UpdateBanner.svelte";
  import { listenUpdates, startupCheck } from "./lib/stores/updates.svelte";
  import NodeShellLeftovers from "./lib/components/NodeShellLeftovers.svelte";
  import { checkLeftovers } from "./lib/stores/debug.svelte";
  import UnsavedDialog from "./lib/components/UnsavedDialog.svelte";
  import CreateDialog from "./lib/components/CreateDialog.svelte";
  import { createUi } from "./lib/stores/create.svelte";
  import Footer from "./lib/components/Footer.svelte";
  import Toolbar from "./lib/components/Toolbar.svelte";
  import Overview from "./lib/components/Overview.svelte";
  import TableView from "./lib/components/TableView.svelte";
  import DetailPanel from "./lib/components/DetailPanel.svelte";
  import GenericDetail from "./lib/components/GenericDetail.svelte";
  import PortForwards from "./lib/components/PortForwards.svelte";
  import { PORT_FORWARDS_VIEW } from "./lib/forwards";
  import Dock from "./lib/components/Dock.svelte";
  import HelmView from "./lib/components/helm/HelmView.svelte";
  import HelmDetail from "./lib/components/helm/HelmDetail.svelte";
  import HelmConfirm from "./lib/components/helm/HelmConfirm.svelte";
  import { helm } from "./lib/stores/helm.svelte";
  import { HELM_VIEW } from "./lib/helm";
  import { CATALOG_VIEW } from "./lib/catalog";
  import CatalogView from "./lib/components/catalog/CatalogView.svelte";
  import ClusterSettings from "./lib/components/catalog/ClusterSettings.svelte";
  import { catalog, listenKubeconfigs } from "./lib/stores/catalog.svelte";
  import WorkloadsOverview from "./lib/components/WorkloadsOverview.svelte";
  import { WORKLOADS_VIEW } from "./lib/workloads";
  import { dock } from "./lib/stores/dock.svelte";
  import { isPod } from "./lib/columns";
  import {
    app,
    checkAccess,
    currentKind,
    loadKinds,
    startApp,
  } from "./lib/stores/app.svelte";
  import { detail } from "./lib/stores/detail.svelte";
  import { listenDrain } from "./lib/stores/actions.svelte";
  import { live } from "./lib/stores/live.svelte";
  import { handleKey, keyboard } from "./lib/stores/keyboard.svelte";
  import CommandPalette from "./lib/components/CommandPalette.svelte";
  import ShortcutHelp from "./lib/components/ShortcutHelp.svelte";
  import SettingsDialog from "./lib/components/SettingsDialog.svelte";
  import PanelResizer from "./lib/components/PanelResizer.svelte";

  onMount(() => {
    // Subscribe before the first watch starts; events that still race ahead
    // of cmd_watch_start's reply are buffered by the live store.
    const unlisten = live.listen();
    const unlistenDrain = listenDrain();
    const unlistenUpdates = listenUpdates();
    const unlistenKubeconfigs = listenKubeconfigs();
    // The update check waits for the settings (its on/off switch).
    void startApp().then(() => {
      void checkLeftovers();
      void startupCheck();
    });
    return () => {
      unlisten.then((un) => un());
      unlistenDrain.then((un) => un());
      unlistenUpdates.then((un) => un());
      unlistenKubeconfigs.then((un) => un());
    };
  });

  // Discover what the cluster serves once the remembered context is
  // restored, on Refresh and on a context switch (all bump the nonce).
  $effect(() => {
    void app.refreshNonce;
    if (app.ready) untrack(loadKinds);
  });

  // Access depends on the scope: re-check when the namespace changes.
  $effect(() => {
    void app.selectedNamespaces;
    untrack(checkAccess);
  });

  const kind = $derived(currentKind());
</script>

<!-- Capture phase: shortcuts see the state before a menu or dialog reacts. -->
<svelte:window onkeydowncapture={handleKey} />

<Header />
<div class="main" class:hidden={dock.maximized}>
  <Sidebar />
  <section class="content">
    {#if app.view !== "overview" && app.view !== PORT_FORWARDS_VIEW && app.view !== CATALOG_VIEW}
      <Toolbar />
    {/if}
    <ErrorBanner />
    <ActionNotice />
    <UpdateBanner />
    <NodeShellLeftovers />
    {#if !app.ready}
      <!-- Restoring the remembered context and namespaces. -->
    {:else if app.view === CATALOG_VIEW}
      <CatalogView />
    {:else if app.view === "overview"}
      <Overview />
    {:else if app.view === HELM_VIEW}
      <HelmView />
    {:else if app.view === WORKLOADS_VIEW}
      <WorkloadsOverview />
    {:else if app.view === PORT_FORWARDS_VIEW}
      <PortForwards />
    {:else if kind}
      {#key kind.id}
        <TableView {kind} />
      {/key}
    {/if}
  </section>
  {#if detail.target && kind && detail.target.resource.kind === kind.resource.kind &&
    detail.target.resource.group === kind.resource.group}
    <PanelResizer />
    {#key detail.nonce}
      {#if isPod(kind)}
        <DetailPanel target={detail.target} />
      {:else}
        <GenericDetail target={detail.target} />
      {/if}
    {/key}
  {/if}
  {#if app.view === HELM_VIEW && helm.selected}
    {#key `${helm.selected.namespace}/${helm.selected.name}`}
      <HelmDetail target={helm.selected} />
    {/key}
  {/if}
</div>
<Dock />
<Footer />
<ActionDialog />
<HelmConfirm />
{#if createUi.open}
  <CreateDialog />
{/if}
<UnsavedDialog />
{#if keyboard.palette}
  <CommandPalette />
{/if}
{#if keyboard.help}
  <ShortcutHelp />
{/if}
{#if keyboard.settings}
  <SettingsDialog />
{/if}
{#if catalog.settingsFor !== null}
  {#key catalog.settingsFor}
    <ClusterSettings id={catalog.settingsFor} />
  {/key}
{/if}

<style>
  .main {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  /* A maximized dock covers the tables; they stay mounted. */
  .main.hidden {
    display: none;
  }
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
</style>

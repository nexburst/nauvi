<script lang="ts">
  import { onMount, untrack } from "svelte";
  import Header from "./lib/components/Header.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import Footer from "./lib/components/Footer.svelte";
  import Toolbar from "./lib/components/Toolbar.svelte";
  import TableView from "./lib/components/TableView.svelte";
  import DetailPanel from "./lib/components/DetailPanel.svelte";
  import GenericDetail from "./lib/components/GenericDetail.svelte";
  import Dock from "./lib/components/Dock.svelte";
  import PanelResizer from "./lib/components/PanelResizer.svelte";
  import Boundary from "./lib/components/Boundary.svelte";
  import { dock } from "./lib/stores/dock.svelte";
  import { isPod } from "./lib/columns";
  import { app, checkAccess, currentKind, loadKinds, startApp } from "./lib/stores/app.svelte";
  import { detail } from "./lib/stores/detail.svelte";
  import { handleKey } from "./lib/stores/keyboard.svelte";
  // The views, banners, side panels and dialogs of each area: add new ones
  // there, not here.
  import { AFTER_START, BANNERS, DIALOGS, LISTENERS, SIDE_PANELS, VIEWS } from "./lib/registry";

  onMount(() => {
    // Subscribe before the first watch starts; events that still race ahead
    // of cmd_watch_start's reply are buffered by the live store.
    const unlisteners = LISTENERS.map((listen) => listen());
    void startApp().then(() => {
      for (const start of AFTER_START) void start();
    });
    return () => {
      for (const un of unlisteners) un.then((f) => f());
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
  const view = $derived(VIEWS.find((v) => v.id === app.view));
</script>

<!-- Capture phase: shortcuts see the state before a menu or dialog reacts. -->
<svelte:window onkeydowncapture={handleKey} />

<Header />
<div class="main" class:hidden={dock.maximized}>
  <Sidebar />
  <section class="content">
    {#if view?.toolbar ?? true}
      <Toolbar />
    {/if}
    {#each BANNERS as b, i (i)}
      {#if b.when()}
        <b.component {...b.props()} />
      {/if}
    {/each}
    <!-- A render error shows here and goes to the app log (#208). -->
    <Boundary area="view">
      {#if !app.ready}
        <!-- Restoring the remembered context and namespaces. -->
      {:else if view}
        <view.component />
      {:else if kind}
        {#key kind.id}
          <TableView {kind} />
        {/key}
      {/if}
    </Boundary>
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
  {#each SIDE_PANELS as p, i (i)}
    {#if p.when()}
      {#key p.key()}
        <p.component {...p.props()} />
      {/key}
    {/if}
  {/each}
</div>
<Dock />
<Footer />
{#each DIALOGS as d, i (i)}
  {#if d.when()}
    {#key d.key()}
      <d.component {...d.props()} />
    {/key}
  {/if}
{/each}

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

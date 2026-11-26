<script lang="ts">
  import { onMount, untrack } from "svelte";
  import Header from "./lib/components/Header.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import Berths from "./lib/components/Berths.svelte";
  import { chart, closeChart } from "./lib/stores/chart.svelte";
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

  // The drawer of kinds goes away once a view is chosen; with no object
  // open, the sheet is the table again.
  $effect(() => {
    void app.view;
    untrack(closeChart);
  });
  $effect(() => {
    if (!detail.target) chart.wide = false;
  });

  const kind = $derived(currentKind());
  const view = $derived(VIEWS.find((v) => v.id === app.view));
</script>

<!-- Capture phase: shortcuts see the state before a menu or dialog reacts. -->
<svelte:window onkeydowncapture={handleKey} />

<Header />
<div class="main" class:hidden={dock.maximized}>
  <Berths />
  <div class="stage" class:wide={chart.wide}>
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
    <div class="view" class:stale={app.status.ok === false}>
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
    </div>
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
  {#if detail.target && kind}
    <button
      type="button"
      class="widen"
      aria-pressed={chart.wide}
      aria-label={chart.wide ? "Show the table again" : "Give the object the whole sheet"}
      title={chart.wide ? "Show the table again (W)" : "Give the object the whole sheet (W)"}
      data-testid="widen"
      onclick={() => (chart.wide = !chart.wide)}
    >
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        {#if chart.wide}
          <path d="M2 3h12v10H2zM10 3v10" />
        {:else}
          <path d="M2 3h12v10H2zM6 8h6M9 5.5L6 8l3 2.5" />
        {/if}
      </svg>
    </button>
  {/if}
  {#each SIDE_PANELS as p, i (i)}
    {#if p.when()}
      {#key p.key()}
        <p.component {...p.props()} />
      {/key}
    {/if}
  {/each}
  </div>
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
  /* The sheet and its panels; the summoned chart unrolls over it. */
  .stage {
    position: relative;
    flex: 1;
    display: flex;
    min-width: 0;
    min-height: 0;
  }
  /* The object takes the whole sheet; the table waits in its spine. */
  .stage.wide > .content {
    display: none;
  }
  /* Lines stay readable: the object's ledger is at most 920px wide. */
  .stage.wide > :global(aside[data-testid="detail-panel"]) {
    flex: 1;
    width: auto !important;
    max-width: none !important;
  }
  .stage.wide > :global(aside[data-testid="detail-panel"] > :not(.top, .tabs)) {
    max-width: 980px;
  }
  /* The editor wants all of it, its heading row too. */
  .stage.wide > :global(aside[data-testid="detail-panel"]:has(.cm-editor) > *) {
    max-width: none;
  }
  /* Beside the panel's close mark: the object takes the sheet, or gives
     it back. */
  .widen {
    position: absolute;
    top: 8px;
    right: 44px;
    z-index: 6;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--text-muted);
    cursor: pointer;
  }
  .widen:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .widen svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.3;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* What is on screen may be out of date while the connection is down: it
     steps back, and comes forward again when the cluster answers. */
  .view {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    transition: opacity 300ms ease;
  }
  /* Not when it shows only the out-of-reach state (#462) or the welcome
     screen (#485): nothing in it is stale, and it is what to read while
     the cluster is down. */
  .view.stale:not(:has(:global([data-testid="out-of-reach"], [data-testid="welcome"]))) {
    opacity: 0.55;
  }
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
</style>

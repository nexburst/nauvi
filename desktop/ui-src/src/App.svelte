<script lang="ts">
  import { onMount, untrack } from "svelte";
  import Header from "./lib/components/Header.svelte";
  import Sidebar from "./lib/components/Sidebar.svelte";
  import Spines from "./lib/components/Spines.svelte";
  import { chart, clearTrail, visitObject, visitView } from "./lib/stores/chart.svelte";
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
  import { app, checkAccess, currentContextName, currentKind, loadKinds, startApp } from "./lib/stores/app.svelte";
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

  // The wake (the spines) is of one cluster: a new one starts on a switch.
  const context = $derived(currentContextName());
  $effect(() => {
    void context;
    untrack(clearTrail);
  });
  // Every view shown joins the wake.
  $effect(() => {
    const view = app.view;
    void context;
    if (app.ready) untrack(() => visitView(view));
  });

  // So does every object opened; with none open, the sheet is the table again.
  $effect(() => {
    const t = detail.target;
    if (!t) chart.wide = false;
    else if (app.ready) untrack(() => visitObject(app.view, t.namespace, t.name));
  });

  const kind = $derived(currentKind());
  const view = $derived(VIEWS.find((v) => v.id === app.view));
</script>

<!-- Capture phase: shortcuts see the state before a menu or dialog reacts. -->
<svelte:window onkeydowncapture={handleKey} />

<Header />
<div class="main" class:hidden={dock.maximized}>
  <Spines />
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
    <button
      type="button"
      class="fold"
      aria-pressed={chart.wide}
      aria-label={chart.wide ? "Bring the table back" : "Give the object the whole sheet"}
      title={chart.wide ? "Bring the table back" : "Give the object the whole sheet: the table folds into its spine"}
      data-testid="fold-table"
      onclick={() => (chart.wide = !chart.wide)}
    >
      <svg viewBox="0 0 8 16" width="8" height="16" aria-hidden="true"><path d="M6 3L2 8l4 5" /></svg>
      <span class="fold-label">{chart.wide ? "Show table" : "Fold table"}</span>
    </button>
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
    padding-right: max(0px, calc(100% - 920px - 46px));
  }
  .fold {
    flex-shrink: 0;
    width: 18px;
    padding: 14px 0 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    background: var(--bg-sunken);
    border: none;
    border-left: 1px solid var(--border);
    color: var(--text-muted);
    cursor: pointer;
    transition:
      background-color 140ms ease,
      color 140ms ease;
  }
  .fold:hover {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .fold svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
    transition: transform 220ms var(--ease-out);
  }
  .stage.wide > .fold svg {
    transform: rotate(180deg);
  }
  .fold-label {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-family: var(--font-num);
    font-size: 9.5px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
</style>

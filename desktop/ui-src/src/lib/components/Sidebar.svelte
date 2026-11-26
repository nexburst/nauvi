<script lang="ts">
  import { tick } from "svelte";
  import { app, kinds, setView } from "../stores/app.svelte";
  import { problems } from "../stores/problems.svelte";
  import { viewLabel } from "../berths";
  import { chart, closeChart, setChartPinned } from "../stores/chart.svelte";
  import { viewIcon } from "../kindIcons";
  import Icon from "../icons/Icon.svelte";
  import ClusterTree from "./ClusterTree.svelte";
  import SidebarKinds from "./SidebarKinds.svelte";

  let nav = $state<HTMLElement>();
  let lens = $state<HTMLInputElement>();

  // Summoned: the lens takes the keyboard, so "g, dep, Enter" opens Deployments.
  $effect(() => {
    if (chart.open && !chart.pinned) {
      chart.lens = "";
      void tick().then(() => lens?.focus());
    }
  });
  // Kept open as a column: G goes to its filter.
  let focused = chart.focusNonce;
  $effect(() => {
    if (chart.focusNonce === focused) return;
    focused = chart.focusNonce;
    void tick().then(() => lens?.select());
  });

  /** Summoned with an empty lens: what needs a look comes first. */
  const short = $derived(!chart.pinned && chart.lens.trim() === "");
  interface Entry {
    view: string;
    label: string;
    code: string;
    count?: number;
  }
  const entry = (view: string): Entry => {
    const k = kinds.all.find((x) => x.id === view);
    return { view, label: viewLabel(view, kinds.all), code: k?.short_names[0] ?? "", count: problems.byKind[view]?.count };
  };
  const needsLook = $derived(Object.keys(problems.byKind).map(entry));

  function onLensKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      // kubectl's short name, exactly ("po", "deploy", "svc"), wins.
      const q = chart.lens.trim().toLowerCase();
      const exact = q && kinds.all.find((k) => k.short_names.includes(q) || k.resource.plural === q);
      if (exact && !kinds.denied.has(exact.id)) {
        setView(exact.id);
        e.preventDefault();
        return;
      }
      // Otherwise the first entry the lens leaves on the chart.
      const first = nav?.querySelector<HTMLButtonElement>(
        '.quick button, [data-testid="sidebar-kinds"] button.kind:not([aria-disabled="true"])',
      );
      first?.click();
      e.preventDefault();
    } else if (e.key === "Escape") {
      if (chart.pinned) {
        // The column's filter: Escape clears it, then gives the keyboard back.
        if (chart.lens) chart.lens = "";
        else lens?.blur();
      } else closeChart();
      e.stopPropagation();
    }
  }
</script>

<!-- The chart: the cluster tree (ADR 0007) with the shown cluster's kinds
     inside its node. Summoned over the sheet from the rail, or kept open
     as a column (the sidebar, expanded: #481). Without kubeconfig contexts
     (in-cluster): just the kinds. -->
{#if chart.pinned || chart.open}
  {#if !chart.pinned}
    <button type="button" class="scrim" aria-label="Close the chart" tabindex="-1" onclick={closeChart}></button>
  {/if}
  <nav bind:this={nav} class:floating={!chart.pinned} data-testid="chart" aria-label="Kinds">
    <div class="chart-head">
      <label class="find">
        <Icon name="search" size={14} />
        <input
          bind:this={lens}
          bind:value={chart.lens}
          class="lens"
          type="text"
          placeholder={chart.pinned ? "Filter kinds…" : "Kind: po, deploy, secrets…"}
          aria-label="Find a kind"
          data-testid={chart.pinned ? "sidebar-filter" : "chart-lens"}
          onkeydown={onLensKey}
        />
        {#if chart.pinned && chart.lens}
          <button
            type="button"
            class="clear"
            aria-label="Clear the filter"
            title="Clear the filter (Escape)"
            onclick={() => {
              chart.lens = "";
              lens?.focus();
            }}><Icon name="close" size={12} /></button
          >
        {/if}
      </label>
      {#if chart.pinned}
        <button
          type="button"
          class="tool"
          aria-label="Collapse the sidebar"
          title="Collapse the sidebar to icons"
          data-testid="chart-unpin"
          onclick={() => setChartPinned(false)}><Icon name="sidebarCollapse" size={16} /></button
        >
      {:else}
        <button
          type="button"
          class="btn"
          aria-label="Pin as column"
          title="Keep the kinds as a column beside the sheet"
          onclick={() => setChartPinned(true)}>Keep open</button
        >
      {/if}
    </div>
    {#if short && needsLook.length > 0}
      <div class="quick" data-testid="chart-quick">
        <section>
          <h4 class="eyebrow">Needs a look</h4>
          {#each needsLook as e (e.view)}
            <button type="button" class="trouble" onclick={() => setView(e.view)}>
              <Icon name={viewIcon(e.view, kinds.all)} size={16} />
              <span class="label">{e.label}</span>
              {#if e.count}<span class="count">{e.count}</span>{/if}
              {#if e.code}<span class="code">{e.code}</span>{/if}
            </button>
          {/each}
        </section>
      </div>
      <p class="all eyebrow">All {kinds.all.length} kinds</p>
    {/if}
    <div class="chart-body">
      {#if app.contexts.length > 0}
        <ClusterTree />
      {:else}
        <SidebarKinds />
      {/if}
    </div>
  </nav>
{/if}

<style>
  nav {
    width: 220px;
    flex-shrink: 0;
    background: var(--bg-sunken);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .chart-body {
    padding: 4px 8px 16px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
    min-height: 0;
  }

  /* Summoned: the chart unrolls over the sheet. */
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 39;
    border: none;
    padding: 0;
    background: color-mix(in srgb, var(--bg-sunken) 55%, transparent);
    cursor: default;
    animation: scrim 160ms ease-out;
  }
  nav.floating {
    position: absolute;
    top: 0;
    left: 0;
    bottom: 0;
    width: 320px;
    z-index: 40;
    background: var(--bg-sunken);
    border-right: 1px solid var(--border-strong);
    box-shadow: var(--shadow-pop);
    transform-origin: left center;
    animation: unroll 220ms var(--ease-out);
  }
  @keyframes unroll {
    from {
      clip-path: inset(0 100% 0 0);
      opacity: 0.6;
    }
    to {
      clip-path: inset(0 0 0 0);
    }
  }
  @keyframes scrim {
    from {
      opacity: 0;
    }
  }
  /* The filter (or the drawer's lens) and the button that folds the column. */
  .chart-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 8px 8px;
    flex-shrink: 0;
  }
  nav.floating .chart-head {
    padding: 12px 12px 10px;
    border-bottom: 1px solid var(--border);
  }
  .find {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 6px 0 8px;
    height: 30px;
    border: 1px solid var(--border);
    border-radius: 7px;
    background: var(--bg);
    color: var(--text-muted);
    cursor: text;
  }
  .find:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px var(--accent-soft);
  }
  .lens {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    color: var(--text);
    font-family: var(--font-ui);
    font-size: var(--text-base);
    padding: 0;
    outline: none;
  }
  .lens::placeholder {
    color: var(--text-muted);
  }
  nav.floating .lens {
    font-size: var(--text-md);
  }
  .clear,
  .tool {
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: none;
    color: var(--text-muted);
    border-radius: 6px;
    cursor: pointer;
  }
  .clear {
    width: 20px;
    height: 20px;
    padding: 0;
  }
  .tool {
    flex-shrink: 0;
    width: 30px;
    height: 30px;
    padding: 0;
  }
  .clear:hover,
  .tool:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .tool:focus-visible,
  .clear:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  nav.floating .chart-body {
    padding: 6px 8px 20px;
  }
  /* What needs a look, above every kind. */
  .quick {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 8px 4px;
    flex-shrink: 0;
  }
  .quick section {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .quick h4 {
    margin: 0 0 4px;
    padding: 0 8px;
  }
  .quick section button {
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: var(--text);
    font-size: var(--text-base);
    text-align: left;
    cursor: pointer;
  }
  .quick section button:hover {
    background: var(--bg-hover);
  }
  /* What Enter takes: the first entry. */
  .quick section:first-of-type button:first-of-type {
    background: var(--accent-soft);
  }
  .quick .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .quick .count {
    font-family: var(--font-num);
    font-size: 11px;
    font-weight: 600;
    color: var(--red);
  }
  .quick .trouble {
    color: var(--red);
  }
  .quick .trouble .label {
    color: var(--red);
  }
  .quick .code {
    font-family: var(--font-num);
    font-size: 11px;
    color: var(--text-muted);
  }
  .all {
    margin: 8px 16px 0;
    padding: 10px 0 0;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }
</style>

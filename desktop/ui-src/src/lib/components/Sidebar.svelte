<script lang="ts">
  import { tick } from "svelte";
  import { app, kinds, setView } from "../stores/app.svelte";
  import { problems } from "../stores/problems.svelte";
  import { viewLabel } from "../berths";
  import { chart, closeChart, setChartPinned } from "../stores/chart.svelte";
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

  /** Empty lens: only what is likely wanted. Typing or Tab unrolls every kind. */
  const short = $derived(!chart.pinned && chart.lens.trim() === "");
  const COMMON = ["Pod", "Deployment", "Service", "ConfigMap", "Secret", "Ingress", "Node", "Event"];
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
  // Each kind once: what needs a look is not repeated under Common.
  const common = $derived(
    COMMON.map((kind) => kinds.all.find((k) => k.resource.kind === kind && !k.crd))
      .filter((k) => !!k && !problems.byKind[k.id])
      .map((k) => entry(k!.id)),
  );

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
        '.quick button, [data-testid="sidebar-kinds"] button:not([aria-disabled="true"])',
      );
      first?.click();
      e.preventDefault();
    } else if (e.key === "Escape") {
      closeChart();
      e.stopPropagation();
    }
  }
</script>

<!-- The chart: the cluster tree (ADR 0007) with the shown cluster's kinds
     inside its node. Summoned over the sheet from the wake, or pinned as a
     column. Without kubeconfig contexts (in-cluster): just the kinds. -->
{#if chart.pinned || chart.open}
  {#if !chart.pinned}
    <button type="button" class="scrim" aria-label="Close the chart" tabindex="-1" onclick={closeChart}></button>
  {/if}
  <nav bind:this={nav} class:floating={!chart.pinned} data-testid="chart">
    {#if !chart.pinned}
      <div class="chart-head">
        <input
          bind:this={lens}
          bind:value={chart.lens}
          class="lens"
          type="text"
          placeholder="Kind: po, deploy, secrets…"
          aria-label="Find a kind"
          data-testid="chart-lens"
          onkeydown={onLensKey}
        />
        <button
          type="button"
          class="btn"
          aria-label="Pin as column"
          title="Keep the kinds as a column beside the sheet"
          onclick={() => setChartPinned(true)}>Keep open</button
        >
      </div>
    {/if}
    {#if short}
      <div class="quick" data-testid="chart-quick">
        {#snippet group(title: string, list: Entry[])}
          {#if list.length > 0}
            <section>
              <h4 class="eyebrow">{title}</h4>
              {#each list as e (e.view)}
                <button type="button" class:trouble={!!e.count} onclick={() => setView(e.view)}>
                  <span class="label">{e.label}</span>
                  {#if e.count}<span class="count">{e.count}</span>{/if}
                  {#if e.code}<span class="code">{e.code}</span>{/if}
                </button>
              {/each}
            </section>
          {/if}
        {/snippet}
        {@render group("Needs a look", needsLook)}
        {@render group("Common", common)}
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
    width: 200px;
    flex-shrink: 0;
    background: var(--bg-sunken);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .chart-body {
    padding: 12px 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
    min-height: 0;
  }

  /* Summoned: the chart unrolls over the sheet, every kind in columns. */
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
  .chart-head {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 12px 10px 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }
  .lens {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--border-strong);
    color: var(--text);
    font-family: var(--font-num);
    font-size: 14px;
    padding: 6px 2px;
    outline: none;
  }
  .lens:focus {
    border-bottom-color: var(--accent);
  }
  nav.floating .chart-body {
    padding: 6px 8px 20px;
  }
  /* The short chart: three columns of what is most likely wanted. */
  .quick {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px 12px 4px;
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
    align-items: baseline;
    gap: 8px;
    padding: 5px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text);
    font-size: 13px;
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
  .quick .trouble .label {
    color: var(--red);
  }
  .quick .code {
    font-family: var(--font-num);
    font-size: 11px;
    color: var(--text-muted);
  }
  .all {
    margin: 8px 12px 0;
    padding: 10px 8px 0;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

</style>

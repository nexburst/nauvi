<script lang="ts">
  import { tick } from "svelte";
  import { app, kinds, openObject, setView } from "../stores/app.svelte";
  import { problems } from "../stores/problems.svelte";
  import { viewLabel } from "../trail";
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
  // Each kind once: under the first heading it belongs to.
  const wake = $derived(
    chart.trail.filter((s) => !s.object && s.view !== app.view && !problems.byKind[s.view]).map((s) => entry(s.view)),
  );
  /** The objects on the wake, to go straight back to one. */
  const wakeObjects = $derived(chart.trail.filter((s) => !!s.object));
  function reopen(view: string, o: { namespace: string; name: string }) {
    const kind = kinds.all.find((k) => k.id === view);
    if (kind) openObject(kind, o.namespace, o.name);
  }
  const common = $derived(
    COMMON.map((kind) => kinds.all.find((k) => k.resource.kind === kind && !k.crd))
      .filter((k) => !!k && !problems.byKind[k.id] && !wake.some((w) => w.view === k.id))
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
        <span class="eyebrow">Chart</span>
        <input
          bind:this={lens}
          bind:value={chart.lens}
          class="lens"
          type="text"
          placeholder="Type a kind: po, dep, secrets…"
          aria-label="Find a kind"
          data-testid="chart-lens"
          onkeydown={onLensKey}
        />
        <button type="button" class="btn" title="Keep the chart as a column beside the sheet" onclick={() => setChartPinned(true)}
          >Pin as column</button
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
        <section>
          {#if wake.length + wakeObjects.length > 0}
            <h4 class="eyebrow">Your wake</h4>
            {#each wake as e (e.view)}
              <button type="button" onclick={() => setView(e.view)}><span class="label">{e.label}</span></button>
            {/each}
            {#each wakeObjects as s (s.view + s.object!.name)}
              <button type="button" onclick={() => reopen(s.view, s.object!)}>
                <span class="label">{s.object!.name}</span>
                <span class="code">{viewLabel(s.view, kinds.all)}</span>
              </button>
            {/each}
          {/if}
        </section>
        {@render group("Common", common)}
      </div>
      <p class="all eyebrow">All {kinds.all.length} kinds · the other clusters</p>
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
    width: 100%;
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
    gap: 14px;
    padding: 12px 20px;
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
    padding: 14px 20px 24px;
  }
  /* The short chart: three columns of what is most likely wanted. */
  .quick {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 260px));
    gap: 8px 40px;
    padding: 18px 20px 8px;
    flex-shrink: 0;
  }
  .quick section {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }
  .quick h4 {
    margin: 0 0 8px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border);
  }
  .quick section button {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 7px 8px;
    background: transparent;
    border: none;
    border-radius: 4px;
    color: var(--text);
    font-size: 15px;
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
    margin: 10px 20px 0;
    padding-top: 12px;
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  /* The shown cluster's kinds flow into columns; a section never splits
     from its heading. */
  nav.floating :global([data-testid="sidebar-kinds"]) {
    display: block;
    columns: 180px;
    column-gap: 28px;
    padding-top: 4px;
  }
  nav.floating :global([data-testid="sidebar-kinds"] h4) {
    break-after: avoid;
    margin-left: 0;
    margin-right: 0;
  }
  nav.floating :global([data-testid="sidebar-kinds"] button),
  nav.floating :global([data-testid="sidebar-kinds"] details) {
    display: flex;
    width: 100%;
    break-inside: avoid;
  }
  nav.floating :global([data-testid="sidebar-kinds"] details) {
    display: block;
  }
</style>

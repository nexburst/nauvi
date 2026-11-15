<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import VirtualList from "../VirtualList.svelte";
  import HelmRepos from "./HelmRepos.svelte";
  import { app } from "../../stores/app.svelte";
  import { checkHelm, helm } from "../../stores/helm.svelte";
  import { charts, loadCharts, selectChart } from "../../stores/helmCharts.svelte";
  import { filterCharts } from "../../helmCharts";
  import { watchGutter } from "../../scrollGutter";

  /** The charts in the configured repositories (newest version of each), filtered by the toolbar. */

  const ROW_HEIGHT = 32;
  const template = "minmax(180px, 2fr) 100px 110px minmax(200px, 4fr)";
  const HEADERS = ["Chart", "Version", "App version", "Description"];

  // The header leaves the space the rows' scrollbar takes, so its columns
  // stay over the cells (#123).
  let scrollEl = $state<HTMLDivElement | null>(null);
  let gutter = $state(0);
  $effect(() => {
    if (scrollEl) return watchGutter(scrollEl, (px) => (gutter = px));
  });

  /** The repositories panel; open by default while there are none. */
  let showRepos = $state(false);

  onMount(() => void checkHelm());
  onDestroy(() => selectChart(null));

  $effect(() => {
    void app.refreshNonce;
    untrack(() => void loadCharts());
  });

  const visible = $derived(filterCharts(charts.charts, app.search));
  const getKey = $derived((i: number) => visible[i]?.name ?? i);
  const reposOpen = $derived(showRepos || (charts.reposLoaded && charts.repos.length === 0));

  $effect(() => {
    app.count = `${visible.length} of ${charts.charts.length} charts`;
  });
</script>

<div class="table" data-testid="helm-charts">
  {#if helm.helmMissing}
    <p class="error-text banner" role="alert" data-testid="helm-missing">{helm.helmMissing}</p>
  {/if}
  <div class="repobar">
    <span class="muted">
      {#if !charts.reposLoaded}
        Reading repositories…
      {:else if charts.repos.length}
        {charts.repos.length === 1 ? "Repository" : "Repositories"}: {charts.repos.map((r) => r.name).join(", ")}
      {:else}
        No chart repositories configured.
      {/if}
    </span>
    <button type="button" class="btn" aria-expanded={reposOpen} onclick={() => (showRepos = !reposOpen)}
      >{reposOpen ? "Hide repositories" : "Manage repositories"}</button
    >
  </div>
  {#if reposOpen}
    <div class="repos"><HelmRepos /></div>
  {/if}
  {#if charts.chartsError}
    <p class="error-text banner" role="alert">Could not search the repositories: {charts.chartsError}</p>
  {/if}

  <div class="grid" role="grid" aria-label="Helm charts" aria-rowcount={visible.length + 1}>
    <div class="head" role="row" style:grid-template-columns={template} style:padding-right="{gutter}px">
      {#each HEADERS as h (h)}
        <div class="th" role="columnheader">{h}</div>
      {/each}
    </div>
    <VirtualList count={visible.length} rowHeight={ROW_HEIGHT} {getKey} bind:scrollEl>
      {#snippet row(i)}
        {@const c = visible[i]}
        {#if c}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
          <div
            class="tr"
            role="row"
            data-testid="chart-row"
            class:selected={c.name === charts.selected}
            style:grid-template-columns={template}
            onclick={() => selectChart(c.name)}
          >
            <div class="td" role="gridcell" title={c.name}>{c.name}</div>
            <div class="td" role="gridcell">{c.version}</div>
            <div class="td" role="gridcell">{c.app_version}</div>
            <div class="td muted" role="gridcell" title={c.description}>{c.description}</div>
          </div>
        {/if}
      {/snippet}
    </VirtualList>
    {#if charts.chartsLoaded && charts.repos.length > 0 && visible.length === 0 && !charts.chartsError}
      <p class="empty">{charts.charts.length ? "No charts match the filter." : "The repositories have no charts."}</p>
    {:else if !charts.chartsLoaded}
      <p class="empty">Loading…</p>
    {/if}
  </div>

</div>

<style>
  .table {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    padding: 0 16px 16px;
    position: relative;
  }
  .banner {
    margin: 8px 0 0;
    font-size: 12px;
  }
  .repobar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 0;
    font-size: 12px;
  }
  .repos {
    padding: 8px 12px;
    margin-bottom: 8px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-raised);
  }
  .grid {
    flex: 1;
    min-height: 0;
    min-width: 0;
    /* Columns wider than the table are cut off here, like the rows in the
       scroller; unclipped, the header paints over the detail panel (#123). */
    overflow: hidden;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .head {
    display: grid;
    height: 28px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    align-items: center;
  }
  .th {
    padding: 0 10px;
    color: var(--text-muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    white-space: nowrap;
  }
  .tr {
    display: grid;
    align-items: center;
    height: 100%;
    border-bottom: 1px solid var(--border);
    cursor: pointer;
  }
  .tr:hover,
  .tr.selected {
    background: var(--bg-hover);
  }
  .td {
    padding: 0 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
  }
  .empty {
    position: absolute;
    top: 40px;
    left: 0;
    right: 0;
    margin: 0;
    text-align: center;
    color: var(--text-muted);
  }
</style>

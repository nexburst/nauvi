<script lang="ts">
  import { rowHeightPx } from "../../preferences";
  import { settings } from "../../stores/settings.svelte";
  import { onDestroy, onMount, untrack } from "svelte";
  import VirtualList from "../VirtualList.svelte";
  import { app } from "../../stores/app.svelte";
  import { checkHelm, helm, loadReleases, resetHelmView, selectRelease } from "../../stores/helm.svelte";
  import { ageOf, chartLabel, releaseHay, releaseKey, statusClass, visibleReleases } from "../../helm";
  import { ListFilter } from "../../stores/tableFilter.svelte";
  import { watchGutter } from "../../scrollGutter";
  import EmptyState from "../EmptyState.svelte";
  import { listEmptyState } from "../../emptyState";
  import { setNamespaces, setView } from "../../stores/app.svelte";
  import { HELM_CHARTS_VIEW } from "../../helmCharts";

  /** The Helm releases table. Rows come from labels; charts fill in after. */

  // Settings → Tables (#330): normal or compact.
  const ROW_HEIGHT = $derived(rowHeightPx(32, settings.current.row_height));
  const template = "minmax(140px, 2fr) minmax(100px, 1fr) 80px minmax(140px, 1.5fr) 110px 120px 80px";
  const HEADERS = ["Name", "Namespace", "Revision", "Chart", "App version", "Status", "Updated"];

  // The header leaves the space the rows' scrollbar takes, so its columns
  // stay over the cells (#123).
  let scrollEl = $state<HTMLDivElement | null>(null);
  let gutter = $state(0);
  $effect(() => {
    if (scrollEl) return watchGutter(scrollEl, (px) => (gutter = px));
  });

  let now = $state(Date.now());
  onMount(() => {
    void checkHelm();
    const t = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(t);
  });
  onDestroy(resetHelmView);

  // Load on mount, on Refresh and when the namespaces change.
  $effect(() => {
    void app.refreshNonce;
    const namespaces = app.selectedNamespaces;
    untrack(() => {
      now = Date.now();
      void loadReleases(namespaces);
    });
  });

  // The toolbar filter (#219): text, match case or a regex in the worker.
  const filter = new ListFilter(() => helm.rows, {
    key: releaseKey,
    lower: (r) => releaseHay(r, helm.charts).toLowerCase(),
    text: (r) => releaseHay(r, helm.charts),
    lines: (r) => releaseHay(r, helm.charts, "\n"),
  });
  const visible = $derived(visibleReleases(helm.rows, helm.charts, filter.match));
  const getKey = $derived((i: number) => (visible[i] ? releaseKey(visible[i]) : i));
  const selectedKey = $derived(helm.selected ? releaseKey(helm.selected) : null);

  $effect(() => {
    app.count = `${visible.length} of ${helm.rows.length} releases`;
  });
</script>

<div class="table" data-testid="helm-releases">
  {#if helm.error}
    <p class="error-text banner" role="alert">Could not list Helm releases: {helm.error}</p>
  {/if}
  {#each helm.warnings as w (w)}
    <p class="warning banner" data-testid="helm-warning">{w}</p>
  {/each}

  <div class="grid" role="grid" aria-label="Helm releases" aria-rowcount={visible.length + 1}>
    <div class="head" role="row" style:grid-template-columns={template} style:padding-right="{gutter}px">
      {#each HEADERS as h (h)}
        <div class="th" role="columnheader">{h}</div>
      {/each}
    </div>
    <VirtualList count={visible.length} rowHeight={ROW_HEIGHT} {getKey} bind:scrollEl>
      {#snippet row(i)}
        {@const r = visible[i]}
        {#if r}
          {@const c = helm.charts.get(releaseKey(r))}
          {@const chart = c && c.revision === r.revision ? c : null}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
          <div
            class="tr"
            role="row"
            data-testid="helm-row"
            class:selected={releaseKey(r) === selectedKey}
            style:grid-template-columns={template}
            onclick={() => selectRelease({ namespace: r.namespace, name: r.name })}
          >
            <div class="td" role="gridcell" title={r.name}>{r.name}</div>
            <div class="td" role="gridcell">{r.namespace}</div>
            <div class="td" role="gridcell">{r.revision}</div>
            <div class="td" role="gridcell" title={chart?.error ?? ""}>
              {#if chart?.error}<span class="muted">?</span>{:else if chart}{chartLabel(
                  chart.chart,
                  chart.chart_version,
                )}{:else}<span class="muted">…</span>{/if}
            </div>
            <div class="td" role="gridcell">{chart?.app_version ?? ""}</div>
            <div class="td {statusClass(r.status)}" role="gridcell">{r.status}</div>
            <div class="td" role="gridcell">{ageOf(r.updated, now)}</div>
          </div>
        {/if}
      {/snippet}
    </VirtualList>
  </div>

  {#if helm.loaded && visible.length === 0 && !helm.error}
    {@const e = listEmptyState({
      label: "Helm releases",
      namespaces: app.selectedNamespaces,
      search: app.search,
      total: helm.rows.length,
      synced: true,
    })}
    <div class="empty">
      <EmptyState title={e.title} detail={e.reason === "none" ? "Install one from a chart repository." : e.detail} reason={e.reason}>
        {#if e.reason === "filter"}
          <button type="button" class="btn primary" data-testid="clear-filter" onclick={() => (app.search = "")}>Clear filter</button>
        {:else if e.reason === "namespace"}
          <button type="button" class="btn primary" onclick={() => setNamespaces([])}>All namespaces</button>
        {/if}
        {#if e.reason !== "filter"}
          <button type="button" class="btn" class:primary={e.reason === "none"} onclick={() => setView(HELM_CHARTS_VIEW)}>Browse charts</button>
        {/if}
      </EmptyState>
    </div>
  {:else if !helm.loaded}
    <p class="empty">Loading…</p>
  {/if}
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
  .warning {
    color: var(--amber);
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
    top: 56px;
    left: 0;
    right: 0;
    margin: 0;
    display: flex;
    justify-content: center;
    color: var(--text-muted);
  }
</style>

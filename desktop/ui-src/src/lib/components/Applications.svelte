<script module lang="ts">
  /** Feed ids, unique across mounts so a stale feed's events are ignored. */
  let nextFeed = 0;
</script>

<script lang="ts">
  import { rowHeightPx } from "../preferences";
  import { settings } from "../stores/settings.svelte";
  import { onDestroy, untrack } from "svelte";
  import VirtualList from "./VirtualList.svelte";
  import { events } from "../bindings";
  import { api, visibleCluster } from "../cluster";
  import type { ApplicationsStateChanged } from "../bindings";
  import { thisWindow } from "../window";
  import { app, setStatus, showError, stamp } from "../stores/app.svelte";
  import { apps, applyApplications, resetApplications, selectApplication } from "../stores/applications.svelte";
  import { clusterError } from "../clusterError";
  import { formatAge } from "../format";
  import { healthTone, nextSort, sourceLabel, visibleApps, workloadSummary } from "../applications";
  import type { AppSort, AppSortKey } from "../applications";
  import { watchGutter } from "../scrollGutter";

  /** Applications (#226): workloads grouped by the app.kubernetes.io labels
   *  and Helm releases, live, with their status rolled up. A row opens the
   *  application's objects in the side panel. */

  const RETRY_MS = 5_000;
  const AGE_TICK_MS = 15_000;
  // Settings → Tables (#330): normal or compact.
  const ROW_HEIGHT = $derived(rowHeightPx(32, settings.current.row_height));
  const template =
    "minmax(140px, 1.6fr) minmax(100px, 1fr) 110px minmax(130px, 1.2fr) minmax(100px, 1fr) 80px 124px 64px";
  const HEADERS: { label: string; sort?: AppSortKey }[] = [
    { label: "Name", sort: "name" },
    { label: "Namespace", sort: "namespace" },
    { label: "Status", sort: "health" },
    { label: "Workloads", sort: "workloads" },
    { label: "Components" },
    { label: "Version" },
    { label: "Source" },
    { label: "Age", sort: "age" },
  ];

  let sort = $state<AppSort>({ key: "name", dir: "asc" });
  let now = $state(Date.now());
  let feed = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

  let scrollEl = $state<HTMLDivElement | null>(null);
  let gutter = $state(0);
  $effect(() => {
    if (scrollEl) return watchGutter(scrollEl, (px) => (gutter = px));
  });

  const listening = Promise.all([
    events.applicationsUpdate(thisWindow()).listen((e) => {
      if (e.payload.id !== feed) return;
      applyApplications(e.payload.list);
      stamp();
    }),
    events.applicationsState(thisWindow()).listen((e) => {
      if (e.payload.id === feed) onState(e.payload);
    }),
  ]);

  /** The banner message this view set, so it clears only its own. */
  let shown = "";
  function setError(message: string) {
    shown = message;
    showError(message);
  }
  function clearError() {
    if (shown && app.error === shown) showError("");
    shown = "";
  }

  function onState(s: ApplicationsStateChanged) {
    if (s.state === "live") {
      setStatus(true, "Live");
      clearError();
    } else if (s.state === "reconnecting") {
      setStatus(false, "Reconnecting…");
      setError(s.error);
    } else {
      setStatus(null, "Connecting…");
    }
  }

  function stop() {
    if (retry) clearTimeout(retry);
    retry = null;
    const id = feed;
    feed = 0;
    if (id) api(visibleCluster()).cmdApplicationsStop(id).catch(() => {});
  }

  async function start(namespaces: string[]) {
    stop();
    const id = ++nextFeed;
    feed = id;
    // A Refresh keeps the open panel; the new list replaces it or closes it.
    resetApplications(true);
    setStatus(null, "Connecting…");
    clearError();
    await listening;
    if (feed !== id) return;
    try {
      await api(visibleCluster()).cmdApplicationsStart(id, namespaces);
    } catch (e) {
      if (feed !== id) return;
      const err = clusterError(e);
      setStatus(false, err.status);
      setError(err.message);
      retry = setTimeout(() => start(namespaces), RETRY_MS);
    }
  }

  // Start on mount, on Refresh or a context switch, and for every change
  // of the namespace selection.
  $effect(() => {
    void app.refreshNonce;
    const namespaces = [...app.selectedNamespaces];
    untrack(() => start(namespaces));
  });

  const ageTimer = setInterval(() => (now = Date.now()), AGE_TICK_MS);

  onDestroy(() => {
    clearInterval(ageTimer);
    stop();
    resetApplications();
    listening.then((uns) => uns.forEach((un) => un()));
  });

  const visible = $derived(visibleApps(apps.rows.entries, app.search, sort));
  const getKey = $derived((i: number) => visible[i]?.key ?? i);

  $effect(() => {
    app.count = apps.loaded ? `${visible.length} of ${apps.rows.entries.length} applications` : "";
  });
</script>

<div class="table" data-testid="applications">
  {#if apps.notes.length > 0}
    <ul class="notes muted" data-testid="applications-notes">
      {#each apps.notes as note (note)}
        <li>{note}</li>
      {/each}
    </ul>
  {/if}

  <div class="grid" role="grid" aria-label="Applications" aria-rowcount={visible.length + 1}>
    <div class="head" role="row" style:grid-template-columns={template} style:padding-right="{gutter}px">
      {#each HEADERS as h (h.label)}
        <div
          class="th"
          role="columnheader"
          aria-sort={h.sort && sort.key === h.sort ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
        >
          {#if h.sort}
            {@const key = h.sort}
            <button
              type="button"
              class="sort"
              aria-label={`Sort by ${h.label}`}
              onclick={() => (sort = nextSort(sort, key))}
              >{h.label}{#if sort.key === key}<span aria-hidden="true">{sort.dir === "asc" ? " ▲" : " ▼"}</span
                >{/if}</button
            >
          {:else}
            {h.label}
          {/if}
        </div>
      {/each}
    </div>
    <VirtualList count={visible.length} rowHeight={ROW_HEIGHT} {getKey} bind:scrollEl>
      {#snippet row(i)}
        {@const a = visible[i]}
        {#if a}
          <!-- svelte-ignore a11y_click_events_have_key_events, a11y_interactive_supports_focus -->
          <div
            class="tr"
            role="row"
            data-testid="application-row"
            data-key={a.key}
            class:selected={a.key === apps.selected}
            style:grid-template-columns={template}
            onclick={() => selectApplication(a)}
          >
            <div class="td name" role="gridcell" title={a.name}>{a.name}</div>
            <div class="td" role="gridcell">{a.namespace}</div>
            <div class="td" role="gridcell" title={a.reason} data-health={a.health}>
              <span class="dot {healthTone(a.health)}"></span>{a.health}
            </div>
            <div class="td" role="gridcell" title={workloadSummary(a)}>{workloadSummary(a)}</div>
            <div class="td" role="gridcell" title={a.components.join(", ")}>{a.components.join(", ")}</div>
            <div class="td" role="gridcell" title={a.versions.join(", ")}>{a.versions.join(", ")}</div>
            <div class="td muted" role="gridcell">{sourceLabel(a.source)}</div>
            <div class="td" role="gridcell">{formatAge(a.created, now, "")}</div>
          </div>
        {/if}
      {/snippet}
    </VirtualList>
    <!-- Inside the grid, so notes above it never overlap the message. -->
    {#if apps.loaded && visible.length === 0}
      <div class="empty" data-testid="applications-empty">
        {#if apps.rows.entries.length > 0}
          <p>No applications match the filter.</p>
        {:else}
          <p>No applications found.</p>
          <p class="muted hint">
            Workloads appear here when they carry an <code>app.kubernetes.io/instance</code> or
            <code>app.kubernetes.io/name</code> label, or were installed by Helm.
          </p>
        {/if}
      </div>
    {:else if !apps.loaded}
      <p class="empty muted">Loading…</p>
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
  .notes {
    margin: 8px 0 0;
    padding-left: 18px;
    font-size: 12px;
  }
  .grid {
    flex: 1;
    min-height: 0;
    min-width: 0;
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
  .sort {
    background: none;
    border: none;
    padding: 0;
    color: inherit;
    font: inherit;
    letter-spacing: inherit;
    text-transform: inherit;
    cursor: pointer;
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
  .name {
    font-weight: 500;
  }
  .dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-right: 6px;
    vertical-align: middle;
  }
  .ok {
    background: var(--green);
  }
  .progress {
    background: var(--amber);
  }
  .bad {
    background: var(--red);
  }
  .idle,
  .done {
    background: var(--text-muted);
  }
  .empty {
    position: absolute;
    top: 48px;
    left: 0;
    right: 0;
    margin: 0;
    padding: 0 24px;
    text-align: center;
    color: var(--text-muted);
  }
  .empty p {
    margin: 0 0 6px;
  }
  .hint {
    font-size: 12px;
  }
  code {
    font-size: 12px;
  }
</style>

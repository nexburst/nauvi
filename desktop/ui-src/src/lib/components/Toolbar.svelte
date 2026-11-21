<script lang="ts">
  import { app, currentKind } from "../stores/app.svelte";
  import NamespacePicker from "./NamespacePicker.svelte";
  import ColumnChooser from "./ColumnChooser.svelte";
  import ExportCsv from "./ExportCsv.svelte";
  import TableFilter from "./TableFilter.svelte";
  import { openCreate } from "../stores/create.svelte";
  import { HELM_VIEW } from "../helm";
  import { PROBLEMS_STATUS, WORKLOADS_VIEW } from "../workloads";
  import { problems } from "../stores/problems.svelte";
  import { APPLICATIONS_VIEW } from "../applications";
  import { chart } from "../stores/chart.svelte";
  import { kinds } from "../stores/app.svelte";
  import { viewLabel } from "../berths";

  const kind = $derived(currentKind());
  // Only namespaced kinds (and Helm releases) can be narrowed to a namespace.
  const namespaced = $derived(
    app.view === HELM_VIEW ||
      app.view === WORKLOADS_VIEW ||
      app.view === APPLICATIONS_VIEW ||
      (kind?.resource.namespaced ?? false),
  );
  /** The Workloads overview has nothing to filter or create. */
  const overview = $derived(app.view === WORKLOADS_VIEW);
</script>

<div class="toolbar">
  {#if !chart.pinned}
    <!-- Where you are: with no column of kinds, the view says its name. -->
    <span class="view-name" data-testid="view-name">{viewLabel(app.view, kinds.all)}</span>
  {/if}
  <div class="namespaces" class:invisible={!namespaced} class:gone={!namespaced && !chart.pinned}>
    <NamespacePicker />
  </div>
  {#if !overview}
    <TableFilter />
  {/if}
  {#if kind}
    {@const n = problems.byKind[kind.id]?.count ?? 0}
    <!-- Only what needs attention (k9s calls it faults): one press, any table. -->
    <button
      type="button"
      class="btn faults"
      class:active={app.statusFilter === PROBLEMS_STATUS}
      aria-pressed={app.statusFilter === PROBLEMS_STATUS}
      aria-label="Only rows that need attention"
      title="Show only the rows that need attention (Z)"
      data-testid="problems-only"
      onclick={() => (app.statusFilter = app.statusFilter === PROBLEMS_STATUS ? "" : PROBLEMS_STATUS)}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M8 2.2L14.2 13H1.8zM8 6.4v3.2M8 11.4v.2" />
      </svg>{#if n > 0}<span class="n">{n}</span>{/if}
    </button>
  {/if}
  {#if app.statusFilter && kind}
    <!-- Set by a count in the Workloads overview. -->
    <span class="status-filter" data-testid="status-filter">
      Status: {app.statusFilter}
      <button
        type="button"
        class="clear"
        aria-label="Show every status"
        title="Show every status"
        onclick={() => (app.statusFilter = "")}>✕</button
      >
    </span>
  {/if}
  {#if kind}
    <ColumnChooser {kind} />
    <ExportCsv {kind} />
  {/if}
  {#if !overview}
    <button type="button" class="btn primary create" title="Create resources from YAML" onclick={openCreate}
      >+ Create</button
    >
  {/if}
</div>

<style>
  .toolbar {
    /* Columns and Export CSV turn into icons when it is narrow. */
    container: toolbar / inline-size;
    /* The export note sits under it when the row is too narrow. */
    position: relative;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    /* 12px, down to 8px when the row is short of room (#392). */
    gap: 12px clamp(8px, 1.6%, 12px);
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .invisible {
    visibility: hidden;
  }
  .gone {
    display: none;
  }
  .view-name {
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
    white-space: nowrap;
    max-width: 220px;
    overflow: hidden;
    text-overflow: ellipsis;
    margin-right: 4px;
  }
  /* Narrow windows (many namespace chips, the detail panel open): the filter
     shrinks to a usable minimum, the buttons keep one line, and what does
     not fit wraps onto a second row. */
  .namespaces {
    /* The picker's button is 160px; its chips wrap below it. */
    min-width: 160px;
  }
  /* Beside the inspector at 1280 px (#392): the picker and the filter give
     way before anything wraps, so "+ Create" stays on the row. */
  @container toolbar (max-width: 720px) {
    /* A wrapping row breaks lines at each item's basis, so the picker is
       placed at its minimum and grows back to its content's width. */
    .namespaces {
      flex: 1 1 112px;
      min-width: 112px;
      max-width: max-content;
    }
  }
  .create {
    margin-left: auto;
    flex-shrink: 0;
    white-space: nowrap;
  }
  .faults {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 4px 7px;
    flex-shrink: 0;
  }
  /* A narrow row (the inspector open at 1280) keeps one line: the mark
     gives way, the Z key and the status chip stay. */
  @container toolbar (max-width: 720px) {
    .faults {
      display: none;
    }
  }
  .faults svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .faults .n {
    font-family: var(--font-num);
    font-size: 11px;
    color: var(--red);
  }
  .status-filter {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px 2px 10px;
    border: 1px solid var(--accent);
    border-radius: 12px;
    font-size: 12px;
    white-space: nowrap;
  }
  .clear {
    background: transparent;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 0 4px;
  }
  .clear:hover {
    color: var(--text);
  }
</style>

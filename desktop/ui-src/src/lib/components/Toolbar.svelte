<script lang="ts">
  import { app, currentKind } from "../stores/app.svelte";
  import NamespacePicker from "./NamespacePicker.svelte";
  import ColumnChooser from "./ColumnChooser.svelte";
  import ExportCsv from "./ExportCsv.svelte";
  import TableFilter from "./TableFilter.svelte";
  import { openCreate } from "../stores/create.svelte";
  import { HELM_VIEW } from "../helm";
  import { WORKLOADS_VIEW } from "../workloads";

  const kind = $derived(currentKind());
  // Only namespaced kinds (and Helm releases) can be narrowed to a namespace.
  const namespaced = $derived(
    app.view === HELM_VIEW || app.view === WORKLOADS_VIEW || (kind?.resource.namespaced ?? false),
  );
  /** The Workloads overview has nothing to filter or create. */
  const overview = $derived(app.view === WORKLOADS_VIEW);
</script>

<div class="toolbar">
  <div class="namespaces" class:invisible={!namespaced}>
    <NamespacePicker />
  </div>
  {#if !overview}
    <TableFilter />
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
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
  }
  .invisible {
    visibility: hidden;
  }
  /* Narrow windows (many namespace chips, the detail panel open): the filter
     shrinks to a usable minimum, the buttons keep one line, and what does
     not fit wraps onto a second row. */
  .namespaces {
    /* The picker's button is 160px; its chips wrap below it. */
    min-width: 160px;
  }
  .create {
    margin-left: auto;
    flex-shrink: 0;
    white-space: nowrap;
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

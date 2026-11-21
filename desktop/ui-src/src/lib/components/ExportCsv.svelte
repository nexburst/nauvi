<script lang="ts">
  import { onDestroy } from "svelte";
  import { commands } from "../bindings";
  import type { ResourceKind } from "../bindings";
  import { csvFilename, savedNote } from "../csv";
  import { SAVED_NOTE_MS } from "../logs";
  import { currentContextName } from "../stores/app.svelte";
  import { tableExport } from "../stores/tableExport.svelte";

  let { kind }: { kind: ResourceKind } = $props();

  const ready = $derived(tableExport()?.kind.id === kind.id);

  // The last result, shown next to the button for SAVED_NOTE_MS.
  let note = $state<{ text: string; title: string; error: boolean } | null>(null);
  let busy = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  function show(text: string, title: string, error: boolean) {
    note = { text, title, error };
    clearTimeout(timer);
    timer = setTimeout(() => (note = null), SAVED_NOTE_MS);
  }

  async function exportCsv() {
    const table = tableExport();
    if (!table || busy) return;
    busy = true;
    try {
      const rows = table.rows();
      const filename = csvFilename(kind.label, currentContextName(), new Date());
      const path = await commands.cmdSaveCsv(filename, table.csv());
      // null: the user cancelled the save dialog.
      if (path) show(savedNote(rows, path), path, false);
    } catch (e) {
      const text = `Could not export: ${e}`;
      show(text, text, true);
    } finally {
      busy = false;
    }
  }

  onDestroy(() => clearTimeout(timer));
</script>

{#if note}
  <span class="note" class:error={note.error} role="status" data-testid="csv-saved" title={note.title}
    >{note.text}</span
  >
{/if}
<button
  type="button"
  class="btn export"
  title="Save the rows and columns shown to a CSV file"
  aria-label="Export CSV"
  disabled={!ready || busy}
  onclick={exportCsv}
  ><svg class="icon" viewBox="0 0 16 16" aria-hidden="true"
    ><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13h10" /></svg
  ><span class="label">Export CSV</span></button
>

<style>
  .export {
    flex-shrink: 0;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
  }
  .icon {
    display: none;
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  /* A narrow toolbar (the detail panel open): the icon only; the name is in
     the tooltip and the accessible name. */
  @container toolbar (max-width: 720px) {
    .icon {
      display: block;
    }
    .label {
      display: none;
    }
  }
  .note {
    /* Takes only the room left on the row (it never wraps the toolbar),
       up to 300 px; the full text is in the tooltip. */
    flex: 1 1 0;
    min-width: 0;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    color: var(--text-muted);
  }
  .note.error {
    color: var(--error-text);
  }
  /* Too narrow to leave it room in the row: it shows under the toolbar, at
     its right end, until it goes away. */
  @container toolbar (max-width: 720px) {
    .note {
      position: absolute;
      top: calc(100% + 4px);
      right: 16px;
      z-index: 20;
      max-width: calc(100% - 32px);
      padding: 4px 8px;
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      /* Out of the row it has room to wrap: shown whole, between words
         first (#384). */
      white-space: normal;
      overflow-wrap: anywhere;
    }
  }
</style>

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
  disabled={!ready || busy}
  onclick={exportCsv}>Export CSV</button
>

<style>
  .export {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .note {
    min-width: 0;
    flex: 0 1 auto;
    /* Narrow enough that the toolbar keeps one row at 1280 px; the full
       text is in the tooltip. */
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
</style>

<script lang="ts">
  import { currentContextName } from "../stores/app.svelte";
  import { openClusterSettings } from "../stores/catalog.svelte";

  /** Shown where metrics would be when they are hidden for the cluster
   *  (#327), with a way to its settings to show them again. */
  let { inline = false }: { inline?: boolean } = $props();
</script>

<p class="note muted" class:inline data-testid="metrics-hidden">
  Metrics hidden for this cluster —
  <button type="button" class="link" onclick={() => openClusterSettings(currentContextName())}>Settings</button>
</p>

<style>
  .note {
    margin: 0;
    padding: 6px 16px;
    font-size: 12px;
  }
  .note.inline {
    padding: 0;
  }
  .link {
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
</style>

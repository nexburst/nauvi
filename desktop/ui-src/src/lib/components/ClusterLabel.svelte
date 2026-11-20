<script lang="ts">
  import { contextFullName, contextLabel } from "../stores/catalog.svelte";
  import { contextSettings } from "../stores/settings.svelte";

  /** Which cluster something belongs to (ADR 0007): its name, with its
   *  colour if one is set. The same everywhere: dock tabs, port-forwards,
   *  notifications, the status bar. */
  let { id, title = "" }: { id: string; title?: string } = $props();

  const color = $derived(contextSettings(id).color);
  const name = $derived(contextLabel(id));
  // The whole name is always in the tooltip (#383): the label may be short.
  const full = $derived(contextFullName(id));
  const tip = $derived(!title ? full : name === full || title.includes(full) ? title : `${title}\n${full}`);
</script>

<span class="cluster-label" data-testid="cluster-label" data-cluster={id} title={tip}>
  {#if color}<span class="swatch" style:background={color} data-testid="cluster-label-color" aria-hidden="true"></span>{/if}
  <span class="name">{name}</span>
</span>

<style>
  .cluster-label {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
  }
  .swatch {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }
  .name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

<script lang="ts">
  import type { ImageVulns } from "../bindings";
  import { imagesText, progressText, scannerLabel, toScan, unscannable, unscannableText } from "../imageScan";
  import { imageSecuritySettings } from "../stores/imageSecurity.svelte";
  import { cancelScan, imageScan, scanAll } from "../stores/imageScan.svelte";

  /** The local scanner's bar above the list (#536): "Scan N images" (only
   *  from this click, one after another), the progress with Cancel, and
   *  what could not be scanned. */
  let { images }: { images: readonly ImageVulns[] } = $props();

  const s = $derived(imageSecuritySettings());
  const pending = $derived(toScan(images));
  const blocked = $derived(unscannable(images).length);
  const errors = $derived([...imageScan.errors.values()]);
</script>

<div class="bar" data-testid="image-scan-bar">
  {#if imageScan.running}
    <span class="progress" data-testid="image-scan-progress">
      {imageScan.batch
        ? progressText(imageScan.batch.done, imageScan.batch.total, imageScan.running.image)
        : progressText(0, 1, imageScan.running.image)}
    </span>
    <button type="button" class="btn" data-testid="image-scan-cancel" onclick={cancelScan}>Cancel</button>
  {:else if pending.length > 0}
    <span class="muted">{imagesText(pending.length)} not scanned yet.</span>
    <button type="button" class="btn primary" data-testid="image-scan-all" onclick={() => scanAll(pending)}
      >Scan {imagesText(pending.length)} with {scannerLabel(s.scanner)}</button
    >
  {:else if blocked === 0}
    <span class="muted">Every running image here was scanned.</span>
  {/if}
  {#if blocked > 0 && !imageScan.running}
    <span class="muted" data-testid="image-scan-blocked">{unscannableText(blocked)}</span>
  {/if}
</div>
{#if errors.length > 0 && !imageScan.running}
  <ul class="errors" data-testid="image-scan-errors">
    {#each errors.slice(0, 5) as e (e.image)}
      <li><span class="image">{e.image}</span>: {e.error}</li>
    {/each}
    {#if errors.length > 5}<li class="muted">+{errors.length - 5} more</li>{/if}
  </ul>
{/if}

<style>
  .bar {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
    padding: 8px 0 0;
    font-size: 12px;
  }
  .progress {
    color: var(--text);
  }
  .muted {
    color: var(--text-muted);
  }
  .errors {
    margin: 6px 0 0;
    padding-left: 18px;
    font-size: 12px;
    color: var(--red);
  }
  .errors li {
    overflow-wrap: anywhere;
  }
  .image {
    font-family: var(--font-mono, monospace);
  }
</style>

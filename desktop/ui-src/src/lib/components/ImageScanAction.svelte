<script lang="ts">
  import type { ImageVulns } from "../bindings";
  import { notScannableText, scannable, scannerLabel } from "../imageScan";
  import { rowKey } from "../imageSecurity";
  import { imageSecuritySettings } from "../stores/imageSecurity.svelte";
  import { cancelScan, imageScan, scanImage } from "../stores/imageScan.svelte";

  /** The panel's Scan (or Scan again) with the local scanner (#536). */
  let { target }: { target: ImageVulns } = $props();

  const s = $derived(imageSecuritySettings());
  const key = $derived(rowKey(target));
  const mine = $derived(imageScan.running?.key === key);
  const error = $derived(imageScan.errors.get(key)?.error ?? "");
  const why = $derived(notScannableText(target));
  const again = $derived(target.scanned && target.source === "local_scanner");
</script>

<div class="scan" data-testid="image-scan-action">
  {#if why}
    <p class="muted">{why}</p>
  {:else if mine}
    <p class="muted">Scanning with {scannerLabel(s.scanner)}… this can take a few minutes for a large image.</p>
    <button type="button" class="btn" data-testid="image-scan-cancel-one" onclick={cancelScan}>Cancel</button>
  {:else}
    {#if !target.scanned}
      <p class="muted">Not scanned yet. {scannerLabel(s.scanner)} on this computer can scan it by its digest.</p>
    {/if}
    <button
      type="button"
      class="btn"
      class:primary={!target.scanned}
      data-testid="image-scan-one"
      disabled={!!imageScan.running || !scannable(target)}
      onclick={() => scanImage(target, again)}>{again ? "Scan again" : `Scan with ${scannerLabel(s.scanner)}`}</button
    >
  {/if}
  {#if error && !mine}
    <p class="error-text" data-testid="image-scan-error">{error}</p>
  {/if}
</div>

<style>
  .scan {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    margin: 8px 0;
  }
  .scan p {
    margin: 0;
    font-size: 12px;
    overflow-wrap: anywhere;
  }
  .muted {
    color: var(--text-muted);
  }
</style>

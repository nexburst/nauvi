<script lang="ts">
  import type { Snippet } from "svelte";
  import { describeError, reportUiError } from "../uiErrors";

  /** Catches an error while rendering `children` (#208): it goes to the app
   *  log and this part of the window offers Try again instead of going
   *  blank. */
  let { children, area }: { children: Snippet; area: string } = $props();
</script>

<svelte:boundary onerror={(e) => reportUiError("boundary", e)}>
  {@render children()}
  {#snippet failed(error, reset)}
    <div class="failed" role="alert" data-testid="ui-error">
      <strong>The {area} stopped working.</strong>
      <span class="muted">{describeError(error).message}</span>
      <span class="muted">The error is in the app log (Help → Open log folder).</span>
      <button type="button" class="btn" onclick={reset}>Try again</button>
    </div>
  {/snippet}
</svelte:boundary>

<style>
  .failed {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    margin: 16px;
    padding: 12px 16px;
    border: 1px solid var(--red);
    border-radius: 6px;
    font-size: 13px;
    max-width: 640px;
  }
</style>

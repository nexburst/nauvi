<script lang="ts">
  import type { LiveDetail } from "../stores/live-detail.svelte";
  import { chart } from "../stores/chart.svelte";

  /** "This <kind> was deleted" and live-update problems, above a panel's body. */
  let { live, kind }: { live: LiveDetail; kind: string } = $props();
</script>

<!-- The verdict first: what the table says is wrong with this object. -->
{#if chart.verdict && !live.deleted}
  <p class="verdict" role="status" data-testid="verdict">
    <span class="mark" aria-hidden="true"></span>{chart.verdict}
  </p>
{/if}

{#if live.deleted && !live.info}
  <p class="notice deleted" role="status">This {kind} was deleted. There is nothing left to show.</p>
{:else if live.deleted}
  <p class="notice deleted" role="status">This {kind} was deleted. Showing its last known state.</p>
{:else if live.watchError && live.info}
  <p class="notice" role="status">{live.watchError}</p>
{/if}

<style>
  .verdict {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    padding: 7px 16px;
    font-size: 13px;
    font-weight: 600;
    color: var(--red);
    background: color-mix(in srgb, var(--red) 8%, transparent);
    border-bottom: 1px solid var(--border);
  }
  .mark {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--red);
    flex-shrink: 0;
  }
  .notice {
    margin: 0;
    padding: 8px 16px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
    color: var(--amber);
  }
  .deleted {
    color: var(--red);
    font-weight: 600;
  }
</style>

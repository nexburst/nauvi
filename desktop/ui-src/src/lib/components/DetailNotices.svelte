<script lang="ts">
  import type { LiveDetail } from "../stores/live-detail.svelte";
  import { chart } from "../stores/chart.svelte";
  import { detail } from "../stores/detail.svelte";
  import { openedByAi } from "../stores/links.svelte";
  import { goBack } from "../stores/navigation.svelte";
  import { history } from "../stores/history.svelte";

  /** "This <kind> was deleted" and live-update problems, above a panel's body. */
  let { live, kind }: { live: LiveDetail; kind: string } = $props();
</script>

<!-- `nauvi show` from this window's Ask AI terminal opened it (#548). -->
{#if openedByAi(detail.target)}
  <p class="by-ai" role="status" data-testid="opened-by-ai">
    <span>Opened by Ask AI</span>
    {#if history.canBack}
      <button type="button" class="back" onclick={goBack}>Back</button>
    {/if}
  </p>
{/if}

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
  .by-ai {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 0;
    padding: 5px 16px;
    font-size: 12px;
    color: var(--text-muted);
    background: color-mix(in srgb, var(--accent) 7%, transparent);
    border-bottom: 1px solid var(--border);
  }
  .back {
    border: 0;
    background: none;
    padding: 0;
    font: inherit;
    color: var(--accent);
    cursor: pointer;
  }
  .back:hover {
    text-decoration: underline;
  }
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

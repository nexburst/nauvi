<script lang="ts">
  import { app, refresh } from "../stores/app.svelte";
  import { offersRetry } from "../retry";
  import { outOfReach } from "../stores/outOfReach.svelte";

  // A connection error, or one whose retries stopped, offers Retry: the same
  // as Refresh (#526), unless the view shows its own Retry now. It sits
  // outside the alert, so the alert is the message.
  const retry = $derived(offersRetry(app.error, app.status.ok) && outOfReach.shown === 0);
</script>

{#if app.error}
  <div class="banner">
    <span class="message" role="alert">{app.error}</span>
    {#if retry}
      <button type="button" class="retry" data-testid="banner-retry" onclick={refresh}>Retry</button>
    {/if}
  </div>
{/if}

<style>
  /* One band, the width of the sheet. It says it once. */
  .banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 16px;
    font-size: 12.5px;
    background: color-mix(in srgb, var(--red) 12%, transparent);
    border-bottom: 1px solid color-mix(in srgb, var(--red) 40%, transparent);
    color: var(--error-text);
    animation: band 200ms var(--ease-out);
  }
  .banner::before {
    content: "";
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--red);
  }
  .message {
    flex: 1;
    min-width: 0;
  }
  .retry {
    flex-shrink: 0;
    padding: 2px 10px;
    font: inherit;
    font-weight: 600;
    color: var(--error-text);
    background: transparent;
    border: 1px solid color-mix(in srgb, var(--red) 55%, transparent);
    border-radius: 5px;
    cursor: pointer;
  }
  .retry:hover {
    background: color-mix(in srgb, var(--red) 14%, transparent);
  }
  .retry:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  @keyframes band {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
</style>

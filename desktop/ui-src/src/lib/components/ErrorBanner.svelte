<script lang="ts">
  import { app } from "../stores/app.svelte";
</script>

{#if app.error}
  <div class="banner" role="alert">{app.error}</div>
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
  @keyframes band {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }
</style>

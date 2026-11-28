<script lang="ts">
  import Icon from "../icons/Icon.svelte";

  /**
   * The deck of an overview (#605, #606): one headline, how things are, under
   * the line that says what it covers. Shared by the Overview and the
   * Workloads overview. `waiting`: the first summary has not arrived, the
   * mark breathes.
   */
  let {
    kicker,
    headline,
    calm,
    waiting = false,
  }: { kicker: string; headline: string; calm: boolean; waiting?: boolean } = $props();
</script>

<div class="deck" class:waiting>
  <span class="status-mark" class:calm aria-hidden="true">
    <Icon name={waiting ? "refresh" : calm ? "ok" : "warning"} size={22} />
  </span>
  <div class="summary">
    <span class="kicker" data-testid={waiting ? undefined : "deck-kicker"}>{kicker}</span>
    <h2 class="headline" data-testid={waiting ? undefined : "deck-headline"}>{headline}</h2>
  </div>
</div>

<style>
  .deck {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 16px;
  }
  .status-mark {
    --tone: var(--amber);
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 14%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 24%, transparent);
  }
  .status-mark.calm {
    --tone: var(--accent);
  }
  .waiting .status-mark {
    animation: breathe 1800ms ease-in-out infinite;
  }
  @keyframes breathe {
    50% {
      opacity: 0.45;
    }
  }
  .summary {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .kicker {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--text-muted);
  }
  .headline {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    letter-spacing: -0.022em;
    line-height: 1.15;
  }
</style>

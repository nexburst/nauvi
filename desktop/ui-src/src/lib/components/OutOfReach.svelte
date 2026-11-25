<script lang="ts">
  // The empty state of a view while the cluster does not answer (#462):
  // the header's word for it, where to read why, and a way to try now.
  import { refresh } from "../stores/app.svelte";

  interface Props {
    /** The header status text ("Cluster unreachable", "Reconnecting…"). */
    title: string;
  }
  let { title }: Props = $props();
</script>

<div class="out-of-reach" data-testid="out-of-reach">
  <svg viewBox="0 0 120 44" width="120" height="44" aria-hidden="true">
    <!-- A buoy adrift: its light is out. -->
    <g class="mark">
      <path d="M54 30l2-12h8l2 12z" class="body" />
      <path d="M55.3 24h9.4" class="band" />
      <path d="M60 18v-6" class="band" />
      <circle cx="60" cy="10.5" r="2" class="light" />
    </g>
    <path class="wave" d="M4 32c6-3 10-3 16 0s10 3 16 0 10-3 16 0 10 3 16 0 10-3 16 0 10 3 16 0 10-3 16 0" />
    <path class="wave far" d="M22 39c5-2 8-2 13 0s8 2 13 0 8-2 13 0 8 2 13 0 8-2 13 0" />
  </svg>
  <div class="text">
    <p class="title">{title}</p>
    <p class="hint">Nothing to show until the cluster answers. The banner above says what failed.</p>
    <button type="button" class="btn" data-testid="retry-now" onclick={refresh}>Retry now</button>
  </div>
</div>

<style>
  .out-of-reach {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 0;
  }
  .text {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    font-size: 13px;
    color: var(--text-muted);
  }
  p {
    margin: 0;
  }
  .title {
    color: var(--error-text);
    font-weight: 600;
  }
  .wave {
    fill: none;
    stroke: var(--text-muted);
    stroke-width: 1.5;
    stroke-linecap: round;
    opacity: 0.6;
  }
  .wave.far {
    opacity: 0.3;
  }
  .body {
    fill: var(--bg-hover);
    stroke: var(--text-muted);
    stroke-width: 1.2;
    stroke-linejoin: round;
  }
  .band {
    stroke: var(--text-muted);
    stroke-width: 1.2;
    fill: none;
  }
  .light {
    fill: none;
    stroke: var(--red);
    stroke-width: 1.2;
  }
  /* Tilted: adrift. */
  .mark {
    transform: rotate(-12deg);
    transform-origin: 60px 30px;
  }
</style>

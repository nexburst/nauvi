<script lang="ts">
  import type { Snippet } from "svelte";

  interface Props {
    /** A buoy (nothing to fix) or a lighthouse (nothing to warn about). */
    mark?: "buoy" | "lighthouse";
    children: Snippet;
  }
  let { mark = "buoy", children }: Props = $props();
</script>

<!-- An empty state: a calm horizon drawn once on arrival, then still. -->
<div class="calm-water">
  <svg viewBox="0 0 120 44" width="120" height="44" aria-hidden="true">
    {#if mark === "buoy"}
      <g class="mark">
        <path d="M54 30l2-12h8l2 12z" class="body" />
        <path d="M55.3 24h9.4" class="band" />
        <path d="M60 18v-6" class="mast" />
        <circle cx="60" cy="10.5" r="2" class="light" />
      </g>
    {:else}
      <g class="mark">
        <path d="M55 30l2-20h6l2 20z" class="body" />
        <path d="M56 22.5h8M56.6 16h6.8" class="band" />
        <path d="M56 10h8l-1-3h-6z" class="body" />
        <path d="M64 8.5l18-4v8z" class="beam" />
      </g>
    {/if}
    <path class="wave" pathLength="100" d="M4 32c6-3 10-3 16 0s10 3 16 0 10-3 16 0 10 3 16 0 10-3 16 0 10 3 16 0 10-3 16 0" />
    <path class="wave far" pathLength="100" d="M22 39c5-2 8-2 13 0s8 2 13 0 8-2 13 0 8 2 13 0 8-2 13 0" />
  </svg>
  <div class="text">{@render children()}</div>
</div>

<style>
  .calm-water {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 8px 0;
  }
  .text {
    color: var(--text-muted);
    font-size: 13px;
  }
  .wave {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-dasharray: 100;
    animation: draw 1400ms var(--ease-out) both;
  }
  .wave.far {
    opacity: 0.4;
    animation-delay: 160ms;
  }
  @keyframes draw {
    from {
      stroke-dashoffset: 100;
    }
  }
  .body {
    fill: var(--bg-hover);
    stroke: var(--text-muted);
    stroke-width: 1.2;
    stroke-linejoin: round;
  }
  .band,
  .mast {
    stroke: var(--text-muted);
    stroke-width: 1.2;
    fill: none;
  }
  .light {
    fill: var(--accent);
  }
  .beam {
    fill: var(--accent);
    opacity: 0.25;
  }
  /* The mark rises out of the water once. */
  .mark {
    animation: bob 900ms var(--ease-out) 200ms both;
  }
  @keyframes bob {
    from {
      transform: translateY(8px);
      opacity: 0;
    }
  }
</style>

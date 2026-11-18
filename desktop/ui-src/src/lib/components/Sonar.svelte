<script lang="ts">
  import { RINGS, fleet, type Blip } from "../sonar";

  interface Props {
    /** Problem pods, placed by name. */
    blips: Blip[];
    /** Problem pods that just cleared: a teal ring rises where they were. */
    recovered: Blip[];
    /** Healthy pods, as faint dots on the outer ring. */
    healthy: number;
    /** Changes whenever the picture does: one sweep per change, then still. */
    sweep: string;
    /** No data yet: the rings breathe until the first update. */
    loading?: boolean;
  }
  let { blips, recovered, healthy, sweep, loading = false }: Props = $props();

  const R = 92;
  const dots = $derived(fleet(healthy, R));
  const calm = $derived(!loading && blips.length === 0);
</script>

<svg
  class="sonar"
  class:loading
  class:calm
  viewBox="-100 -100 200 200"
  role="img"
  aria-label={loading
    ? "Waiting for the first update"
    : calm
      ? "Sonar: no problem pods"
      : `Sonar: ${blips.length} problem pod${blips.length === 1 ? "" : "s"}`}
>
  <defs>
    <radialGradient id="sonar-water" r="0.5">
      <stop offset="0" stop-color="var(--accent)" stop-opacity="0.16" />
      <stop offset="0.7" stop-color="var(--accent)" stop-opacity="0.04" />
      <stop offset="1" stop-color="var(--accent)" stop-opacity="0" />
    </radialGradient>
    <linearGradient id="sonar-beam" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="var(--accent)" stop-opacity="0" />
      <stop offset="1" stop-color="var(--accent)" stop-opacity="0.45" />
    </linearGradient>
  </defs>

  <circle r={R + 4} class="water" />
  {#each RINGS as f, i (f)}
    <circle r={R * f} class="ring" style:animation-delay="{i * 260}ms" />
  {/each}
  <!-- Bearings: four ticks and a faint cross. -->
  <path class="cross" d="M-{R} 0H{R}M0 -{R}V{R}" />
  {#each [0, 90, 180, 270] as deg (deg)}
    <path class="tick" d="M0 -{R + 4}V-{R - 3}" transform="rotate({deg})" />
  {/each}

  {#each dots as d, i (i)}
    <circle class="fleet" cx={d.x} cy={d.y} r="1.7" />
  {/each}

  {#if !loading}
    {#key sweep}
      <g class="sweep">
        <circle r={R} fill="transparent" />
        <path d="M0 0 L0 -{R} A{R} {R} 0 0 1 {(R * Math.sin(Math.PI / 4)).toFixed(2)} -{(R * Math.cos(Math.PI / 4)).toFixed(2)} Z" fill="url(#sonar-beam)" />
      </g>
    {/key}
  {/if}

  {#each recovered as b (b.key)}
    <circle class="rise" cx={b.x} cy={b.y} r="6" />
  {/each}
  {#each blips as b (b.key)}
    <g class="blip {b.tone}" transform="translate({b.x} {b.y})">
      <circle class="halo" r="7" />
      <circle r="3.2" />
    </g>
  {/each}

  <circle class="hub" r="3" />
</svg>

<style>
  .sonar {
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  .water {
    fill: url(#sonar-water);
    stroke: color-mix(in srgb, var(--accent) 30%, var(--border));
    stroke-width: 1;
  }
  .ring {
    fill: none;
    stroke: var(--border-strong);
    stroke-width: 0.8;
    stroke-dasharray: 2 3;
  }
  .cross {
    stroke: var(--border);
    stroke-width: 0.6;
  }
  .tick {
    stroke: var(--text-muted);
    stroke-width: 1.2;
  }
  .fleet {
    fill: var(--accent);
    opacity: 0.45;
  }
  .hub {
    fill: var(--accent);
  }
  .calm .hub {
    filter: drop-shadow(0 0 4px var(--accent));
  }

  /* One sweep per change, then the beam fades: nothing turns at rest. */
  .sweep {
    transform-box: fill-box;
    transform-origin: center;
    animation: sweep 1800ms var(--ease-in-out) both;
  }
  @keyframes sweep {
    0% {
      transform: rotate(0deg);
      opacity: 0;
    }
    12% {
      opacity: 1;
    }
    80% {
      opacity: 1;
    }
    100% {
      transform: rotate(360deg);
      opacity: 0;
    }
  }

  .blip circle {
    fill: var(--amber);
  }
  .blip.error circle {
    fill: var(--red);
  }
  .blip .halo {
    opacity: 0.18;
  }
  /* A new blip surfaces once; it stays still afterwards. */
  .blip {
    animation: surface 600ms var(--ease-out) both;
  }
  @keyframes surface {
    from {
      opacity: 0;
    }
  }

  /* Where a problem cleared: a teal ring rises and goes. */
  .rise {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.6;
    transform-box: fill-box;
    transform-origin: center;
    animation: rise 1400ms var(--ease-out) both;
  }
  @keyframes rise {
    from {
      transform: scale(0.6);
      opacity: 1;
    }
    to {
      transform: scale(3.2);
      opacity: 0;
    }
  }

  /* Only while waiting for the first update. */
  .loading .ring {
    animation: breathe 1600ms ease-in-out infinite;
  }
  @keyframes breathe {
    50% {
      stroke: var(--accent);
    }
  }
</style>

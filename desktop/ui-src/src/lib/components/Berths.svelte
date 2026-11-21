<script lang="ts">
  import { app, kinds, setView } from "../stores/app.svelte";
  import { berthCode, idCode, pinnable, viewLabel, BERTHS_MAX } from "../berths";
  import { chart, setChartPinned, toggleBerth, toggleChart } from "../stores/chart.svelte";
  import { problems } from "../stores/problems.svelte";

  /** A berth whose kind this cluster does not serve stays, dimmed. */
  const known = (view: string) => berthCode(view, kinds.all) !== "?";
  const here = $derived(app.view);
  /** The view on screen has no berth: it is offered one, never given one. */
  const adrift = $derived(pinnable(here) && !chart.berths.includes(here) && known(here));
</script>

{#snippet berth(view: string, n: number)}
  {@const label = viewLabel(view, kinds.all)}
  {@const badge = problems.byKind[view]}
  <div class="berth" class:active={here === view} class:unknown={!known(view)} data-testid="berth">
    <button
      type="button"
      class="go"
      aria-label={`Berth ${n}: ${label}`}
      aria-current={here === view ? "page" : undefined}
      aria-disabled={!known(view)}
      title={`${label}${badge ? `: ${badge.count} need attention` : ""} (${n})`}
      onclick={() => known(view) && setView(view)}
      oncontextmenu={(e) => {
        if (view === "overview") return;
        e.preventDefault();
        toggleBerth(view);
      }}
    >
      <span class="key" aria-hidden="true">{n}</span>
      <span class="code">{known(view) ? berthCode(view, kinds.all) : idCode(view)}</span>
      {#if badge}
        {#key badge.count}<span class="pip" aria-hidden="true">{badge.count}</span>{/key}
      {/if}
    </button>
    {#if view !== "overview"}
      <button type="button" class="drop" aria-label={`Remove the ${label} berth`} title="Remove this berth" onclick={() => toggleBerth(view)}
        >✕</button
      >
    {/if}
  </div>
{/snippet}

<!-- The berths: the places kept at hand, by their kubectl names. Fixed
     width, at most nine, each removable; only the user adds one. -->
<div class="berths" class:slim={chart.pinned} role="group" aria-label="Berths" data-testid="berths">
  <!-- With the kinds kept open as a column, that column is the way around:
       only the handle that floats it again is left. -->
  {#if !chart.pinned}
    {@render berth("overview", 1)}
    {#each chart.berths as view, i (view)}
      {@render berth(view, i + 2)}
    {/each}
  {/if}
  {#if adrift && !chart.pinned}
    <!-- Where you are, without a berth: one click (or P) keeps it. -->
    {#key chart.fullNonce}
      <button
        type="button"
        class="adrift"
        class:full={chart.berths.length >= BERTHS_MAX}
        aria-label={`Keep ${viewLabel(here, kinds.all)} in a berth`}
        title={chart.berths.length >= BERTHS_MAX
          ? `All ${BERTHS_MAX} berths are taken: remove one first`
          : `Keep ${viewLabel(here, kinds.all)} at hand (P)`}
        data-testid="berth-keep"
        onclick={() => toggleBerth(here)}
      >
        <span class="code">{berthCode(here, kinds.all)}</span>
        <span class="plus" aria-hidden="true">+</span>
      </button>
    {/key}
  {/if}
  <span class="gap"></span>
  {#if chart.pinned}
    <button
      type="button"
      class="tool"
      aria-label="Float the chart"
      title="Hide the column of kinds: open it with G instead"
      data-testid="chart-unpin"
      onclick={() => setChartPinned(false)}
    >
      <svg viewBox="0 0 8 16" width="8" height="16" aria-hidden="true"><path d="M6 3L2 8l4 5" /></svg>
    </button>
  {:else}
    <button
      type="button"
      class="tool"
      class:on={chart.open}
      aria-label="Chart of kinds"
      aria-expanded={chart.open}
      title="Every kind of this cluster (G)"
      data-testid="chart-toggle"
      onclick={toggleChart}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path class="needle" d="M15.5 8.5l-2 5-5 2 2-5z" />
      </svg>
      <span class="key" aria-hidden="true">G</span>
    </button>
  {/if}
</div>

<style>
  .berths {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    width: 48px;
    background: var(--bg-sunken);
    border-right: 1px solid var(--border);
    overflow: hidden;
  }
  .berths.slim {
    width: 14px;
  }
  .berths.slim .tool {
    flex: 1;
    border-top: none;
    color: var(--text-muted);
  }
  .berths.slim .gap {
    display: none;
  }
  button {
    background: transparent;
    border: none;
    padding: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .berth {
    position: relative;
    border-bottom: 1px solid var(--border);
    color: var(--text-muted);
    transition:
      background-color 140ms ease,
      color 140ms ease;
  }
  .go {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    width: 100%;
    height: 46px;
  }
  .berth:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .code {
    font-family: var(--font-num);
    font-size: 11.5px;
    font-weight: 600;
    letter-spacing: 0.02em;
  }
  /* Its number: the key that goes there. */
  .key {
    position: absolute;
    top: 3px;
    left: 5px;
    font-family: var(--font-num);
    font-size: 8.5px;
    opacity: 0.55;
  }
  /* You are here: filled like the sheet, a teal bar on the outer edge. */
  .berth.active {
    background: var(--bg);
    color: var(--text);
  }
  .berth.active::before {
    content: "";
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 2px;
    background: var(--accent);
    animation: moor 240ms var(--ease-out);
  }
  @keyframes moor {
    from {
      transform: scaleY(0.2);
    }
  }
  .berth.unknown {
    opacity: 0.4;
  }
  .pip {
    min-width: 16px;
    padding: 0 4px;
    border-radius: 8px;
    background: var(--red);
    color: var(--bg-sunken);
    font-family: var(--font-num);
    font-size: 9.5px;
    font-weight: 600;
    line-height: 14px;
    text-align: center;
    animation: pip 420ms var(--ease-out);
  }
  @keyframes pip {
    0% {
      transform: scale(0.5);
    }
    55% {
      transform: scale(1.2);
    }
  }
  /* The way out of a berth: shown on hover or keyboard focus. */
  .drop {
    position: absolute;
    top: 1px;
    right: 1px;
    width: 14px;
    height: 14px;
    font-size: 8px;
    line-height: 14px;
    border-radius: 3px;
    color: var(--text-muted);
    opacity: 0;
  }
  .berth:hover .drop,
  .drop:focus-visible {
    opacity: 1;
  }
  .drop:hover {
    background: var(--red);
    color: var(--bg-sunken);
  }
  .adrift {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    height: 46px;
    margin: 4px;
    border: 1px dashed var(--border-strong);
    border-radius: 4px;
    color: var(--text);
  }
  .adrift:hover {
    border-color: var(--accent);
    color: var(--accent);
  }
  .plus {
    font-size: 11px;
    line-height: 1;
    color: var(--accent);
  }
  /* Refused: every berth is taken. A short shake says so. */
  .adrift.full {
    animation: refuse 320ms var(--ease-out);
  }
  .adrift.full .plus {
    color: var(--text-muted);
  }
  @keyframes refuse {
    25% {
      transform: translateX(-3px);
    }
    60% {
      transform: translateX(3px);
    }
  }
  .gap {
    flex: 1;
  }
  .tool {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 44px;
    border-top: 1px solid var(--border);
    color: var(--accent);
  }
  .tool:hover,
  .tool.on {
    background: var(--accent-soft);
  }
  .tool svg {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .needle {
    fill: currentColor;
    stroke: none;
    transform-origin: 12px 12px;
    transition: transform 420ms var(--ease-out);
  }
  .tool.on .needle {
    transform: rotate(180deg);
  }
</style>

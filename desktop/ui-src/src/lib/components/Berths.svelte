<script lang="ts">
  import { app, kinds, setView } from "../stores/app.svelte";
  import { berthCode, idCode, pinnable, viewLabel, BERTHS_MAX } from "../berths";
  import { chart, setChartPinned, toggleBerth, toggleChart } from "../stores/chart.svelte";
  import { problems } from "../stores/problems.svelte";
  import { viewIcon } from "../kindIcons";
  import Icon from "../icons/Icon.svelte";

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
      <Icon name={viewIcon(view, kinds.all)} size={18} />
      <span class="code">{known(view) ? berthCode(view, kinds.all) : idCode(view)}</span>
      {#if badge}
        {#key badge.count}<span class="pip" aria-hidden="true">{badge.count}</span>{/key}
      {/if}
    </button>
    {#if view !== "overview"}
      <button type="button" class="drop" aria-label={`Remove the ${label} berth`} title="Unpin" onclick={() => toggleBerth(view)}
        >✕</button
      >
    {/if}
  </div>
{/snippet}

<!-- The berths: the sidebar collapsed to a rail of icons (#481), with the
     places kept at hand (pinned). Fixed width, at most nine, each
     removable; only the user adds one. Kept open as a column, the sidebar
     is the way around and the rail is gone. -->
{#if !chart.pinned}
  <div class="berths" role="group" aria-label="Berths" data-testid="berths">
    {@render berth("overview", 1)}
    {#each chart.berths as view, i (view)}
      {@render berth(view, i + 2)}
    {/each}
    {#if adrift}
      <!-- Where you are, without a berth: one click (or P) keeps it. -->
      {#key chart.fullNonce}
        <button
          type="button"
          class="adrift"
          class:full={chart.berths.length >= BERTHS_MAX}
          aria-label={`Keep ${viewLabel(here, kinds.all)} in a berth`}
          title={chart.berths.length >= BERTHS_MAX
            ? `All ${BERTHS_MAX} pins are taken: unpin one first`
            : `Pin ${viewLabel(here, kinds.all)} here (P)`}
          data-testid="berth-keep"
          onclick={() => toggleBerth(here)}
        >
          <Icon name={viewIcon(here, kinds.all)} size={18} />
          <span class="code">{berthCode(here, kinds.all)}</span>
          <span class="plus" aria-hidden="true">+</span>
        </button>
      {/key}
    {/if}
    <span class="gap"></span>
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
      <svg class="compass" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path class="needle" d="M15.5 8.5l-2 5-5 2 2-5z" />
      </svg>
      <span class="tool-label" aria-hidden="true">All kinds</span>
      <span class="key" aria-hidden="true">G</span>
    </button>
    <button
      type="button"
      class="expand"
      aria-label="Expand the sidebar"
      title="Keep every kind open as a column"
      data-testid="sidebar-expand"
      onclick={() => setChartPinned(true)}><Icon name="sidebarExpand" size={16} /></button
    >
  </div>
{/if}

<style>
  .berths {
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
    width: 56px;
    background: var(--bg-sunken);
    border-right: 1px solid var(--border);
    overflow: hidden;
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
    height: 50px;
  }
  .berth:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  /* Under the icon, kubectl's short name: the narrow form of its name. */
  .code {
    font-family: var(--font-num);
    font-size: 10.5px;
    font-weight: 500;
    line-height: 1;
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
    position: absolute;
    top: 4px;
    right: 6px;
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
    position: absolute;
    top: 2px;
    right: 5px;
    font-size: 12px;
    font-weight: 600;
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
  /* Every kind, labelled (#490): where the rest of the cluster is. */
  .tool {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;
    height: 54px;
    border-top: 1px solid var(--border);
    color: var(--accent);
  }
  .tool-label {
    font-size: 10.5px;
    font-weight: var(--weight-semibold);
    line-height: 1;
    white-space: nowrap;
  }
  .tool .key {
    top: 4px;
    left: auto;
    right: 6px;
  }
  .expand {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 34px;
    border-top: 1px solid var(--border);
    color: var(--text-muted);
  }
  .expand:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .tool:hover,
  .tool.on {
    background: var(--accent-soft);
  }
  .tool .compass {
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

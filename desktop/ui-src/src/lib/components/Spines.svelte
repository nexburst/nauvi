<script lang="ts">
  import { app, kinds, openObject, setView } from "../stores/app.svelte";
  import { chart, setChartPinned, spineTicks, toggleChart } from "../stores/chart.svelte";
  import { detail } from "../stores/detail.svelte";
  import { problems } from "../stores/problems.svelte";
  import { stepId, viewLabel, type Step, type Tick } from "../trail";

  const kindOf = (view: string) => kinds.all.find((k) => k.id === view);

  function isActive(s: Step): boolean {
    if (app.view !== s.view) return false;
    const t = detail.target;
    if (!s.object) return !t || !chart.trail.some((o) => o.object && sameObject(o, t));
    return !!t && sameObject(s, t);
  }
  const sameObject = (s: Step, t: { namespace: string; name: string }) =>
    s.object?.namespace === t.namespace && s.object?.name === t.name;

  function go(s: Step) {
    const kind = kindOf(s.view);
    if (s.object && kind) openObject(kind, s.object.namespace, s.object.name);
    else setView(s.view);
  }

  /** An object's state, from its row's tick on its view's spine. */
  const toneOf = (s: Step) =>
    spineTicks.byView[s.view]?.find((t) => t.namespace === s.object?.namespace && t.name === s.object?.name)?.tone;

  function goTick(e: MouseEvent, view: string, t: Tick) {
    e.stopPropagation();
    const kind = kindOf(view);
    if (kind) openObject(kind, t.namespace, t.name);
  }
</script>

<!-- The wake: the path you took, as live spines. A view's spine carries a
     tick per object, coloured by its state; an object opened from it follows
     as a spine of its own. The first spine summons the chart of kinds. -->
<div class="spines" class:pinned={chart.pinned} role="group" aria-label="Wake" data-testid="wake">
  {#if chart.pinned}
    <button
      type="button"
      class="spine chart handle"
      aria-label="Float the chart"
      title="Unpin the chart: summon it with G instead"
      data-testid="chart-unpin"
      onclick={() => setChartPinned(false)}
    >
      <svg viewBox="0 0 8 16" width="8" height="16" aria-hidden="true"><path d="M6 3L2 8l4 5" /></svg>
    </button>
  {:else}
    <button
      type="button"
      class="spine chart"
      class:on={chart.open}
      aria-label="Chart of kinds"
      aria-expanded={chart.open}
      title="Chart: every kind of this cluster (G)"
      data-testid="chart-toggle"
      onclick={toggleChart}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path class="needle" d="M15.5 8.5l-2 5-5 2 2-5z" />
      </svg>
    </button>
  {/if}
  {#each chart.pinned ? [] : chart.trail as step (stepId(step))}
    {@const label = step.object ? step.object.name : viewLabel(step.view, kinds.all)}
    {@const badge = step.object ? undefined : problems.byKind[step.view]}
    {@const ticks = step.object ? [] : (spineTicks.byView[step.view] ?? [])}
    <div
      class="spine"
      class:object={!!step.object}
      class:warn={step.object && toneOf(step) === "warn"}
      class:bad={step.object && toneOf(step) === "bad"}
      class:active={isActive(step)}
      class:trouble={!!badge}
      data-testid="spine"
    >
      <button
        type="button"
        class="head"
        aria-label={`Wake: ${label}`}
        aria-current={isActive(step) ? "page" : undefined}
        title={badge ? `${label}: ${badge.count} need attention` : label}
        onclick={() => go(step)}
      >
        {#if badge}
          {#key badge.count}<span class="pip" aria-hidden="true">{badge.count}</span>{/key}
        {/if}
        <span class="name">{label}</span>
      </button>
      {#if ticks.length > 0}
        <!-- As last seen: the rows of this view, top to bottom. -->
        <div class="ticks" aria-hidden="true">
          {#each ticks as t (t.namespace + "/" + t.name)}
            <button
              type="button"
              class="tick {t.tone}"
              tabindex="-1"
              title={`${t.namespace ? `${t.namespace}/` : ""}${t.name}`}
              onclick={(e) => goTick(e, step.view, t)}
            ></button>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .spines {
    display: flex;
    flex-shrink: 0;
    background: var(--bg-sunken);
    border-right: 1px solid var(--border);
  }
  .spine {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 34px;
    min-height: 0;
    border-right: 1px solid var(--border);
    color: var(--text-muted);
    overflow: hidden;
    transition:
      background-color 600ms ease,
      color 600ms ease;
    /* A new spine folds out of the sheet's edge. */
    animation: fold 200ms var(--ease-out);
  }
  .spine:last-child {
    border-right: none;
  }
  @keyframes fold {
    from {
      width: 0;
      opacity: 0;
    }
  }
  button {
    background: transparent;
    border: none;
    padding: 0;
    color: inherit;
    cursor: pointer;
  }
  /* Every spine's head is the same height, so the ticks of all of them
     start on one line. */
  .head {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 150px;
    padding: 12px 0 10px;
    flex-shrink: 0;
    overflow: hidden;
  }
  .spine:hover {
    background: var(--bg-hover);
    color: var(--text);
  }
  .name {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    font-family: var(--font-num);
    font-size: 10.5px;
    font-weight: 500;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    white-space: nowrap;
  }
  /* An object's spine: narrower, a step in from its view, its name in the
     colour of its state. */
  .spine.object {
    width: 28px;
  }
  .spine.object .name {
    letter-spacing: 0.08em;
  }
  .spine.object.warn .name {
    color: var(--amber);
  }
  .spine.object.bad .name {
    color: var(--red);
  }
  /* You are here: the one spine that is filled like the sheet, capped teal.
     Trouble is never an edge: it is the count and the coral ticks. */
  .spine.active {
    color: var(--text);
    background: var(--bg);
  }
  .spine.active::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--accent);
  }
  /* Pinned: the column is the way around; only a slim handle is left. */
  .handle {
    width: 14px;
    justify-content: center;
    color: var(--text-muted);
  }
  .handle:hover {
    color: var(--accent);
  }
  .pip {
    min-width: 18px;
    padding: 1px 4px;
    border-radius: 9px;
    background: var(--red);
    color: var(--bg-sunken);
    font-family: var(--font-num);
    font-size: 10px;
    font-weight: 600;
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
  .ticks {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0;
    padding: 6px 0 10px;
    min-height: 0;
    overflow: hidden;
    border-top: 1px solid var(--border);
  }
  /* A 9px target around a 5px mark, readable from across the desk. */
  .tick {
    --tone: color-mix(in srgb, var(--accent) 50%, transparent);
    flex-shrink: 0;
    width: 100%;
    height: 9px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .tick::before {
    content: "";
    width: 18px;
    height: 5px;
    border-radius: 1px;
    background: var(--tone);
    transition:
      background-color 600ms ease,
      width 160ms var(--ease-out);
  }
  .tick.warn {
    --tone: var(--amber);
  }
  .tick.bad {
    --tone: var(--red);
  }
  .tick:hover::before {
    width: 24px;
    background: var(--text);
  }
  .chart {
    align-items: center;
    padding: 11px 0;
    color: var(--accent);
    cursor: pointer;
    flex-shrink: 0;
  }
  .chart svg {
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
  /* The needle swings round while the chart is out. */
  .chart.on .needle {
    transform: rotate(180deg);
  }
  .chart.on {
    background: var(--accent-soft);
  }
</style>

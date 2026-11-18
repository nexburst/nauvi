<script lang="ts">
  import { BADGES, calmFor, recentHours, streakText } from "../watch";
  import { watch } from "../stores/watch.svelte";

  interface Props {
    /** The Overview's clock (it already ticks for the event ages). */
    now: number;
  }
  let { now }: Props = $props();

  const log = $derived(watch.log);
  const calm = $derived(calmFor(log, now));
  const hours = $derived(recentHours(log, now));

  function hourTitle(start: number, mark: string | null): string {
    const h = new Date(start).getHours();
    const range = `${String(h).padStart(2, "0")}:00`;
    return mark === null ? `${range}: not watched` : `${range}: ${mark}`;
  }
</script>

<!-- One glyph per insignia, drawn on a brass plate. -->
{#snippet glyph(id: string)}
  {#if id === "first-light"}
    <path d="M5 15h14M8 15a4 4 0 0 1 8 0M12 7v2M7 9.5l1.2 1.2M17 9.5l-1.2 1.2" />
  {:else if id === "steady-hand"}
    <path d="M12 6v12M9 8h6M6.5 13a5.5 5 0 0 0 11 0M6.5 13l-1 1M17.5 13l1 1" /><circle cx="12" cy="5" r="1.4" />
  {:else if id === "calm-hour"}
    <circle cx="12" cy="12" r="6" /><path d="M12 8.5V12l2.5 1.5" />
  {:else if id === "clear-decks"}
    <path d="M5 14c2 1.5 4 1.5 7 0s5-1.5 7 0" /><path d="M8.5 10.5l2.2 2L15.5 8" />
  {:else}
    <path d="M14.5 6.5a6 6 0 1 0 3 9.5 5 5 0 0 1-3-9.5z" /><path d="M17 6.5l.5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5z" />
  {/if}
{/snippet}

<section class="log" aria-label="Watch log">
  <div class="top">
    <span class="eyebrow">Watch log</span>
    <span class="today eyebrow" title="Problem pods that left the list today">
      {log.clearedToday} cleared today
    </span>
  </div>

  <div class="streak" class:calm={log.calmSince !== null}>
    {#if log.calmSince !== null}
      <span class="value" data-testid="calm-streak">{streakText(calm)}</span>
      <span class="caption">calm on deck</span>
    {:else}
      <span class="value" data-testid="calm-streak">{streakText(log.bestCalm)}</span>
      <span class="caption">best calm streak</span>
    {/if}
  </div>

  <!-- The last twelve hours: calm, rough, or not watched. -->
  <div class="hours" aria-label="The last twelve hours">
    {#each hours as h (h.start)}
      <span class="hour {h.mark ?? 'none'}" title={hourTitle(h.start, h.mark)}></span>
    {/each}
  </div>

  <ul class="insignia" aria-label="Insignia">
    {#each BADGES as b (b.id)}
      {@const earned = !!log.badges[b.id]}
      {@const p = b.progress(log, now)}
      <li
        class="badge"
        class:earned
        class:fresh={watch.earned?.id === b.id}
        title={earned ? `${b.title}: earned` : `${b.title}: ${b.how} (${p.text})`}
      >
        {#key watch.earned?.id === b.id ? watch.earnedNonce : 0}
          <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
            <path class="plate" d="M12 1.8l8.8 5.1v10.2L12 22.2l-8.8-5.1V6.9z" />
            {#if !earned}
              <!-- The plate fills in as it gets closer. -->
              <path
                class="meter"
                pathLength="100"
                stroke-dasharray="{p.value * 100} 100"
                d="M12 1.8l8.8 5.1v10.2L12 22.2l-8.8-5.1V6.9z"
              />
            {/if}
            <g class="glyph">{@render glyph(b.id)}</g>
          </svg>
        {/key}
        <span class="sr">{b.title}{earned ? ", earned" : `, ${p.text}`}</span>
      </li>
    {/each}
  </ul>
  {#if watch.earned}
    <p class="earned-note">Earned <strong>{watch.earned.title}</strong>: {watch.earned.how.toLowerCase()}.</p>
  {/if}
</section>

<style>
  .log {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 14px 16px;
    border-radius: 12px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    min-width: 0;
  }
  .top {
    display: flex;
    justify-content: space-between;
    gap: 8px;
  }
  .today {
    color: var(--brass);
  }
  .streak {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }
  .value {
    font-family: var(--font-num);
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.01em;
    color: var(--text-muted);
  }
  .streak.calm .value {
    color: var(--accent);
  }
  .caption {
    color: var(--text-muted);
    font-size: 12px;
  }
  .hours {
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    gap: 3px;
  }
  .hour {
    height: 10px;
    border-radius: 2px;
    background: var(--bg-hover);
  }
  .hour.calm {
    background: color-mix(in srgb, var(--accent) 55%, transparent);
  }
  .hour.rough {
    background: color-mix(in srgb, var(--amber) 60%, transparent);
  }
  .insignia {
    display: flex;
    gap: 6px;
    margin: 2px 0 0;
    padding: 0;
    list-style: none;
  }
  .badge {
    position: relative;
    display: flex;
  }
  .plate {
    fill: var(--bg-hover);
    stroke: var(--border-strong);
    stroke-width: 1;
  }
  .meter {
    fill: none;
    stroke: var(--brass);
    stroke-width: 1.4;
    stroke-linecap: round;
    opacity: 0.7;
  }
  .glyph {
    fill: none;
    stroke: var(--text-muted);
    stroke-width: 1.4;
    stroke-linecap: round;
    stroke-linejoin: round;
    opacity: 0.55;
  }
  .earned .plate {
    fill: var(--brass-soft);
    stroke: var(--brass);
  }
  .earned .glyph {
    stroke: var(--brass);
    opacity: 1;
  }
  /* Just earned: the plate turns over once and glints. */
  .fresh svg {
    animation: earn 900ms var(--ease-out);
  }
  @keyframes earn {
    0% {
      transform: scale(0.6) rotate(-30deg);
      filter: brightness(2);
    }
    60% {
      transform: scale(1.12) rotate(4deg);
    }
  }
  .earned-note {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
  }
  .earned-note strong {
    color: var(--brass);
    font-weight: 600;
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>

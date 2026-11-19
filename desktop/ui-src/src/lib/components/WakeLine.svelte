<script lang="ts">
  import { recentHours, recentKnots } from "../watch";
  import { watch } from "../stores/watch.svelte";
  import { settings } from "../stores/settings.svelte";
  import { hhmmss } from "../timeZone";

  const HOURS = 12;
  // Redrawn when the log changes (an Overview update), never on a timer.
  const now = $derived(watch.log.lastSeen || Date.now());
  const hours = $derived(recentHours(watch.log, now, HOURS));
  const knots = $derived(recentKnots(watch.log, now, HOURS));
  const zone = $derived(settings.current.time_zone);
  /** Where "now" sits on the line (0–1). */
  const nowAt = $derived((now - hours[0].start) / (HOURS * 3_600_000));
  const hourLabel = (start: number) => `${String(new Date(start).getHours()).padStart(2, "0")}h`;
  /** What the footer says while a knot is under the pointer. */
  let told = $state("");
</script>

<!-- The wake line: your last twelve hours on this cluster. Calm hours run
     level in teal, rough ones dip in amber, and every problem that cleared
     is a knot of brass where it happened. -->
<span class="wake" data-testid="wake-line" role="img" aria-label={`The last ${HOURS} hours: ${knots.length} problems cleared`}>
  <span class="line">
    {#each hours as h, i (h.start)}
      <span class="hour {h.mark ?? 'none'}" title={`${hourLabel(h.start)}: ${h.mark ?? "not watched"}`}>
        {#if i % 3 === 0}<span class="label" data-h={hourLabel(h.start)}></span>{/if}
      </span>
    {/each}
    {#each knots as k (k.key + k.at)}
      <span
        class="knot"
        style:left="{(k.at01 * 100).toFixed(2)}%"
        role="presentation"
        onmouseenter={() => (told = `${k.key} cleared ${hhmmss(k.at, zone).slice(0, 5)}`)}
        onmouseleave={() => (told = "")}
      ></span>
    {/each}
    <span class="now" style:left="{(Math.min(1, nowAt) * 100).toFixed(2)}%"></span>
  </span>
  {#if told}<span class="told" data-testid="wake-told">{told}</span>{/if}
</span>

<style>
  .wake {
    position: relative;
    flex: 1;
    min-width: 120px;
    display: flex;
    align-items: center;
  }
  .line {
    position: relative;
    flex: 1;
    display: grid;
    grid-template-columns: repeat(12, 1fr);
    height: 14px;
  }
  .hour {
    position: relative;
    border-left: 1px solid var(--border);
  }
  /* The water of each hour: level when calm, lower and amber when rough. */
  .hour::after {
    content: "";
    position: absolute;
    left: 1px;
    right: 0;
    top: 6px;
    height: 1px;
    background: var(--border);
    transition:
      background-color 600ms ease,
      top 600ms var(--ease-out);
  }
  .hour.calm::after {
    background: var(--accent);
  }
  .hour.rough::after {
    top: 10px;
    height: 2px;
    background: var(--amber);
  }
  /* Drawn, not text: the footer still reads as its status line. */
  .label::before {
    content: attr(data-h);
    position: absolute;
    left: 3px;
    top: -4px;
    font-size: 9px;
    color: var(--text-muted);
    pointer-events: none;
  }
  .now {
    position: absolute;
    top: 1px;
    bottom: 1px;
    width: 1px;
    background: var(--text);
  }
  .knot {
    position: absolute;
    top: 3px;
    width: 7px;
    height: 7px;
    margin-left: -3.5px;
    transform: rotate(45deg);
    background: var(--brass);
    box-shadow: 0 0 0 2px var(--bg-sunken);
    animation: tie 600ms var(--ease-out);
  }
  .knot:hover {
    background: var(--text);
  }
  @keyframes tie {
    from {
      transform: translateY(-14px) rotate(45deg) scale(0.3);
      opacity: 0;
    }
  }
  /* A knot under the pointer says what it marks, over the line. */
  .told {
    position: absolute;
    inset: -3px 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--bg-sunken);
    color: var(--brass);
    pointer-events: none;
  }
</style>

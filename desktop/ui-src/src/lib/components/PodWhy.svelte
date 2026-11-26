<script lang="ts">
  import { onDestroy } from "svelte";
  import type { LogContainer, ResourceRef } from "../bindings";
  import { onAgeTick } from "../ageClock";
  import { eventHeadline, reasonWords } from "../eventText";
  import { ageRedrawMs, eventTimes } from "../format";
  import Icon from "../icons/Icon.svelte";
  import type { PodWhy } from "../podWhy";
  import { openDockTab } from "../stores/dock.svelte";
  import { askLogs } from "../stores/logAsk.svelte";

  /** "Why it's failing" (#496): the top of a failing pod's panel, so the
   *  reason shows without scrolling to the containers and events. */
  let {
    why,
    pod,
    logContainers,
    events,
    onEvents,
    disabled = false,
  }: {
    why: PodWhy;
    pod: { resource: ResourceRef; namespace: string; name: string };
    logContainers: LogContainer[];
    /** How many events the panel lists, for the jump to them. */
    events: number;
    onEvents: () => void;
    disabled?: boolean;
  } = $props();

  let now = $state.raw(Date.now());
  onDestroy(
    onAgeTick((t) => {
      if (t - now >= ageRedrawMs(why.warning?.time ?? 0, t) - 50) now = t;
    }),
  );

  /** "Container app · CrashLoopBackOff": where, and the state's own name. */
  const facts = $derived([why.container && `Container ${why.container}`, why.reason].filter(Boolean).join(" · "));
  const warningLine = $derived(why.warning ? eventHeadline(why.warning.reason, why.warning.message) : "");
  /** The warning says what the headline says: only its reason and times then. */
  const warningSame = $derived(!!warningLine && why.headline.toLowerCase().includes(warningLine.toLowerCase()));

  function logs(previous: boolean) {
    if (disabled) return;
    if (why.container) askLogs(pod.namespace, pod.name, why.container, previous);
    openDockTab({ type: "podLogs", pod: { ...pod }, containers: $state.snapshot(logContainers) });
  }
</script>

<section class="why" aria-labelledby="pod-why-title" data-testid="pod-why">
  <h3 id="pod-why-title"><Icon name="error" size={15} /> Why it's failing</h3>
  <p class="headline" data-testid="pod-why-headline">{why.headline}</p>
  {#if facts}<p class="facts muted">{facts}</p>{/if}
  {#if why.lastRun}<p class="last" data-testid="pod-why-last">{why.lastRun}</p>{/if}
  {#if why.termination}
    <pre class="termination" data-testid="pod-why-termination" title={why.termination}>{why.termination}</pre>
  {/if}
  {#if why.detail}
    <!-- The raw message the headline sums up: folded to two lines, whole in its tooltip. -->
    <p class="detail muted mono" title={why.detail}>{why.detail}</p>
  {/if}
  {#if why.warning}
    {@const w = why.warning}
    <p class="warning" data-testid="pod-why-warning">
      <Icon name="warning" size={13} />
      <span>
        <strong title={w.reason}>{reasonWords(w.reason, w.message)}</strong>{#if !warningSame}: {warningLine}{/if}
        <span class="muted">· {eventTimes(w.count, w.time, now, w.age)}</span>
      </span>
    </p>
  {/if}
  <div class="actions">
    <button type="button" class="btn" {disabled} onclick={() => logs(false)}><Icon name="logs" size={14} /> Logs</button>
    {#if why.previous}
      <button type="button" class="btn" {disabled} onclick={() => logs(true)} title="The run before the current one"
        >Previous logs</button
      >
    {/if}
    {#if events > 0}
      <button type="button" class="link events" onclick={onEvents}>Events ({events}) ↓</button>
    {/if}
  </div>
</section>

<style>
  .why {
    margin: 0 0 12px;
    padding: 10px 12px;
    border: 1px solid color-mix(in srgb, var(--red) 35%, var(--border));
    border-left: 3px solid var(--red);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--red) 6%, var(--bg-raised));
    font-size: 12px;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: var(--weight-semibold);
    color: var(--red);
  }
  p {
    margin: 0 0 4px;
  }
  .headline {
    font-size: 13px;
    font-weight: var(--weight-semibold);
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .facts,
  .last {
    font-size: 12px;
  }
  .termination {
    margin: 4px 0;
    padding: 6px 8px;
    max-height: 5.4em;
    overflow: hidden;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 11px;
    border-radius: 6px;
    background: var(--bg);
    border: 1px solid var(--border);
  }
  .detail {
    font-size: 11px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .warning {
    display: flex;
    gap: 6px;
    align-items: baseline;
    margin-top: 6px;
    overflow-wrap: anywhere;
    color: var(--text);
  }
  .warning :global(svg) {
    flex-shrink: 0;
    color: var(--amber);
    transform: translateY(2px);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 8px;
    flex-wrap: wrap;
  }
  .actions .btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
  }
  .link {
    background: transparent;
    border: none;
    color: var(--accent);
    padding: 0;
    font: inherit;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .events {
    margin-left: auto;
  }
</style>

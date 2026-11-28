<script lang="ts">
  import type { Snippet } from "svelte";
  import type { EventInfo } from "../bindings";
  import { kinds, openObject, openWithStatus } from "../stores/app.svelte";
  import { eventKind } from "../overview";
  import { formatDuration } from "../format";
  import {
    groupWarnings,
    stripPodIds,
    timesText,
    warningReason,
    warningSubject,
    warningSummary,
    type WarningGroup,
  } from "../warningGroups";
  import Icon from "../icons/Icon.svelte";
  import CalmWater from "./CalmWater.svelte";

  /**
   * Warning groups (#605): warning events with one reason on the objects of
   * one owner, one line each, at most `limit`; "See all warnings" opens
   * Events filtered to warnings. Shared by the Overview and the Workloads
   * overview. `actions` adds buttons to each row (#607).
   */
  let {
    events,
    now,
    limit = 5,
    actions,
  }: { events: readonly EventInfo[]; now: number; limit?: number; actions?: Snippet<[WarningGroup]> } = $props();

  const all = $derived(groupWarnings(events));
  const groups = $derived(all.slice(0, limit));
  const eventsKind = $derived(
    kinds.all.find((k) => k.id === "v1/events") ?? kinds.all.find((k) => k.resource.kind === "Event"),
  );
  let open = $state<Record<string, boolean>>({});

  function openObjectOf(e: EventInfo) {
    const kind = eventKind(e, kinds.all);
    if (kind) openObject(kind, kind.resource.namespaced ? e.object_namespace : "", e.object_name);
  }

  const ago = (time: number) => (time > 0 ? `${formatDuration(now - time * 1000)} ago` : "");

  /** The distinct objects of a group, newest first. */
  function objectsOf(g: WarningGroup): EventInfo[] {
    const seen = new Set<string>();
    return g.events.filter((e) => {
      const k = `${e.object_kind}/${e.object_namespace}/${e.object_name}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
</script>

{#if groups.length === 0}
  <div class="empty"><CalmWater mark="lighthouse"><p class="none">No warnings.</p></CalmWater></div>
{:else}
  <ul class="row-list" data-testid="warning-groups">
    {#each groups as g (g.key)}
      {@const e = g.newest}
      {@const linked = !!eventKind(e, kinds.all)}
      {@const summary = warningSummary(g)}
      {@const expanded = !!open[g.key]}
      {@const times = timesText(g.count)}
      <li class="event" title={summary || undefined} data-testid="warning-group">
        <span class="state" aria-hidden="true"><Icon name="warning" size={16} /></span>
        <div class="what">
          <span class="reason" title={g.reason}>{warningReason(g)}</span>
          <span class="sep" aria-hidden="true">·</span>
          {#if g.objects > 1}
            <span class="object">{warningSubject(g)}</span>
          {:else if linked}
            <button type="button" class="link object" onclick={() => openObjectOf(e)}>{e.object}</button>
          {:else}
            <span class="object muted">{e.object}</span>
          {/if}
        </div>
        <span class="when">{times ? `${times} · ` : ""}{ago(g.time)}</span>
        <div class="actions">{@render actions?.(g)}</div>
        <button
          type="button"
          class="row-chev"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Hide" : "Show"} the message`}
          title={expanded ? "Hide the message" : "Show the message"}
          onclick={() => (open = { ...open, [g.key]: !expanded })}><Icon name="chevronRight" size={16} /></button
        >
        {#if expanded}
          <div class="more" data-testid="warning-message">
            {#if summary}<p class="summary">{summary}</p>{/if}
            <p class="message">{stripPodIds(e.message)}</p>
            {#if g.objects > 1}
              <p class="objects">
                {#each objectsOf(g) as o (o.key)}
                  {#if linked}
                    <button type="button" class="link" onclick={() => openObjectOf(o)}>{o.object_name}</button>
                  {:else}
                    <span>{o.object_name}</span>
                  {/if}
                {/each}
              </p>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  {#if eventsKind}
    <button type="button" class="see-all" data-testid="see-all-warnings" onclick={() => eventsKind && openWithStatus(eventsKind, "Warning")}
      >See all warnings →</button
    >
  {/if}
{/if}

<style>
  .empty {
    padding: 4px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
  }
  .none {
    margin: 0;
  }
  /* One line, 36 px: icon · reason · object · how often and when · expand. */
  .event {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) auto auto 22px;
    align-items: center;
    column-gap: 10px;
    min-height: 36px;
    box-sizing: border-box;
    padding: 5px 8px 5px 12px;
  }
  .state {
    display: grid;
    place-items: center;
    color: var(--amber);
  }
  .what {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    white-space: nowrap;
    font-size: var(--text-base);
  }
  .reason {
    flex-shrink: 0;
    font-weight: var(--weight-semibold);
  }
  .sep {
    color: var(--text-muted);
  }
  .object {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .when {
    font-size: var(--text-sm);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .link {
    padding: 0;
    border: none;
    background: transparent;
    color: var(--accent);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .link:hover {
    text-decoration: underline;
  }
  .muted {
    color: var(--text-muted);
  }
  .more {
    grid-column: 2 / -1;
    padding: 2px 0 4px;
    min-width: 0;
  }
  .more p {
    margin: 2px 0 0;
  }
  .summary {
    font-size: var(--text-base);
    font-weight: var(--weight-medium);
  }
  .message {
    font-family: var(--font-num);
    font-size: 12px;
    line-height: 1.45;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  .objects {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    font-size: var(--text-sm);
  }
</style>

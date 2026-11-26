<script lang="ts">
  import { onDestroy } from "svelte";
  import type { RelatedEvent } from "../bindings";
  import { onAgeTick } from "../ageClock";
  import { eventSummary, reasonWords } from "../eventText";
  import { ageRedrawMs, eventTimes } from "../format";

  /** Events about one object, newest first. */
  let { events }: { events: RelatedEvent[] } = $props();

  /** Messages folded open with "Show all", by `foldKey` (#513). */
  let open = $state.raw(new Set<string>());
  /** Messages longer than the fold, by `foldKey`. */
  let long = $state.raw(new Set<string>());
  const foldKey = (e: RelatedEvent) => `${e.type}\n${e.reason}\n${e.message}`;
  const added = (set: Set<string>, key: string, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(key);
    else next.delete(key);
    return next;
  };
  /** Marks the message whose key is given as longer than its fold, and
   *  keeps that up to date when the panel is resized. */
  function fold(el: HTMLElement, key: string) {
    const check = () => {
      if (open.has(key)) return;
      const over = el.scrollHeight > el.clientHeight + 1;
      if (over !== long.has(key)) long = added(long, key, over);
    };
    const ro = new ResizeObserver(check);
    ro.observe(el);
    check();
    return {
      update(next: string) {
        key = next;
        check();
      },
      destroy: () => ro.disconnect(),
    };
  }

  // "last 41s ago" stays fresh, like the ages of the table (#380).
  let now = $state.raw(Date.now());
  onDestroy(
    onAgeTick((t) => {
      if (t - now >= ageRedrawMs(events[0]?.time ?? 0, t) - 50) now = t;
    }),
  );
</script>

<h3>Events</h3>
{#if events.length === 0}
  <p class="muted small">No events.</p>
{:else}
  <div class="scroll-x">
    <table class="events">
      <!-- Fixed columns: a long message wraps inside the panel, never past
           its edge (#513). -->
      <colgroup><col class="c-type" /><col class="c-reason" /><col /></colgroup>
      <thead><tr><th>Type</th><th>Reason</th><th>Message</th></tr></thead>
      <tbody>
        {#each events as e, i (i)}
          {@const summary = eventSummary(e.reason, e.message)}
          {@const key = foldKey(e)}
          {@const opened = open.has(key)}
          <tr>
            <td class:warn={e.type === "Warning"}>{e.type}</td>
            <!-- How often and when sit under the reason, so the message keeps
                 the width in the narrow panel. -->
            <td class="reason">
              <div title={e.reason}>{reasonWords(e.reason, e.message)}</div>
              <div class="seen muted">{eventTimes(e.count, e.time, now, e.age)}</div>
            </td>
            <td class="wrap">
              {#if summary}<div class="summary">{summary}</div>{/if}
              <!-- A long message is folded to a few lines, with all of it a
                   click away (and in the tooltip). -->
              <div
                class="message"
                class:full={!!summary}
                class:muted={!!summary}
                class:folded={!opened}
                data-testid="event-message"
                title={long.has(key) && !opened ? e.message : undefined}
                use:fold={key}
              >
                {e.message}
              </div>
              {#if long.has(key) || opened}
                <button
                  type="button"
                  class="more"
                  aria-expanded={opened}
                  onclick={() => (open = added(open, key, !opened))}>{opened ? "Show less" : "Show all"}</button
                >
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  h3 {
    margin: 14px 0 8px;
    font-size: 13px;
  }
  table {
    font-size: 12px;
    table-layout: fixed;
  }
  .c-type {
    width: 74px;
  }
  .c-reason {
    width: 32%;
  }
  td {
    vertical-align: top;
  }
  td.wrap,
  td.reason {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .folded {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    overflow: hidden;
  }
  .more {
    margin-top: 2px;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--accent);
    font-size: 11px;
    cursor: pointer;
  }
  .more:hover {
    text-decoration: underline;
  }
  .seen {
    font-size: 11px;
    margin-top: 2px;
  }
  .summary {
    font-weight: 600;
  }
  .full {
    font-size: 11px;
    margin-top: 2px;
  }
  .scroll-x {
    overflow-x: auto;
  }
  .small {
    font-size: 12px;
    margin: 0 0 6px;
  }
  .warn {
    color: var(--amber);
  }
</style>

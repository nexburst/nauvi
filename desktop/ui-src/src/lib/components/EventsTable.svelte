<script lang="ts">
  import { onDestroy } from "svelte";
  import type { RelatedEvent } from "../bindings";
  import { onAgeTick } from "../ageClock";
  import { eventSummary, reasonWords } from "../eventText";
  import { ageRedrawMs, eventTimes } from "../format";

  /** Events about one object, newest first. */
  let { events }: { events: RelatedEvent[] } = $props();

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
      <thead><tr><th>Type</th><th>Reason</th><th>Message</th></tr></thead>
      <tbody>
        {#each events as e, i (i)}
          {@const summary = eventSummary(e.reason, e.message)}
          <tr>
            <td class:warn={e.type === "Warning"}>{e.type}</td>
            <!-- How often and when sit under the reason, so the message keeps
                 the width in the narrow panel. -->
            <td class="reason">
              <div title={e.reason}>{reasonWords(e.reason, e.message)}</div>
              <div class="seen muted">{eventTimes(e.count, e.time, now, e.age)}</div>
            </td>
            <td class="wrap">
              {#if summary}
                <div class="summary">{summary}</div>
                <div class="full muted">{e.message}</div>
              {:else}
                {e.message}
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
  }
  td {
    vertical-align: top;
  }
  td.wrap {
    white-space: normal;
    min-width: 180px;
    word-break: break-word;
  }
  td.reason {
    white-space: normal;
    min-width: 96px;
    max-width: 150px;
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

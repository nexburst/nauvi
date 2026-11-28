<script module lang="ts">
  /** Feed ids, unique across mounts so a stale feed's messages are ignored. */
  let nextFeed = 0;
</script>

<script lang="ts">
  import {
    GiveUp,
    clearStalled,
    markStalled,
    reconnectStoppedMessage,
    retryDelay,
    stoppedMessage,
  } from "../retry";
  import { onDestroy, untrack } from "svelte";
  import { Channel } from "@tauri-apps/api/core";
  import { api, visibleCluster } from "../cluster";
  import type { KindCounts, WatchState, WorkloadsMessage, WorkloadsOverview } from "../bindings";
  import { app, currentContextName, kinds, openWithStatus, setStatus, setView, showError, stamp } from "../stores/app.svelte";
  import { clusterError } from "../clusterError";
  import { troubleTitle } from "../health";
  import { WARNINGS_SHOWN } from "../overview";
  import { needsAttention, segments, workloadKind, workloadsHeadline, workloadsKicker } from "../workloads";
  import Deck from "./Deck.svelte";
  import OutOfReach from "./OutOfReach.svelte";
  import ProblemWorkloads from "./ProblemWorkloads.svelte";
  import WarningGroups from "./WarningGroups.svelte";
  import AskAiRowButton from "./AskAiRowButton.svelte";
  import { warningScope, workloadScope } from "../askAi";
  import { warningReason, warningSubject } from "../warningGroups";

  /** Workloads → Overview (#79): live status counts per workload kind in the
   *  selected namespaces, the problem workloads and the Warning groups. Like
   *  the Overview (#606), it fits one screen: at most five of each, the rest
   *  one link away. */

  /** Failed starts so far: the wait before the next one grows (lib/retry.ts). */
  let attempts = 0;
  /** Stops a feed that has been reconnecting for five minutes (lib/retry.ts). */
  const giveUp = new GiveUp();
  /** Marks this feed stalled while it is not running, for a wake to restart it (#526). */
  const stall = {};
  /** Ages are recomputed in the UI; nothing is re-requested. */
  const AGE_TICK_MS = 15_000;

  let overview = $state.raw<WorkloadsOverview | null>(null);
  let now = $state(Date.now());
  /** The running feed, or 0. Messages of other ids are from stopped feeds. */
  let feed = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

  // The backend pushes a new summary when something changes, and a state
  // when the connection changes, on the channel of the feed (#115).
  function onMessage(id: number, m: WorkloadsMessage) {
    if (id !== feed) return;
    if (m.type === "state") return onState(m);
    overview = m.overview;
    const total = overview.kinds.reduce((n, k) => n + k.total, 0);
    app.count = `${total} workload objects`;
    stamp();
  }

  /** The banner message this view set, so it clears only its own. */
  let shown = "";

  function setError(message: string) {
    shown = message;
    showError(message);
  }

  function clearError() {
    if (shown && app.error === shown) showError("");
    shown = "";
  }

  function onState(s: WatchState) {
    if (s.state === "live") {
      giveUp.clear();
      setStatus(true, "Live");
      clearError();
    } else if (s.state === "reconnecting") {
      setStatus(false, "Reconnecting…");
      setError(s.error);
      // The backend reconnects for as long as it is asked to: after five
      // minutes of this, stop the feed and say so. Retry, Refresh or a
      // wake starts it again.
      const error = s.error;
      giveUp.arm(() => {
        stop();
        markStalled(stall);
        setStatus(false, "Not connected");
        setError(reconnectStoppedMessage(error));
      });
    } else {
      setStatus(null, "Connecting…");
    }
  }

  function stop() {
    giveUp.clear();
    clearStalled(stall);
    if (retry) clearTimeout(retry);
    retry = null;
    const id = feed;
    feed = 0;
    if (id) api(visibleCluster()).cmdWorkloadsStop(id).catch(() => {});
  }

  /** `again`: one of the automatic retries, which keeps the error on screen. */
  async function start(namespaces: string[], again = false) {
    stop();
    const id = ++nextFeed;
    feed = id;
    overview = null;
    if (!again) {
      attempts = 0;
      clearError();
    }
    setStatus(null, again ? "Retrying…" : "Connecting…");
    try {
      const channel = new Channel<WorkloadsMessage>((m) => onMessage(id, m));
      await api(visibleCluster()).cmdWorkloadsStart(id, namespaces, channel);
    } catch (e) {
      if (feed !== id) return;
      const err = clusterError(e);
      setStatus(false, err.status);
      // Wait longer each time, and stop after a few minutes: Refresh starts over.
      markStalled(stall);
      const wait = retryDelay(++attempts);
      setError(wait === null ? stoppedMessage(err.message) : err.message);
      if (wait !== null) retry = setTimeout(() => start(namespaces, true), wait);
    }
  }

  // Start on mount, on Refresh or a context switch (the nonce), and again
  // for every change of the namespace selection.
  $effect(() => {
    void app.refreshNonce;
    const namespaces = [...app.selectedNamespaces];
    untrack(() => start(namespaces));
  });

  const ageTimer = setInterval(() => (now = Date.now()), AGE_TICK_MS);

  onDestroy(() => {
    clearInterval(ageTimer);
    stop();
  });

  const context = $derived(currentContextName());
  const kicker = $derived(workloadsKicker(context, app.selectedNamespaces));
  const head = $derived(workloadsHeadline(overview?.problems_total ?? 0, context));

  function kindOf(k: { group: string; kind: string }) {
    return workloadKind(kinds.all, k.group, k.kind);
  }

  function title(k: KindCounts): string {
    return kindOf(k)?.label ?? `${k.kind}s`;
  }
</script>

<div class="workloads" data-testid="workloads-overview">
  {#if overview}
    <Deck {kicker} headline={head.text} calm={head.calm} />
    {#if overview.notes.length > 0}
      <ul class="notes muted">
        {#each overview.notes as note (note)}
          <li>{note}</li>
        {/each}
      </ul>
    {/if}
    <div class="cards">
      {#each overview.kinds as k (k.group + "/" + k.kind)}
        {@const kind = kindOf(k)}
        {@const parts = segments(k)}
        <section class="card" class:alert={needsAttention(k)} aria-label={title(k)} data-kind={k.kind}>
          <div class="card-head">
            {#if kind}
              <button type="button" class="link name" title={`Open ${kind.label}`} onclick={() => setView(kind.id)}
                >{title(k)}</button
              >
            {:else}
              <span class="name">{title(k)}</span>
            {/if}
            <span class="total">{k.total}</span>
          </div>
          <div class="bar" role="img" aria-label={parts.map((p) => `${p.count} ${p.status}`).join(", ")}>
            {#each parts as p (p.status)}
              {#if p.count > 0}
                <div class="seg {p.tone}" style:width="{p.percent}%"></div>
              {/if}
            {/each}
          </div>
          <ul class="legend">
            {#each parts as p (p.status)}
              <li>
                <button
                  type="button"
                  class="status"
                  data-status={p.status}
                  disabled={!kind || p.count === 0}
                  title={kind ? `Show the ${p.status} ${kind.label}` : ""}
                  onclick={() => kind && openWithStatus(kind, p.status)}
                >
                  <span class="dot {p.tone}"></span>
                  <span class="label">{p.status}</span>
                  <span class="count">{p.count}</span>
                </button>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    </div>

    <div class="sections">
      <section aria-label="Problem workloads">
        <div class="sec-head">
          <h3>Problem workloads</h3>
          {#if overview.problems_total > 0}<span class="count" data-testid="problem-workloads-count">{overview.problems_total}</span>{/if}
        </div>
        <ProblemWorkloads problems={overview.problems} total={overview.problems_total} counts={overview.kinds}>
          {#snippet actions(p)}
            <AskAiRowButton scope={workloadScope(p)} about={`${p.kind} ${p.namespace}/${p.name}`} />
          {/snippet}
        </ProblemWorkloads>
      </section>
      <section aria-label="Warning groups">
        <div class="sec-head"><h3>Warning groups</h3></div>
        <WarningGroups events={overview.events} {now} limit={WARNINGS_SHOWN}>
          {#snippet actions(g)}
            <AskAiRowButton scope={warningScope(g)} about={`${warningReason(g)} on ${warningSubject(g)}`} />
          {/snippet}
        </WarningGroups>
      </section>
    </div>
  {:else if app.status.ok !== false}
    <Deck {kicker} headline="Loading the first summary…" calm waiting />
  {:else}
    <!-- Not blank under the banner (#462). -->
    <OutOfReach title={troubleTitle(app.status) ?? app.status.text} />
  {/if}
</div>

<style>
  .workloads {
    flex: 1;
    overflow: auto;
    padding: 20px 24px 28px;
    container: workloads / inline-size;
  }
  .notes {
    margin: 0 0 16px;
    padding-left: 18px;
    font-size: 12px;
  }
  /* A ledger: one 34px row per kind. Its name and count, a bar of its
     states, then the states in words; the ones at zero step back. */
  .cards {
    display: flex;
    flex-direction: column;
    margin-bottom: 24px;
    border-top: 1px solid var(--border);
  }
  .card {
    display: grid;
    grid-template-columns: 210px 200px minmax(0, 1fr);
    align-items: center;
    gap: 20px;
    min-height: 34px;
    padding: 0 4px;
    border-bottom: 1px solid var(--border);
  }
  .card.alert {
    box-shadow: inset 2px 0 0 var(--red);
  }
  .card-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding-left: 8px;
  }
  .name {
    font-weight: 600;
    font-size: 13px;
  }
  .total {
    font-family: var(--font-num);
    font-size: 15px;
    font-weight: 600;
  }
  .bar {
    display: flex;
    height: 6px;
    border-radius: 3px;
    overflow: hidden;
    background: var(--bg-hover);
  }
  .seg {
    height: 100%;
  }
  .ok {
    background: var(--green);
  }
  .progress {
    background: var(--amber);
  }
  .bad {
    background: var(--red);
  }
  .done {
    background: var(--accent);
  }
  .idle {
    background: var(--text-muted);
  }
  .legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 0 6px;
  }
  .status:disabled {
    opacity: 0.45;
  }
  /* Nothing there is nothing to colour. */
  .status:disabled .dot {
    background: var(--text-muted);
  }
  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: none;
    border-radius: 4px;
    padding: 2px 4px;
    font: inherit;
    font-size: 12px;
    color: var(--text);
    cursor: pointer;
    text-align: left;
  }
  .status:hover:not(:disabled) {
    background: var(--bg-hover);
  }
  .status:disabled {
    cursor: default;
    color: var(--text-muted);
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .legend .count {
    font-family: var(--font-num);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  /* What needs a look, side by side; stacked when narrow. */
  .sections {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 24px;
  }
  @container workloads (min-width: 900px) {
    .sections {
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    }
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
</style>

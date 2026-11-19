<script module lang="ts">
  /** Feed ids, unique across mounts so a stale feed's events are ignored. */
  let nextFeed = 0;
</script>

<script lang="ts">
  import { GiveUp, reconnectStoppedMessage, retryDelay, stoppedMessage } from "../retry";
  import { onDestroy, untrack } from "svelte";
  import { events } from "../bindings";
  import { api, visibleCluster } from "../cluster";
  import { thisWindow } from "../window";
  import type { EventInfo, KindCounts, ProblemWorkload, WorkloadsOverview, WorkloadsStateChanged } from "../bindings";
  import { app, kinds, openObject, openWithStatus, setStatus, setView, showError, stamp } from "../stores/app.svelte";
  import { clusterError } from "../clusterError";
  import { formatAge } from "../format";
  import { eventKind } from "../overview";
  import { joinNames } from "../namespaces";
  import { needsAttention, segments, workloadKind } from "../workloads";

  /** Workloads → Overview (#79): live status counts per workload kind in the
   *  selected namespaces, the problem workloads and their warnings. */

  /** Failed starts so far: the wait before the next one grows (lib/retry.ts). */
  let attempts = 0;
  /** Stops a feed that has been reconnecting for five minutes (lib/retry.ts). */
  const giveUp = new GiveUp();
  /** Ages are recomputed in the UI; nothing is re-requested. */
  const AGE_TICK_MS = 15_000;

  let overview = $state.raw<WorkloadsOverview | null>(null);
  let now = $state(Date.now());
  /** The running feed, or 0. Events of other ids are from stopped feeds. */
  let feed = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const listening = Promise.all([
    events.workloadsUpdate(thisWindow()).listen((e) => {
      if (e.payload.id !== feed) return;
      overview = e.payload.overview;
      const total = overview.kinds.reduce((n, k) => n + k.total, 0);
      app.count = `${total} workload objects`;
      stamp();
    }),
    events.workloadsState(thisWindow()).listen((e) => {
      if (e.payload.id === feed) onState(e.payload);
    }),
  ]);

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

  function onState(s: WorkloadsStateChanged) {
    if (s.state === "live") {
      giveUp.clear();
      setStatus(true, "Live");
      clearError();
    } else if (s.state === "reconnecting") {
      setStatus(false, "Reconnecting…");
      setError(s.error);
      // The backend reconnects for as long as it is asked to: after five
      // minutes of this, stop the feed and say so. Refresh starts it again.
      const error = s.error;
      giveUp.arm(() => {
        stop();
        setStatus(false, "Not connected");
        setError(reconnectStoppedMessage(error));
      });
    } else {
      setStatus(null, "Connecting…");
    }
  }

  function stop() {
    giveUp.clear();
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
    // Listen first: the backend may send the first summary right away.
    await listening;
    if (feed !== id) return;
    try {
      await api(visibleCluster()).cmdWorkloadsStart(id, namespaces);
    } catch (e) {
      if (feed !== id) return;
      const err = clusterError(e);
      setStatus(false, err.status);
      // Wait longer each time, and stop after a few minutes: Refresh starts over.
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
    listening.then((uns) => uns.forEach((un) => un()));
  });

  const scope = $derived(
    app.selectedNamespaces.length === 0 ? "all namespaces" : `namespace${app.selectedNamespaces.length > 1 ? "s" : ""} ${joinNames(app.selectedNamespaces)}`,
  );

  function kindOf(k: { group: string; kind: string }) {
    return workloadKind(kinds.all, k.group, k.kind);
  }

  function openProblem(p: ProblemWorkload) {
    const kind = kindOf(p);
    if (kind) openObject(kind, p.namespace, p.name);
  }

  function openEvent(e: EventInfo) {
    const kind = eventKind(e, kinds.all);
    if (kind) openObject(kind, kind.resource.namespaced ? e.object_namespace : "", e.object_name);
  }

  function title(k: KindCounts): string {
    return kindOf(k)?.label ?? `${k.kind}s`;
  }
</script>

<div class="workloads" data-testid="workloads-overview">
  {#if overview}
    <p class="muted scope">Workloads in {scope}</p>
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
        <h3>
          Problem workloads{overview.problems_total > overview.problems.length
            ? ` (${overview.problems.length} of ${overview.problems_total})`
            : ""}
        </h3>
        {#each overview.problems as p (p.kind + "/" + p.namespace + "/" + p.name)}
          <div class="problem">
            <span class="kind muted">{p.kind}</span>
            {#if kindOf(p)}
              <button type="button" class="link" onclick={() => openProblem(p)}>{p.namespace}/{p.name}</button>
            {:else}
              <span>{p.namespace}/{p.name}</span>
            {/if}
            <span class="reason" class:error={p.status === "Failed"}>{p.reason}</span>
          </div>
        {:else}
          <p class="muted">None.</p>
        {/each}
      </section>
      <section aria-label="Workload warnings">
        <h3>Warnings</h3>
        {#each overview.events as e (e.key)}
          {@const linked = eventKind(e, kinds.all)}
          <div class="event">
            <span class="age">{formatAge(e.time, now, "")}</span>
            <span class="reason">{e.reason}</span>
            {#if linked}
              <button type="button" class="link object" onclick={() => openEvent(e)}>{e.object}</button>
            {:else}
              <span class="object muted">{e.object}</span>
            {/if}
            <span class="message">{e.message}{e.count > 1 ? ` (x${e.count})` : ""}</span>
          </div>
        {:else}
          <p class="muted">No warnings.</p>
        {/each}
      </section>
    </div>
  {:else}
    <p class="muted loading">Loading…</p>
  {/if}
</div>

<style>
  .workloads {
    flex: 1;
    overflow: auto;
    padding: 16px;
  }
  .scope {
    margin: 0 0 12px;
    font-size: 12px;
  }
  .loading {
    font-size: 13px;
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
  h3 {
    font-family: var(--font-num);
    font-size: 10.5px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
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
  .count {
    font-family: var(--font-num);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }
  .sections {
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: 24px;
  }
  h3 {
    margin: 0 0 10px;
    font-size: 14px;
  }
  .problem {
    display: flex;
    gap: 10px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    align-items: baseline;
  }
  .problem .kind {
    min-width: 80px;
    font-size: 12px;
  }
  .problem .reason {
    color: var(--amber);
  }
  .problem .reason.error {
    color: var(--red);
  }
  .event {
    display: flex;
    gap: 12px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    border-left: 3px solid var(--amber);
    font-size: 13px;
    align-items: baseline;
  }
  .age {
    color: var(--text-muted);
    min-width: 32px;
  }
  .event .reason {
    font-weight: 600;
    min-width: 110px;
  }
  .object {
    min-width: 180px;
    text-align: left;
  }
  .message {
    flex: 1;
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

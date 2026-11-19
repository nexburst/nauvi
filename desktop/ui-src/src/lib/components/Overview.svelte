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
  import type { EventInfo, Overview_Serialize, OverviewStateChanged } from "../bindings";
  import {
    app,
    currentContextName,
    kinds,
    openObject,
    primaryNamespace,
    setStatus,
    showError,
    stamp,
  } from "../stores/app.svelte";
  import { clusterError } from "../clusterError";
  import { formatAge } from "../format";
  import { capacityBars, deckHeadline, eventKind, overviewCount, podCards } from "../overview";
  import { blips as toBlips, type Blip } from "../sonar";
  import { observeOverview, scope } from "../stores/watch.svelte";
  import CalmWater from "./CalmWater.svelte";
  import { NODE_KIND_ID, POD_KIND_ID, overviewBadges } from "../problems";
  import { reportProblems, staleProblems } from "../stores/problems.svelte";
  import MetricsOffer from "./helm/MetricsOffer.svelte";
  import MetricsHiddenNote from "./MetricsHiddenNote.svelte";
  import OverviewUsage from "./OverviewUsage.svelte";
  import { metricsHidden } from "../stores/metricsHidden.svelte";
  import { settingsSaved } from "../stores/settings.svelte";

  /** Failed starts so far: the wait before the next one grows (lib/retry.ts). */
  let attempts = 0;
  /** Stops a feed that has been reconnecting for five minutes (lib/retry.ts). */
  const giveUp = new GiveUp();
  /** Ages are recomputed in the UI; nothing is re-requested. */
  const AGE_TICK_MS = 15_000;

  let overview = $state.raw<Overview_Serialize | null>(null);
  let now = $state(Date.now());
  /** The running feed, or 0. Events of other ids are from stopped feeds. */
  let feed = 0;
  /** The next update is the feed's first: a new baseline for the watch log. */
  let fresh = true;
  /** The sonar's radius (Sonar.svelte draws on a 200-unit scope). */
  const SCOPE_R = 92;
  /** Problem pods that just cleared: a ring on the sonar, a line in the list. */
  let recovered = $state.raw<Blip[]>([]);
  let clearedTimer: ReturnType<typeof setTimeout> | null = null;
  /** How long a cleared problem stays in the list. */
  const CLEARED_MS = 2600;

  function noteCleared(prev: Overview_Serialize | null, next: Overview_Serialize) {
    const pods = next.pods;
    if (!pods) return;
    const keys = pods.problems.map((p) => `${p.namespace}/${p.name}`);
    const gone = observeOverview(currentContextName(), keys, pods.problems_total, fresh);
    fresh = false;
    scope.blips = toBlips(pods.problems, SCOPE_R);
    scope.healthy = pods.running;
    if (gone.length === 0 || !prev?.pods) return;
    recovered = toBlips(prev.pods.problems, SCOPE_R).filter((b) => gone.includes(b.key));
    scope.recovered = recovered;
    if (clearedTimer) clearTimeout(clearedTimer);
    clearedTimer = setTimeout(() => {
      recovered = [];
      scope.recovered = [];
    }, CLEARED_MS);
  }
  let retry: ReturnType<typeof setTimeout> | null = null;

  // The backend pushes a new summary when something changes (watches, not
  // polling), and a state when the connection changes.
  const listening = Promise.all([
    events.overviewUpdate(thisWindow()).listen((e) => {
      if (e.payload.id !== feed) return;
      noteCleared(overview, e.payload.overview);
      noteSweep(e.payload.overview);
      overview = e.payload.overview;
      app.count = overviewCount(overview.pods, overview.nodes);
      // The sidebar's Pods and Nodes badges, from the same watches.
      for (const b of overviewBadges(overview.pods, overview.nodes)) {
        reportProblems(b.kindId, b.count, b.scope, "overview");
      }
      stamp();
    }),
    events.overviewState(thisWindow()).listen((e) => {
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

  function onState(s: OverviewStateChanged) {
    if (s.state === "live") {
      giveUp.clear();
      setStatus(true, "Live");
      clearError();
    } else if (s.state === "reconnecting") {
      // The backend's text says what failed and that it retries.
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
    if (id) api(visibleCluster()).cmdOverviewStop(id).catch(() => {});
  }

  /** `again`: one of the automatic retries, which keeps the error on screen. */
  async function start(namespace: string, again = false) {
    stop();
    const id = ++nextFeed;
    feed = id;
    fresh = true;
    if (!again) {
      attempts = 0;
      clearError();
    }
    setStatus(null, again ? "Retrying…" : "Connecting…");
    // Listen first: the backend may send the first summary right away.
    await listening;
    // The backend reads Hide metrics (#327) from the settings: a change
    // just made must have reached it first.
    await settingsSaved();
    if (feed !== id) return;
    try {
      // Parts the user may not see cluster-wide fall back to this namespace.
      await api(visibleCluster()).cmdOverviewStart(id, namespace || null);
    } catch (e) {
      if (feed !== id) return;
      const err = clusterError(e);
      setStatus(false, err.status);
      overview = null;
      // Wait longer each time, and stop after a few minutes: Refresh starts over.
      const wait = retryDelay(++attempts);
      setError(wait === null ? stoppedMessage(err.message) : err.message);
      if (wait !== null) retry = setTimeout(() => start(namespace, true), wait);
    }
  }

  // Start on mount, and again on Refresh or a context switch (both bump the
  // nonce) or when the start-up namespace arrives. The namespace only
  // matters to users who cannot see the whole cluster; with several
  // selected, the first one is the fallback.
  const fallback = $derived(primaryNamespace());
  // Hiding metrics (#327) restarts the feed: the backend then stops (or
  // starts) polling node usage.
  const hideMetrics = $derived(metricsHidden());
  $effect(() => {
    void app.refreshNonce;
    void hideMetrics;
    const ns = fallback;
    untrack(() => start(ns));
  });

  const ageTimer = setInterval(() => (now = Date.now()), AGE_TICK_MS);

  onDestroy(() => {
    clearInterval(ageTimer);
    if (clearedTimer) clearTimeout(clearedTimer);
    stop();
    staleProblems(POD_KIND_ID, "overview");
    staleProblems(NODE_KIND_ID, "overview");
    listening.then((uns) => uns.forEach((un) => un()));
  });

  const podKind = $derived(kinds.all.find((k) => k.id === "v1/pods"));
  const head = $derived(deckHeadline(overview?.pods ?? null));
  /**
   * What the sonar shows; a change sweeps it once. At most one sweep per
   * SWEEP_EVERY_MS, so a busy cluster never keeps the beam turning.
   */
  let sweepKey = $state("");
  let lastSweep = 0;
  const SWEEP_EVERY_MS = 20_000;
  function noteSweep(o: Overview_Serialize) {
    if (!o.pods) return;
    const key = `${o.pods.problems.map((p) => `${p.namespace}/${p.name}`).join()}|${o.pods.running}|${o.pods.total}`;
    const at = Date.now();
    if (key === sweepKey || at - lastSweep < SWEEP_EVERY_MS) return;
    sweepKey = key;
    scope.sweep = key;
    lastSweep = at;
  }

  function openEvent(e: EventInfo) {
    const kind = eventKind(e, kinds.all);
    if (kind) openObject(kind, kind.resource.namespaced ? e.object_namespace : "", e.object_name);
  }
</script>

<div class="overview">
  {#if overview}
    {@const pods = overview.pods}
    {#if overview.notes.length > 0}
      <ul class="notes muted">
        {#each overview.notes as note (note)}
          <li>{note}</li>
        {/each}
      </ul>
    {/if}
    <div class="deck">
      <div class="summary">
        <span class="eyebrow">Watch report{pods?.namespace ? ` · ${pods.namespace}` : ""}</span>
        <h2 class="headline" class:calm={head.calm} data-testid="deck-headline">{head.text}</h2>
    <div class="cards">
      {#if overview.namespaces !== null}
        <div class="card">
          <div class="num">{overview.namespaces}</div>
          <div class="label">Namespaces</div>
        </div>
      {/if}
      {#if overview.nodes}
        <div class="card" class:alert={overview.nodes.ready < overview.nodes.total}>
          <div class="num">{overview.nodes.ready}/{overview.nodes.total}</div>
          <div class="label">Nodes ready</div>
        </div>
      {/if}
      {#if pods}
        {@const scope = pods.namespace ? ` in ${pods.namespace}` : ""}
        <div class="card" class:wide={scope !== ""} title="Pods{scope}">
          <div class="num">{pods.total}</div>
          <div class="label">Pods{scope}</div>
        </div>
        {#each podCards(pods) as c (c.label)}
          <div class="card" class:alert={c.alert} class:zero={c.value === 0} title={c.title}>
            <div class="num">{c.value}</div>
            <div class="label">{c.label}</div>
          </div>
        {/each}
      {/if}
    </div>
      </div>
    </div>

    <div class="sections">
      <section aria-label="Problem pods">
        <h3>
          Problem pods{pods && pods.problems_total > pods.problems.length
            ? ` (${pods.problems.length} of ${pods.problems_total})`
            : ""}
        </h3>
        {#if pods}
          {#each pods.problems as p (p.namespace + "/" + p.name)}
            <div class="problem">
              {#if podKind}
                <button type="button" class="link" onclick={() => podKind && openObject(podKind, p.namespace, p.name)}>
                  {p.namespace}/{p.name}
                </button>
              {:else}
                <span>{p.namespace}/{p.name}</span>
              {/if}
              <span class="reason" class:error={p.reason === p.status}>{p.reason}</span>
              {#if p.restarts > 0}<span class="muted">{p.restarts} restarts</span>{/if}
            </div>
          {:else}
            <CalmWater mark="buoy"><p class="none">None.</p></CalmWater>
          {/each}
          {#each recovered as r (r.key)}
            <div class="cleared" aria-live="polite">
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <circle cx="8" cy="8" r="6.5" />
                <path d="M5 8.2l2 2 4-4.2" pathLength="10" />
              </svg>
              <span class="who">{r.key}</span>
              <span class="what">cleared</span>
            </div>
          {/each}
        {:else}
          <p class="muted">Not allowed.</p>
        {/if}

        <h3 class="spaced">Pods by namespace</h3>
        {#if pods}
          <table>
            <thead><tr><th>Namespace</th><th>Pods</th></tr></thead>
            <tbody>
              {#each pods.by_namespace as [ns, n] (ns)}
                <tr><td>{ns}</td><td>{n}</td></tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <p class="muted">Not allowed.</p>
        {/if}
      </section>
      <section aria-label="Warnings">
        <h3>
          Warnings{overview.events?.namespace ? ` in ${overview.events.namespace}` : ""}
        </h3>
        {#each overview.events?.items ?? [] as e (e.key)}
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
          {#if overview.events}
            <CalmWater mark="lighthouse"><p class="none">No warnings.</p></CalmWater>
          {:else}
            <p class="muted">Not allowed.</p>
          {/if}
        {/each}
      </section>
    </div>
    {#if overview.capacity}
      <section class="capacity" aria-label="Capacity">
        <h3>Capacity</h3>
        <!-- One grid for all rows, so the bars line up. -->
        <div class="bars">
        {#each capacityBars(overview.capacity) as bar (bar.label)}
          <div class="bar-row">
            <span class="bar-label">{bar.label}</span>
            <div class="bar" role="meter" aria-label={bar.label} aria-valuenow={bar.percent} aria-valuemin={0} aria-valuemax={100}>
              <div class="fill" class:high={bar.high} style:width="{bar.percent}%"></div>
              {#if bar.limitPercent !== null}
                <div
                  class="limit"
                  class:over={bar.overcommitted}
                  class:partial={bar.partial}
                  style:left="{bar.limitPercent}%"
                  title={bar.limits}
                  data-testid="limit-{bar.label}"
                ></div>
              {/if}
            </div>
            <span class="bar-text">{bar.text}</span>
            <span class="bar-limits" class:over={bar.overcommitted} title={bar.overcommitted ? "The limits add up to more than the nodes can allocate" : ""}>
              {bar.limits}
            </span>
            <span class="bar-usage muted">{hideMetrics ? "" : bar.usage}</span>
          </div>
        {/each}
        </div>
        {#if hideMetrics}
          <MetricsHiddenNote inline />
        {:else}
          <OverviewUsage capacity={overview.capacity} context={currentContextName()} />
        {/if}
        {#if !hideMetrics && !overview.capacity.metrics}
          <p class="muted small">No usage: the metrics API (metrics-server) is not available.</p>
          <MetricsOffer
            addon="metrics-server"
            label="Install metrics-server…"
            text="Install it with helm: a dry run first, nothing changes until you confirm."
          />
        {/if}
      </section>
    {/if}
  {:else if app.status.ok !== false}
    <!-- The first sounding: the rings breathe until the first update. -->
    <div class="deck waiting">
      <div class="summary">
        <span class="eyebrow">Watch report</span>
        <h2 class="headline">Taking the first sounding…</h2>
      </div>
    </div>
  {/if}
</div>

<style>
  .overview {
    flex: 1;
    overflow: auto;
    padding: 18px 20px 24px;
    container: overview / inline-size;
  }
  /* The deck: sonar, the report, the watch log. */
  .deck {
    margin-bottom: 22px;
    padding-bottom: 18px;
    border-bottom: 1px solid var(--border);
  }
  .summary {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .headline {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 0 0 14px;
    font-size: 30px;
    font-weight: 600;
    letter-spacing: -0.025em;
    line-height: 1.15;
  }
  .headline::before {
    content: "";
    flex-shrink: 0;
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--amber);
    box-shadow: 0 0 0 4px color-mix(in srgb, var(--amber) 18%, transparent);
  }
  .headline.calm::before {
    background: var(--accent);
    box-shadow: 0 0 0 4px var(--accent-soft);
  }
  .cards {
    display: flex;
    flex-wrap: wrap;
    row-gap: 12px;
  }
  .notes {
    margin: 0 0 16px;
    padding-left: 18px;
    font-size: 12px;
  }
  /* The ledger: figures on one line, parted by hairlines. No boxes. */
  .card {
    min-width: 0;
    padding: 2px 18px 2px 0;
    margin-right: 18px;
    border-right: 1px solid var(--border);
  }
  .card:last-child {
    border-right: none;
  }
  /* "Pods in <namespace>" needs more room than one column. */
  .card.wide {
    max-width: 220px;
  }
  .card.alert .label {
    color: var(--red);
  }
  .card.zero {
    opacity: 0.45;
  }
  .card.alert .num {
    color: var(--red);
  }
  .num {
    font-family: var(--font-num);
    font-size: 18px;
    font-weight: 500;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .label {
    color: var(--text-muted);
    font-family: var(--font-num);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.09em;
    margin-top: 3px;
    /* One line: a long namespace ("Pods in team-a") ellipsizes, the card's
       title has the full text. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .capacity {
    margin-bottom: 20px;
  }
  .bars {
    display: grid;
    grid-template-columns: 70px minmax(120px, 1fr) auto auto auto;
    gap: 8px 12px;
    align-items: center;
    font-size: 13px;
    padding: 4px 0;
  }
  .bar-row {
    display: contents;
  }
  .bar {
    position: relative;
    height: 6px;
    background: var(--bg-hover);
    border-radius: 3px;
    overflow: hidden;
  }
  /* Where the limits reach: a tick across the bar. */
  .limit {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 2px;
    margin-left: -2px;
    background: var(--text-muted);
  }
  .limit.over,
  .bar-limits.over {
    color: var(--red);
  }
  .limit.over {
    background: var(--red);
  }
  /* Some containers have no limit: the limits are no ceiling, so the
     marker is hollow. */
  .limit.partial {
    width: 4px;
    margin-left: -4px;
    background: transparent;
    border: 1px dashed var(--text-muted);
    box-sizing: border-box;
  }
  .limit.partial.over {
    border-color: var(--red);
  }
  .bar-limits {
    color: var(--text-muted);
  }
  .fill {
    height: 100%;
    border-radius: 3px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 45%, transparent), var(--accent));
    transition: width 700ms var(--ease-out);
  }
  .fill.high {
    background: var(--amber);
  }
  .small {
    font-size: 12px;
  }
  .sections {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 22px;
    margin-bottom: 24px;
    padding-bottom: 20px;
    border-bottom: 1px solid var(--border);
  }
  h3 {
    margin: 0 0 10px;
    font-family: var(--font-num);
    font-size: 10.5px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
  }
  .none {
    margin: 0;
  }
  /* A problem that just cleared: a teal tick drawn once, then the line goes. */
  .cleared {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 0;
    font-size: 13px;
    color: var(--accent);
    animation: cleared 2600ms var(--ease-out) both;
  }
  .cleared svg {
    fill: none;
    stroke: var(--accent);
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .cleared path {
    stroke-dasharray: 10;
    animation: tick 500ms var(--ease-out) 150ms both;
  }
  .cleared .what {
    font-family: var(--font-num);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }
  @keyframes tick {
    from {
      stroke-dashoffset: 10;
    }
  }
  @keyframes cleared {
    0% {
      opacity: 0;
      transform: translateY(6px);
    }
    12%,
    75% {
      opacity: 1;
      transform: none;
    }
    100% {
      opacity: 0;
    }
  }
  h3.spaced {
    margin-top: 20px;
  }
  /* Two short columns: not the width of the sheet. */
  .sections table {
    max-width: 480px;
  }
  .problem {
    display: flex;
    gap: 10px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    align-items: baseline;
  }
  .problem .reason.error {
    color: var(--red);
  }
  .event {
    display: flex;
    gap: 12px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border);
    border-left: 2px solid var(--amber);

    font-size: 13px;
    align-items: baseline;
  }
  .age {
    color: var(--text-muted);
    min-width: 32px;
  }
  .reason {
    font-weight: 600;
    min-width: 110px;
  }
  .age {
    font-family: var(--font-num);
    font-size: 12px;
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

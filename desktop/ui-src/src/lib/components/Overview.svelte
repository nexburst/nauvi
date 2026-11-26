<script module lang="ts">
  /** Feed ids, unique across mounts so a stale feed's messages are ignored. */
  let nextFeed = 0;
</script>

<script lang="ts">
  import { GiveUp, reconnectStoppedMessage, retryDelay, stoppedMessage } from "../retry";
  import { onDestroy, untrack } from "svelte";
  import { Channel } from "@tauri-apps/api/core";
  import { api, visibleCluster } from "../cluster";
  import type { EventInfo, Overview_Serialize, OverviewMessage_Serialize, WatchState } from "../bindings";
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
  import OutOfReach from "./OutOfReach.svelte";
  import { troubleTitle } from "../health";
  import { NODE_KIND_ID, POD_KIND_ID, overviewBadges } from "../problems";
  import { reportProblems, staleProblems } from "../stores/problems.svelte";
  import MetricsOffer from "./helm/MetricsOffer.svelte";
  import MetricsHiddenNote from "./MetricsHiddenNote.svelte";
  import OverviewUsage from "./OverviewUsage.svelte";
  import { metricsHidden } from "../stores/metricsHidden.svelte";
  import { settingsSaved } from "../stores/settings.svelte";
  import { openDockTab } from "../stores/dock.svelte";
  import Icon from "../icons/Icon.svelte";
  import type { IconName } from "../icons/icons";

  /** Failed starts so far: the wait before the next one grows (lib/retry.ts). */
  let attempts = 0;
  /** Stops a feed that has been reconnecting for five minutes (lib/retry.ts). */
  const giveUp = new GiveUp();
  /** Ages are recomputed in the UI; nothing is re-requested. */
  const AGE_TICK_MS = 15_000;

  let overview = $state.raw<Overview_Serialize | null>(null);
  let now = $state(Date.now());
  /** The running feed, or 0. Messages of other ids are from stopped feeds. */
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
  // polling), and a state when the connection changes, on the channel of
  // the feed (#115).
  function onMessage(id: number, m: OverviewMessage_Serialize) {
    if (id !== feed) return;
    if (m.type === "state") return onState(m);
    noteCleared(overview, m.overview);
    noteSweep(m.overview);
    overview = m.overview;
    app.count = overviewCount(overview.pods, overview.nodes);
    // The sidebar's Pods and Nodes badges, from the same watches.
    for (const b of overviewBadges(overview.pods, overview.nodes)) {
      reportProblems(b.kindId, b.count, b.scope, "overview");
    }
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
    // The backend reads Hide metrics (#327) from the settings: a change
    // just made must have reached it first.
    await settingsSaved();
    if (feed !== id) return;
    try {
      // Parts the user may not see cluster-wide fall back to this namespace.
      const channel = new Channel<OverviewMessage_Serialize>((m) => onMessage(id, m));
      await api(visibleCluster()).cmdOverviewStart(id, namespace || null, channel);
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

  /** The icon and colour of each pod status card. */
  const STATUS_LOOK: Record<string, { icon: IconName; tone: string }> = {
    Running: { icon: "ok", tone: "green" },
    Pending: { icon: "pending", tone: "amber" },
    Errors: { icon: "error", tone: "red" },
    Failed: { icon: "failed", tone: "red" },
    Succeeded: { icon: "check", tone: "muted" },
  };
  const CAPACITY_ICONS: Record<string, IconName> = { CPU: "cpu", Memory: "memory", Pods: "pod" };

  function showLogs(namespace: string, name: string) {
    if (podKind) openDockTab({ type: "podLogs", pod: { resource: podKind.resource, namespace, name } });
  }

  function openEvent(e: EventInfo) {
    const kind = eventKind(e, kinds.all);
    if (kind) openObject(kind, kind.resource.namespaced ? e.object_namespace : "", e.object_name);
  }
</script>

<div class="overview">
  {#if overview}
    {@const pods = overview.pods}
    {@const calmBody = (pods?.problems.length ?? 0) === 0 && (overview.events?.items.length ?? 0) === 0}
    {#if overview.notes.length > 0}
      <ul class="notes muted">
        {#each overview.notes as note (note)}
          <li>{note}</li>
        {/each}
      </ul>
    {/if}
    <div class="deck">
      <span class="status-mark" class:calm={head.calm} aria-hidden="true">
        <Icon name={head.calm ? "ok" : "warning"} size={22} />
      </span>
      <div class="summary">
        <span class="kicker">Watch report{pods?.namespace ? ` · ${pods.namespace}` : ""}</span>
        <h2 class="headline" data-testid="deck-headline">{head.text}</h2>
      </div>
    </div>
    <div class="cards">
      {#if overview.namespaces !== null}
        <div class="card">
          <span class="label">Namespaces</span>
          <div class="card-foot"><span class="num">{overview.namespaces}</span><Icon name="namespace" size={18} /></div>
        </div>
      {/if}
      {#if overview.nodes}
        {@const short = overview.nodes.ready < overview.nodes.total}
        <div class="card" class:alert={short}>
          <span class="label">Nodes ready</span>
          <div class="card-foot"><span class="num">{overview.nodes.ready}/{overview.nodes.total}</span><Icon name="node" size={18} /></div>
        </div>
      {/if}
      {#if pods}
        {@const scope = pods.namespace ? ` in ${pods.namespace}` : ""}
        <div class="card" class:wide={scope !== ""} title="Pods{scope}">
          <span class="label">Pods{scope}</span>
          <div class="card-foot"><span class="num">{pods.total}</span><Icon name="pod" size={18} /></div>
        </div>
        {#each podCards(pods) as c (c.label)}
          {@const look = STATUS_LOOK[c.label]}
          <div
            class="card tone-{look?.tone ?? 'muted'}"
            class:alert={c.alert}
            class:zero={c.value === 0}
            title={c.title}
          >
            <span class="label">{c.label}</span>
            <div class="card-foot"><span class="num">{c.value}</span><Icon name={look?.icon ?? "pod"} size={18} /></div>
          </div>
        {/each}
      {/if}
    </div>

    <!-- Wide: what needs you and the capacity on the left, the namespaces
         beside them. On a calm watch the capacity comes first. -->
    <div class="body" class:calm={calmBody}>
      <div class="sections">
        <section aria-label="Problem pods">
          <div class="sec-head">
            <h3>
              Problem pods{pods && pods.problems_total > pods.problems.length
                ? ` (${pods.problems.length} of ${pods.problems_total})`
                : ""}
            </h3>
            {#if pods && pods.problems_total > 0}<span class="count" aria-hidden="true">{pods.problems_total}</span>{/if}
          </div>
          {#if pods}
            <div class="stack">
              {#each pods.problems as p (p.namespace + "/" + p.name)}
                {@const error = p.reason === p.status}
                <div class="problem" class:error>
                  <div class="tile" aria-hidden="true"><Icon name={error ? "error" : "pending"} size={18} /></div>
                  <div class="what">
                    {#if podKind}
                      <button
                        type="button"
                        class="name link"
                        onclick={() => podKind && openObject(podKind, p.namespace, p.name)}
                      ><span class="ns">{p.namespace}/</span>{p.name}</button>
                    {:else}
                      <span class="name"><span class="ns">{p.namespace}/</span>{p.name}</span>
                    {/if}
                    <div class="meta">
                      <span class="reason" class:error>{p.reason}</span>
                      {#if p.restarts > 0}<span>{p.restarts} restarts</span>{/if}
                    </div>
                  </div>
                  {#if podKind}
                    <div class="actions">
                      {#if p.status !== "Pending"}
                        <button
                          type="button"
                          class="btn act"
                          aria-label={`Logs of ${p.namespace}/${p.name}`}
                          onclick={() => showLogs(p.namespace, p.name)}
                        >
                          <Icon name="logs" size={14} />Logs
                        </button>
                      {/if}
                      <button
                        type="button"
                        class="btn act"
                        aria-label={`Describe ${p.namespace}/${p.name}`}
                        onclick={() => podKind && openObject(podKind, p.namespace, p.name)}
                      >
                        <Icon name="describe" size={14} />Describe
                      </button>
                    </div>
                  {/if}
                </div>
              {:else}
                <div class="empty"><CalmWater mark="buoy"><p class="none">None.</p></CalmWater></div>
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
            </div>
          {:else}
            <p class="muted denied">Not allowed.</p>
          {/if}
        </section>
        <section aria-label="Warnings">
          <div class="sec-head">
            <h3>Warnings{overview.events?.namespace ? ` in ${overview.events.namespace}` : ""}</h3>
            {#if (overview.events?.items.length ?? 0) > 0}
              <span class="count warn" aria-hidden="true">{overview.events?.items.length}</span>
            {/if}
          </div>
          <div class="stack">
            {#each overview.events?.items ?? [] as e (e.key)}
              {@const linked = eventKind(e, kinds.all)}
              <div class="event">
                <div class="tile" aria-hidden="true"><Icon name="warning" size={18} /></div>
                <div class="what">
                  <div class="e-head">
                    <span class="reason">{e.reason}</span>
                    {#if linked}
                      <button type="button" class="link object" onclick={() => openEvent(e)}>{e.object}</button>
                    {:else}
                      <span class="object muted">{e.object}</span>
                    {/if}
                    <span class="age">{formatAge(e.time, now, "")}</span>
                  </div>
                  <p class="message">{e.message}<span class="times">{e.count > 1 ? ` (x${e.count})` : ""}</span></p>
                </div>
              </div>
            {:else}
              {#if overview.events}
                <div class="empty"><CalmWater mark="lighthouse"><p class="none">No warnings.</p></CalmWater></div>
              {:else}
                <p class="muted denied">Not allowed.</p>
              {/if}
            {/each}
          </div>
        </section>
      </div>
      <section class="side" aria-label="Pods by namespace">
        <div class="sec-head"><h3>Pods by namespace</h3></div>
        {#if pods}
          {@const most = Math.max(1, ...pods.by_namespace.map(([, n]) => n))}
          <div class="panel">
            <table>
              <thead><tr><th>Namespace</th><th class="n">Pods</th><th class="share"><span class="sr">Share</span></th></tr></thead>
              <tbody>
                {#each pods.by_namespace as [ns, n] (ns)}
                  <tr>
                    <td>{ns}</td><td class="n">{n}</td><td class="share"
                      ><span class="share-bar" style:width="{Math.max(4, (n / most) * 100)}%"></span></td
                    >
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <p class="muted denied">Not allowed.</p>
        {/if}
      </section>
      {#if overview.capacity}
        <section class="capacity" aria-label="Capacity">
          <div class="sec-head"><h3>Capacity</h3></div>
          <div class="panel pad">
            <!-- One row per resource: the figure above its bar, the limits
                 and usage under it. -->
            <div class="bars">
              {#each capacityBars(overview.capacity) as bar (bar.label)}
                <div class="bar-row">
                  <div class="bar-top">
                    <span class="bar-label"><Icon name={CAPACITY_ICONS[bar.label] ?? "gauge"} size={15} />{bar.label}</span>
                    <span class="bar-text">{bar.text}</span>
                  </div>
                  <div
                    class="bar"
                    role="meter"
                    aria-label={bar.label}
                    aria-valuenow={bar.percent}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
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
                  {#if bar.limits || (!hideMetrics && bar.usage)}
                    <div class="bar-foot">
                      <span
                        class="bar-limits"
                        class:over={bar.overcommitted}
                        title={bar.overcommitted ? "The limits add up to more than the nodes can allocate" : ""}
                      >
                        {bar.limits}
                      </span>
                      <span class="bar-usage">{hideMetrics ? "" : bar.usage}</span>
                    </div>
                  {/if}
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
          </div>
        </section>
      {/if}
    </div>
  {:else if app.status.ok !== false}
    <!-- The first sounding: the rings breathe until the first update. -->
    <div class="deck waiting">
      <span class="status-mark calm" aria-hidden="true"><Icon name="refresh" size={22} /></span>
      <div class="summary">
        <span class="kicker">Watch report</span>
        <h2 class="headline">Taking the first sounding…</h2>
      </div>
    </div>
  {:else}
    <!-- Not blank under the banner (#462). -->
    <OutOfReach title={troubleTitle(app.status) ?? app.status.text} />
  {/if}
</div>

<style>
  .overview {
    flex: 1;
    overflow: auto;
    padding: 22px 24px 32px;
    container: overview / inline-size;
  }
  .notes {
    margin: 0 0 18px;
    padding: 10px 14px 10px 30px;
    font-size: var(--text-sm);
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
  }

  /* The deck: one headline, what the watch found. */
  .deck {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 20px;
  }
  .status-mark {
    --tone: var(--amber);
    display: grid;
    place-items: center;
    flex-shrink: 0;
    width: 44px;
    height: 44px;
    border-radius: 12px;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 14%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tone) 24%, transparent);
  }
  .status-mark.calm {
    --tone: var(--accent);
  }
  .waiting .status-mark {
    animation: breathe 1800ms ease-in-out infinite;
  }
  @keyframes breathe {
    50% {
      opacity: 0.45;
    }
  }
  .summary {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .kicker {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--text-muted);
  }
  .headline {
    margin: 0;
    font-size: var(--text-2xl);
    font-weight: var(--weight-semibold);
    letter-spacing: -0.022em;
    line-height: 1.15;
  }

  /* Stat cards: what is there, at a glance. A colour only where it means
     something: the icon says the state, red numbers need you. */
  .cards {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(108px, 1fr));
    gap: 8px;
    margin-bottom: 30px;
  }
  .card {
    --tone: var(--text-muted);
    min-width: 0;
    padding: 10px 12px 11px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
  }
  /* "Pods in <namespace>" needs more room than one column. */
  .card.wide {
    grid-column: span 2;
  }
  .card.tone-green {
    --tone: var(--green);
  }
  .card.tone-amber {
    --tone: var(--amber);
  }
  .card.tone-red {
    --tone: var(--red);
  }
  .card-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    margin-top: 4px;
    color: var(--tone);
  }
  .card.zero .card-foot {
    color: var(--text-muted);
  }
  .label {
    display: block;
    min-width: 0;
    color: var(--text-muted);
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    /* One line: a long namespace ("Pods in team-a") ellipsizes, the card's
       title has the full text. */
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .num {
    font-size: 24px;
    color: var(--text);
    font-weight: var(--weight-semibold);
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.02em;
    line-height: 1.1;
  }
  .card.zero .num {
    color: var(--text-muted);
    opacity: 0.55;
  }
  .card.alert {
    border-color: color-mix(in srgb, var(--red) 45%, var(--border));
    background: color-mix(in srgb, var(--red) 7%, var(--bg-card));
  }
  .card.alert .num,
  .card.alert .label {
    color: var(--red);
  }

  /* The body: sections with a heading at a real size, their items as cards. */
  .body {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: "attention" "side" "capacity";
    gap: 30px;
  }
  .sections {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: 30px;
    grid-area: attention;
    align-content: start;
    min-width: 0;
  }
  .side {
    grid-area: side;
    min-width: 0;
  }
  .capacity {
    grid-area: capacity;
    min-width: 0;
  }
  .sec-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }
  h3 {
    margin: 0;
    font-size: var(--text-lg);
    font-weight: var(--weight-semibold);
    letter-spacing: -0.01em;
    color: var(--text);
  }
  .count {
    min-width: 22px;
    padding: 1px 7px;
    border-radius: 999px;
    text-align: center;
    font-size: var(--text-xs);
    font-weight: var(--weight-semibold);
    font-variant-numeric: tabular-nums;
    color: var(--red);
    background: color-mix(in srgb, var(--red) 14%, transparent);
  }
  .count.warn {
    color: var(--amber);
    background: color-mix(in srgb, var(--amber) 16%, transparent);
  }
  .stack {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .panel,
  .problem,
  .event,
  .empty {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: var(--radius-card);
    box-shadow: var(--shadow-card);
  }
  .panel {
    overflow: hidden;
  }
  .panel.pad {
    padding: 14px 16px 16px;
  }
  .empty {
    padding: 4px 16px;
  }
  .none {
    margin: 0;
  }
  .denied {
    margin: 0;
    font-size: var(--text-base);
  }

  /* A problem pod or a warning: its state as a tinted tile, what it is,
     and what to do about it on the card. */
  .problem,
  .event {
    --tone: var(--amber);
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;
  }
  .problem.error {
    --tone: var(--red);
  }
  .event {
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
  }
  .tile {
    display: grid;
    place-items: center;
    width: 34px;
    height: 34px;
    border-radius: 9px;
    color: var(--tone);
    background: color-mix(in srgb, var(--tone) 13%, transparent);
  }
  .what {
    min-width: 0;
  }
  .name {
    display: block;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--text-md);
    font-weight: var(--weight-semibold);
    color: var(--text);
    text-align: left;
  }
  .name .ns {
    font-weight: 400;
    color: var(--text-muted);
  }
  button.name:hover {
    color: var(--accent);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    margin-top: 2px;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .meta .reason {
    font-weight: var(--weight-semibold);
    color: var(--amber);
  }
  .meta .reason.error {
    color: var(--red);
  }
  .actions {
    display: flex;
    gap: 6px;
  }
  .act {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    color: var(--text);
    background: var(--bg);
  }
  .act:hover {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    color: var(--accent);
  }
  .e-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 2px 10px;
    font-size: var(--text-base);
  }
  .e-head .reason {
    font-weight: var(--weight-semibold);
  }
  .age {
    margin-left: auto;
    font-size: var(--text-sm);
    color: var(--text-muted);
    font-variant-numeric: tabular-nums;
  }
  .message {
    margin: 3px 0 0;
    font-size: var(--text-base);
    line-height: 1.45;
    color: var(--text-muted);
    overflow-wrap: anywhere;
  }
  .times {
    font-weight: var(--weight-medium);
  }
  .link {
    background: transparent;
    border: none;
    color: var(--accent);
    padding: 0;
    font: inherit;
    cursor: pointer;
  }
  .link.object:hover {
    text-decoration: underline;
  }
  button.name {
    font-weight: var(--weight-semibold);
    font-size: var(--text-md);
  }

  /* A problem that just cleared: a teal tick drawn once, then the line goes. */
  .cleared {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 6px 12px;
    font-size: var(--text-base);
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
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
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

  /* Pods by namespace: a short table in a card, each count with its share. */
  .side table {
    font-size: var(--text-base);
  }
  .side th {
    padding: 9px 14px;
    font-family: var(--font-ui);
    font-size: var(--text-sm);
    font-weight: var(--weight-semibold);
    text-transform: none;
    letter-spacing: 0;
    background: color-mix(in srgb, var(--bg-hover) 45%, transparent);
  }
  .side td {
    padding: 7px 14px;
  }
  .side tbody tr:last-child td {
    border-bottom: none;
  }
  .side .n {
    text-align: right;
    width: 64px;
  }
  .side .share {
    width: 34%;
    padding-left: 4px;
  }
  .share-bar {
    display: block;
    height: 6px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--accent) 55%, transparent);
  }
  .sr {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* Capacity: requests against what the nodes can allocate. */
  .bars {
    display: flex;
    flex-direction: column;
    gap: 16px;
    font-size: var(--text-base);
  }
  .bar-top,
  .bar-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 2px 16px;
  }
  .bar-top {
    margin-bottom: 7px;
  }
  .bar-foot {
    margin-top: 6px;
    font-size: var(--text-sm);
    color: var(--text-muted);
  }
  .bar-label {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-weight: var(--weight-semibold);
  }
  .bar-label :global(.icon) {
    color: var(--text-muted);
    align-self: center;
  }
  .bar-text {
    font-variant-numeric: tabular-nums;
  }
  .bar {
    position: relative;
    height: 8px;
    background: var(--bg-hover);
    border-radius: 4px;
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
    border-radius: 4px;
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 45%, transparent), var(--accent));
    transition: width 700ms var(--ease-out);
  }
  .fill.high {
    background: var(--amber);
  }
  .small {
    font-size: var(--text-sm);
  }

  @container overview (min-width: 1000px) {
    .body {
      grid-template-columns: minmax(0, 1.8fr) minmax(280px, 1fr);
      grid-template-areas: "attention side" "capacity side";
      grid-template-rows: auto 1fr;
      gap: 30px 24px;
    }
    .body.calm {
      grid-template-areas: "capacity side" "attention side";
    }
    /* Nothing to attend to: the two calm notes side by side. */
    .body.calm .sections {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .capacity {
      --chart-h: 180px;
    }
  }
  /* Narrow: the actions go under what they act on. */
  @container overview (max-width: 560px) {
    .problem {
      grid-template-columns: auto minmax(0, 1fr);
    }
    .actions {
      grid-column: 2;
    }
  }
</style>

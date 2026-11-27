import { GiveUp, clearStalled, markStalled, reconnectStoppedMessage, retryDelay, stoppedMessage } from "../retry";
import { Channel } from "@tauri-apps/api/core";
import { api, onClusterSwitch, visibleCluster } from "../cluster";
import type { WatchMessage } from "../bindings";
import type { CustomColumn, MetricsKind, MetricsSnapshot, ResourceKind } from "../bindings";
import { EMPTY_METRICS, HIDDEN_METRICS, isNode, isPod } from "../columns";
import type { Metrics, Row } from "../columns";
import { setStatus, showError, stamp } from "./app.svelte";
import { clusterError } from "../clusterError";
import { combineWatches } from "../namespaces";
import type { WatchStatus } from "../namespaces";
import { KeyedStore } from "./keyed.svelte";
import { ageRedrawMs } from "../format";
import { onAgeTick } from "../ageClock";

const METRICS_INTERVAL_MS = 20_000;

/** One backend watch: a namespace, or `""` for all namespaces / cluster scope. */
interface Watch {
  key: string;
  /** Known once `cmd_watch_start` resolves. */
  id: string | null;
  starting: boolean;
  /** Stopped or given up: what its channel still delivers is dropped. */
  done: boolean;
  status: WatchStatus;
  retry: ReturnType<typeof setTimeout> | null;
  /** Counts how long it has been reconnecting. */
  giveUp: GiveUp;
}

/**
 * The live table behind every resource view.
 *
 * The backend watches the cluster and pushes coalesced batches
 * ({snapshot, applied, deleted}) and state changes on the channel each
 * watch was started with (#115); the batches land in a keyed store. With several
 * namespaces selected there is one watch per namespace, all feeding the same
 * store: each watch is a source there, so its snapshot only replaces its own
 * rows. Metrics cannot be watched, so they are polled and merged at render
 * time, and ages are recomputed from `created` whenever `now` ticks.
 */
export class LiveTable {
  store = new KeyedStore<Row>((row) => row.key);
  metrics = $state.raw<Metrics>(EMPTY_METRICS);
  now = $state.raw(Date.now());
  /** A first batch has arrived since `start`, so the rows are not just empty. */
  synced = $state.raw(false);
  /** The cluster serves no metrics API (no metrics-server): the CPU and
   *  memory columns stay empty, and the table says why (#485). */
  metricsMissing = $state.raw(false);

  #kind: ResourceKind | null = null;
  /** The running watches by key, in selection order. */
  #watches = new Map<string, Watch>();
  /** Bumped when the watched set changes, to drop stale metrics. */
  #token = 0;
  #metricsTimer: ReturnType<typeof setInterval> | null = null;
  #stopAges: (() => void) | null = null;
  /** Metrics hidden for the cluster (#327): nothing is polled. */
  #metricsHidden = false;

  /** One message on the channel of `w`; it may come before its id is known. */
  #handle(w: Watch, m: WatchMessage) {
    if (w.done) return;
    if (m.type === "batch") {
      this.store.applyBatch(m, w.key);
      if (!this.synced) this.synced = true;
      stamp();
    } else {
      const s = m;
      w.status = {
        namespace: w.status.namespace,
        state: s.state,
        error: "error" in s ? s.error : "",
        interval: "interval_secs" in s ? s.interval_secs : undefined,
      };
      this.#publishState();
      // The backend reconnects for as long as it is asked to: after five
      // minutes of it, stop this watch and say so (lib/retry.ts).
      if (s.state === "reconnecting") w.giveUp.arm(() => this.#giveUp(w));
      else w.giveUp.clear();
    }
  }

  #publishState() {
    const kind = this.#kind;
    if (!kind || this.#watches.size === 0) return;
    const c = combineWatches(
      [...this.#watches.values()].map((w) => w.status),
      kind.label,
      kind.resource.namespaced,
    );
    setStatus(c.ok, c.text);
    if (c.error !== null) showError(c.error);
  }

  /** Failed starts of each watch key, for the growing wait between retries. */
  #attempts = new Map<string, number>();

  /** The watch keys for a selection: one per namespace, or `""` for all. */
  #keysFor(namespaces: readonly string[]): string[] {
    if (!this.#kind?.resource.namespaced || namespaces.length === 0) return [""];
    return [...namespaces];
  }

  /** The custom columns the rows carry cells for (#547), after the kind's own. */
  #custom: CustomColumn[] = [];

  /** Watch `kind` in `namespaces` (empty: all namespaces), from scratch,
   *  with a cell for each of the `custom` columns. */
  start(kind: ResourceKind, namespaces: readonly string[], custom: readonly CustomColumn[] = []) {
    this.stop();
    this.#attempts.clear();
    this.#kind = kind;
    this.#custom = [...custom];
    this.store.clear();
    this.synced = false;
    for (const key of this.#keysFor(namespaces)) void this.#startWatch(key);
    this.#publishState();
    this.#startMetrics();
    // A cheap check on the shared age tick; ages redraw every second only while one of
    // them shows seconds (kubectl's "3m10s", #380), else every 15 s.
    this.#stopAges = onAgeTick((now) => this.#tickAges(now));
  }

  /**
   * Change the namespaces of the running table: start watches for the added
   * ones, stop the removed ones and drop their rows. The others keep going.
   */
  setNamespaces(namespaces: readonly string[]) {
    if (!this.#kind) return;
    const want = this.#keysFor(namespaces);
    const before = [...this.#watches.keys()];
    if (before.length === want.length && before.every((k, i) => k === want[i])) return;
    for (const [key, w] of [...this.#watches]) {
      if (!want.includes(key)) {
        this.#stopWatch(w);
        this.store.removeSource(key);
      }
    }
    // Keep the map in selection order, so messages list namespaces that way.
    const kept = new Map(this.#watches);
    this.#watches.clear();
    for (const key of want) {
      const w = kept.get(key);
      if (w) this.#watches.set(key, w);
      else void this.#startWatch(key);
    }
    this.#publishState();
    this.#startMetrics();
  }

  async #startWatch(key: string) {
    const kind = this.#kind;
    if (!kind) return;
    const namespace = key || null;
    const w: Watch = {
      key,
      id: null,
      starting: true,
      done: false,
      status: { namespace, state: "connecting", error: "" },
      retry: null,
      giveUp: new GiveUp(),
    };
    this.#watches.set(key, w);
    let id: string;
    try {
      // Its own channel: messages arrive in order, only here (#115).
      const channel = new Channel<WatchMessage>((m) => this.#handle(w, m));
      id = await api(visibleCluster()).cmdWatchStart(kind.resource, namespace, this.#custom, channel);
    } catch (e) {
      if (this.#watches.get(key) !== w) return;
      w.starting = false;
      const err = clusterError(e);
      // Wait longer each time, and stop after a few minutes (lib/retry.ts):
      // Refresh, or opening the table again, starts over.
      const attempt = (this.#attempts.get(key) ?? 0) + 1;
      this.#attempts.set(key, attempt);
      const wait = retryDelay(attempt);
      w.status = {
        namespace,
        state: "failed",
        error: wait === null ? stoppedMessage(err.message) : err.message,
        status: err.status,
      };
      // Not running: a wake or the network coming back restarts it (#526).
      markStalled(w);
      this.#publishState();
      if (wait !== null) {
        w.retry = setTimeout(() => {
          if (this.#watches.get(key) !== w) return;
          this.#watches.delete(key);
          clearStalled(w);
          void this.#startWatch(key);
        }, wait);
      }
      return;
    }
    if (this.#watches.get(key) !== w) {
      // Stopped (or the table restarted) while starting.
      api(visibleCluster()).cmdWatchStop(id).catch(() => {});
      return;
    }
    w.id = id;
    w.starting = false;
    this.#attempts.delete(key);
  }

  /** Stop a watch that kept reconnecting; its rows stay, marked as not current. */
  #giveUp(w: Watch) {
    if (this.#watches.get(w.key) !== w || !w.id) return;
    w.done = true;
    api(visibleCluster()).cmdWatchStop(w.id).catch(() => {});
    w.id = null;
    markStalled(w);
    w.status = {
      namespace: w.status.namespace,
      state: "failed",
      error: reconnectStoppedMessage(w.status.error),
      status: "Not connected",
    };
    this.#publishState();
  }

  #stopWatch(w: Watch) {
    w.done = true;
    w.giveUp.clear();
    clearStalled(w);
    // A namespace selected again starts its retries over.
    this.#attempts.delete(w.key);
    if (w.retry) clearTimeout(w.retry);
    w.retry = null;
    if (this.#watches.get(w.key) === w) this.#watches.delete(w.key);
    if (w.id) api(visibleCluster()).cmdWatchStop(w.id).catch(() => {});
  }

  stop() {
    this.#token++;
    for (const w of [...this.#watches.values()]) this.#stopWatch(w);
    this.#watches.clear();
    if (this.#metricsTimer) clearInterval(this.#metricsTimer);
    this.#stopAges?.();
    this.#metricsTimer = this.#stopAges = null;
    this.#kind = null;
  }

  /** Hide metrics (#327): stop polling and drop them; or poll again. Set
   *  before `start` so a hidden cluster is never polled. */
  setMetricsHidden(hidden: boolean) {
    if (hidden === this.#metricsHidden) return;
    this.#metricsHidden = hidden;
    this.metrics = hidden ? HIDDEN_METRICS : EMPTY_METRICS;
    if (this.#kind) this.#startMetrics();
  }

  /** Only pods and nodes have metric columns; poll just the one on screen. */
  #startMetrics() {
    this.#token++;
    this.metricsMissing = false;
    if (this.#metricsTimer) clearInterval(this.#metricsTimer);
    this.#metricsTimer = null;
    if (this.#metricsHidden) return;
    const kind = this.#kind;
    const what: MetricsKind | null = !kind ? null : isPod(kind) ? "pods" : isNode(kind) ? "nodes" : null;
    if (!what) return;
    this.loadMetrics(what);
    this.#metricsTimer = setInterval(() => this.loadMetrics(what), METRICS_INTERVAL_MS);
  }

  /** Metrics can't be watched: poll them and merge into the live rows. */
  async loadMetrics(what: MetricsKind) {
    const token = this.#token;
    // Pod metrics only for the namespaces the table shows, one call each.
    const scopes = what === "pods" ? [...this.#watches.keys()].map((k) => k || null) : [null];
    // Nodes' root filesystems from Prometheus (#225), for the Disk column:
    // merged when they arrive, so a slow Prometheus never holds up CPU and memory.
    if (what === "nodes") void this.#loadDisks(token);
    const results = await Promise.allSettled(scopes.map((ns) => api(visibleCluster()).cmdGetMetrics(ns, what)));
    if (token !== this.#token) return;
    // Metrics are best effort; the tables show "—" without them.
    const snaps = results
      .filter((r): r is PromiseFulfilledResult<MetricsSnapshot> => r.status === "fulfilled")
      .map((r) => r.value);
    this.metricsMissing = snaps.length > 0 && snaps.every((s) => !s.available);
    this.metrics = {
      pods: new Map(snaps.flatMap((s) => s.pods.map((p) => [`${p.namespace}/${p.name}`, p] as const))),
      nodes: new Map(snaps.flatMap((s) => s.nodes.map((n) => [n.name, n] as const))),
      // The backend records each poll into its usage history (#47).
      sparks: new Map(snaps.flatMap((s) => Object.entries(s.sparks))),
      since: earliest(snaps.map((s) => s.since)),
      disks: what === "nodes" ? this.metrics.disks : undefined,
    };
    this.now = Date.now();
  }

  #tickAges(now: number) {
    let newest = 0;
    for (const e of this.store.entries) if (e.row.created > newest) newest = e.row.created;
    if (now - this.now >= ageRedrawMs(newest, now) - 50) this.now = now;
  }

  async #loadDisks(token: number) {
    const view = await api(visibleCluster()).cmdNodeDiskUsage().catch(() => null);
    if (token !== this.#token) return;
    this.metrics = { ...this.metrics, disks: new Map((view?.nodes ?? []).map((d) => [d.name, d] as const)) };
  }
}

/** The earliest of some epoch-ms times, ignoring 0 (none); 0 if all are. */
function earliest(times: number[]): number {
  const set = times.filter((t) => t > 0);
  return set.length > 0 ? Math.min(...set) : 0;
}

export const live = new LiveTable();

// The rows of one cluster never show for the next (ADR 0007).
onClusterSwitch(() => {
  live.stop();
  live.store.clear();
  live.synced = false;
});

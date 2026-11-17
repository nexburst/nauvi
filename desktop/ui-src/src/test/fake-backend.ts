/**
 * Fake Tauri backend for the Playwright app tests (`src/test/e2e`).
 *
 * `installFakeBackend()` routes every `invoke` through `mockIPC` from
 * `@tauri-apps/api/mocks` with `shouldMockEvents`, so the app's
 * `events.*(thisWindow()).listen` calls work and the fake can emit events.
 * Commands are served from an in-memory cluster (`fixtures/cluster.ts`).
 * The page is the main window; `test.html?window=cluster-1` makes it a window
 * opened for a context (the mock ignores event targets, so every event
 * reaches the page either way).
 *
 * Tests drive it from Playwright through `window.__fake` (see `FakeApi`):
 *
 *     await page.evaluate(() => window.__fake.emitWatchBatch({ deleted: ["demo/web-1"] }));
 *     await page.evaluate(() => window.__fake.calls("cmdStreamPodLogs"));
 *
 * The handlers live in `fake/`, one file per backend command module
 * (`desktop/src/commands/helm_charts.rs` -> `fake/helm-charts.ts`), merged
 * by `fake/index.ts`. What they share (the cluster, the running watches and
 * streams, helpers like `findRow`) is `FakeState` in `fake/state.ts`.
 *
 * ## Adding a command
 *
 * 1. Regenerate `bindings.ts` as usual. `npm run check` now fails in
 *    `fake/index.ts`: the handlers must implement every command in
 *    `commands`, with its exact parameters and return type.
 * 2. Add the handler to the file of its module in `fake/` (a new module: a
 *    new file like the others, added at its sorted place in `fake/index.ts`).
 *    It gets the command's arguments positionally, like the function in
 *    `bindings.ts`, and returns the result (or throws a string, which is how
 *    a Rust `Err(String)` arrives). Keep the data in `FakeCluster` so tests
 *    can change it instead of the handler.
 * 3. Write the test in `src/test/e2e/`; `fake.failNext("cmdYourCommand", "...")`
 *    and `fake.calls("cmdYourCommand")` work for every command.
 *
 * Cluster-scoped commands (all but `GLOBAL_COMMANDS` in `lib/cluster.ts`)
 * arrive with a `cluster` argument: the fake checks that it is there and
 * gives the handler the other arguments.
 *
 * ## Streams over a channel
 *
 * Log streams get a `Channel` (#115): the handler keeps it (`logChannels`)
 * and `sendLog` calls its `onmessage` directly, the way the real one is
 * called for each message (lines as a raw `ArrayBuffer`, the rest as JSON).
 *
 * ## Adding an event
 *
 * Emit it with `events.<name>.emit(payload)` from `bindings.ts` (typed), and
 * add an `emit…` helper to `FakeApi` if tests need to send it themselves.
 */

import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { events } from "../lib/bindings";
import { isClusterCommand, isMutatingCommand } from "../lib/cluster";
import { gateRefusal } from "./fake/gate";
import type { DetailState, LinkRequest, LogMessage, Overview_Serialize, TaggedLine, WatchBatch, WatchState } from "../lib/bindings";
import type { ClusterStateChanged } from "../lib/bindings";
import { defaultCluster } from "./fixtures/cluster";
import type { FakeCluster } from "./fixtures/cluster";
import { available } from "./fixtures/updates";
import { prometheusFixture } from "./fixtures/usage";
import { workloadsOverview } from "./fixtures/workloads";
import { allHandlers } from "./fake";
import { copy, newState } from "./fake/state";
import type { CommandName } from "./fake/state";

export type { CommandName } from "./fake/state";
export { SETTINGS_KEY } from "./fake/state";

/** Raw IPC arguments of one call, keyed like the Rust parameters. */
export type CallArgs = Record<string, unknown>;

/** What tests reach through `window.__fake`. */
export interface FakeApi {
  /** The in-memory cluster; change it freely between steps. */
  cluster: FakeCluster;
  /** Arguments of every call of `cmd` so far, oldest first. */
  calls(cmd: CommandName): CallArgs[];
  /** `[command, cluster]` of every cluster-scoped call so far, oldest first
   *  (ADR 0007): which cluster each one asked. */
  clusterCalls(): [CommandName, string][];
  /** The clusters connected in the background (`cmd_cluster_connect`). */
  connected(): string[];
  /** Make the next call of `cmd` fail with `error` (a Rust `Err(String)`). */
  failNext(cmd: CommandName, error: string): void;
  /** Id of the most recent watch (`cmd_watch_start`), or null. */
  lastWatchId(): string | null;
  /** The watches that were started and not stopped, oldest first. */
  activeWatches(): { id: string; namespace: string | null }[];
  /** `streamId` of the most recent log stream (pod or workload), or null. */
  lastStreamId(): number | null;
  /** Ids of the log streams started and not stopped, oldest first. */
  activeLogStreams(): number[];
  /** Send a `watch-batch`; `id` defaults to the latest watch. */
  emitWatchBatch(batch: Partial<WatchBatch>): Promise<void>;
  /** Send a `watch-state`; `id` defaults to the latest watch. */
  emitWatchState(state: WatchState & { id?: string }): Promise<void>;
  /** Id of the most recent detail watch (`cmd_detail_watch`), or null. */
  lastDetailWatchId(): string | null;
  /** Ids of the detail watches that were started and not stopped. */
  activeDetailWatches(): string[];
  /** Send a `detail-watch`; `id` defaults to the latest detail watch. */
  emitDetail(state: DetailState & { id?: string }): Promise<void>;
  /** Id of the most recent overview feed (`cmd_overview_start`), or null. */
  lastOverviewId(): number | null;
  /** Ids of the overview feeds started and not stopped. */
  overviewFeeds(): number[];
  /** Merge `change` into `cluster.overview` and send it; `id` defaults to the latest feed. */
  emitOverview(change: Partial<Overview_Serialize>, id?: number): Promise<void>;
  /** Send an `overview-state`; `id` defaults to the latest feed. */
  emitOverviewState(state: WatchState & { id?: number }): Promise<void>;
  /** The Workloads overview feeds started and not stopped, with their namespaces. */
  workloadsFeeds(): { id: number; namespaces: string[] }[];
  /** Recompute the Workloads overview of the latest feed from `cluster.rows` and send it. */
  emitWorkloads(): Promise<void>;
  /** Send lines on a log stream's channel; `streamId` defaults to the latest stream. */
  emitLogLines(lines: string[], streamId?: number): Promise<void>;
  /** Send tagged lines (merged streams: workloads, all containers of a pod). */
  emitTaggedLines(lines: TaggedLine[], streamId?: number): Promise<void>;
  /** Send an error, then (if `done`) the end, on a log stream's channel. */
  emitLogEnd(error: string, done?: boolean, streamId?: number): Promise<void>;
  /** URLs the app asked `tauri-plugin-opener` to open. */
  opened(): string[];
  /** Give the cluster a Prometheus with series for demo/web-1 and node-1 (`fixtures/usage.ts`). */
  installPrometheus(): void;
  /** Make the update check find `version` (`fixtures/updates.ts`). */
  offerUpdate(version: string, canInstall?: boolean, note?: string): void;
  /** `cmd_update_install` stops half way through the download until this is called. */
  finishUpdateDownload(): void;
  /** Whether `cmd_update_install` finished (the real app restarts then). */
  restarted(): boolean;
  /** Send `kubeconfigs-changed`, as the backend does when a kubeconfig file changes. */
  emitKubeconfigsChanged(): Promise<void>;
  /** The idle reaper's report about a background cluster (#333). */
  emitClusterState(change: ClusterStateChanged): Promise<void>;
  /** Send `unsaved-close-requested`, as the backend does when closing (or, `quit`, quitting) meets unsaved edits. */
  emitUnsavedCloseRequested(quit?: boolean): Promise<void>;
  /** Send `exec-output`: `data` printed by the shell of `session` (`exec-1` is the first). */
  emitExecOutput(session: string, data: string): Promise<void>;
  /** Queue a nauvi:// link request for the window (#299), as a launch with a link does. */
  queueLink(request: LinkRequest): void;
  /** Queue it and send `link-pending`, as a second launch with a link does. */
  openLink(request: LinkRequest): Promise<void>;
}

declare global {
  interface Window {
    __fake: FakeApi;
    /** Set by a Playwright init script to adjust the fake before the app mounts. */
    __fakeInit?: (cluster: FakeCluster, fake: FakeApi) => void;
  }
}

const toCamel = (cmd: string) => cmd.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as CommandName;

export function installFakeBackend(cluster: FakeCluster = defaultCluster()): FakeApi {
  const calls = new Map<CommandName, CallArgs[]>();
  const failures = new Map<CommandName, string[]>();
  const clusterCalls: [CommandName, string][] = [];
  const st = newState(cluster);
  const HANDLERS = allHandlers(st);

  const opened: string[] = [];

  async function handle(cmd: string, args: CallArgs | undefined): Promise<unknown> {
    // tauri-plugin-opener's `openUrl` (Open in browser).
    if (cmd === "plugin:opener|open_url") {
      opened.push(String(args?.url));
      return null;
    }
    const name = toCamel(cmd);
    const handler = HANDLERS[name] as ((...a: unknown[]) => unknown) | undefined;
    if (!handler) throw new Error(`fake backend: no handler for ${cmd}`);
    let list = calls.get(name);
    if (!list) calls.set(name, (list = []));
    // A JSON copy, like real IPC (and app state may hold Svelte proxies, which
    // structuredClone rejects).
    // Cluster-scoped commands name their cluster first (ADR 0007); the
    // handlers and `calls` leave it out.
    const { cluster: target, ...rest } = args ?? {};
    const named = typeof target === "string" || (isMutatingCommand(name) && typeof target === "object" && !!target);
    if (isClusterCommand(name) !== named) {
      throw new Error(`fake backend: ${cmd} ${isClusterCommand(name) ? "needs" : "takes no"} cluster (lib/cluster.ts)`);
    }
    // The backend's gate runs before the command (`state/mutation.rs`).
    if (isMutatingCommand(name)) {
      const refused = gateRefusal(st, name, target, rest);
      if (refused) throw refused;
    }
    list.push(JSON.parse(JSON.stringify(rest)) as CallArgs);
    st.target = typeof target === "string" ? target : "";
    if (typeof target === "string") clusterCalls.push([name, target]);
    const fail = failures.get(name)?.shift();
    if (fail !== undefined) throw fail;
    // `bindings.ts` builds the argument object in parameter order.
    return handler(...Object.values(rest));
  }

  /** One message to the channel of log stream `id` (default: the latest). */
  function sendLog(id: number | undefined, message: LogMessage) {
    const ch = st.logChannels.get(id ?? st.streamId ?? -1);
    ch?.onmessage(message);
  }

  mockIPC((cmd, args) => handle(cmd, args as CallArgs | undefined), { shouldMockEvents: true });
  mockWindows(new URLSearchParams(location.search).get("window") ?? "main");

  const api: FakeApi = {
    cluster,
    calls: (cmd) => calls.get(cmd) ?? [],
    clusterCalls: () => clusterCalls.map(([c, t]) => [c, t]),
    connected: () => [...st.connected],
    failNext: (cmd, error) => {
      const list = failures.get(cmd) ?? [];
      list.push(error);
      failures.set(cmd, list);
    },
    lastWatchId: () => (st.watchSeq ? `watch-${st.watchSeq}` : null),
    activeWatches: () => st.watches.map((w) => ({ id: w.id, namespace: w.namespace })),
    lastStreamId: () => st.streamId,
    activeLogStreams: () => [...st.logStreams],
    emitWatchBatch: (b) =>
      events.watchBatch.emit({
        id: b.id ?? api.lastWatchId() ?? "",
        snapshot: b.snapshot ?? false,
        applied: b.applied ?? [],
        deleted: b.deleted ?? [],
      }),
    emitWatchState: (s) => events.watchState.emit({ ...s, id: s.id ?? api.lastWatchId() ?? "" }),
    lastDetailWatchId: () => (st.detailSeq ? `detail-${st.detailSeq}` : null),
    activeDetailWatches: () => [...st.detailWatches.keys()],
    emitDetail: (s) => events.detailWatch.emit({ ...s, id: s.id ?? api.lastDetailWatchId() ?? "" }),
    lastOverviewId: () => st.lastOverview,
    overviewFeeds: () => [...st.overviewFeeds],
    emitOverview: (change, id) => {
      Object.assign(cluster.overview, change);
      return events.overviewUpdate.emit({ id: id ?? st.lastOverview ?? -1, overview: copy(cluster.overview) });
    },
    emitOverviewState: (s) => events.overviewState.emit({ ...s, id: s.id ?? st.lastOverview ?? -1 }),
    workloadsFeeds: () => [...st.workloadsFeeds].map(([id, namespaces]) => ({ id, namespaces })),
    emitWorkloads: () => {
      const id = st.lastWorkloads ?? -1;
      return events.workloadsUpdate.emit({ id, overview: workloadsOverview(cluster, st.workloadsFeeds.get(id) ?? []) });
    },
    emitLogLines: async (lines, id) => sendLog(id, new TextEncoder().encode(lines.join("\n")).buffer as ArrayBuffer),
    emitTaggedLines: async (lines, id) => sendLog(id, { type: "tagged", data: lines }),
    opened: () => [...opened],
    installPrometheus: () => {
      cluster.prometheus = prometheusFixture();
    },
    offerUpdate: (version, canInstall = true, note = "") => {
      cluster.update = available(version, canInstall, note);
    },
    finishUpdateDownload: () => {
      st.finishDownload?.();
      st.finishDownload = null;
    },
    restarted: () => st.restarted,
    emitKubeconfigsChanged: () => events.kubeconfigsChanged.emit({ generation: 1 }),
    emitClusterState: (change) => events.clusterStateChanged.emit(change),
    emitLogEnd: async (error, done = true, id) => {
      if (error) sendLog(id, { type: "error", message: error });
      if (done) sendLog(id, { type: "done" });
    },
    emitUnsavedCloseRequested: (quit = false) => events.unsavedCloseRequested.emit({ quit }),
    emitExecOutput: (session, data) => events.execOutput.emit({ session, stream: "stdout", data }),
    queueLink: (request) => {
      st.link = request;
    },
    openLink: (request) => {
      st.link = request;
      return events.linkPending.emit({});
    },
  };
  window.__fake = api;
  return api;
}

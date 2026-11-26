/**
 * What the fake backend's handlers share: the command types, the in-memory
 * cluster and the bookkeeping of the running watches, streams and feeds, and
 * small helpers on them. See the header of `../fake-backend.ts`.
 */

import type { Channel } from "@tauri-apps/api/core";
import type { commands } from "../../lib/bindings";
import type { LinkRequest, LogMessage, ResourceKind, ResourceRef, ResourceRow, TermMessage } from "../../lib/bindings";
import type { ApplicationsMessage, DetailState, OverviewMessage_Serialize, WatchMessage, WorkloadsMessage } from "../../lib/bindings";
import type { ClusterCommand } from "../../lib/cluster";
import type { FakeCluster } from "../fixtures/cluster";

type Commands = typeof commands;
export type CommandName = keyof Commands;
type Result<K extends CommandName> = Awaited<ReturnType<Commands[K]>>;
/** A command's parameters without its `cluster` (ADR 0007): the fake has one
 *  cluster, and `fake-backend.ts` checks that the value is there (and, for a
 *  mutating command, emulates the read-only / protected gate, #338). */
type Args<K extends CommandName> = K extends ClusterCommand
  ? Parameters<Commands[K]> extends [unknown, ...infer A]
    ? A
    : never
  : Parameters<Commands[K]>;
type Handler<K extends CommandName> = (...args: Args<K>) => Result<K> | Promise<Result<K>>;
/** Every command must have a handler: a new command breaks `npm run check` in `index.ts`. */
export type Handlers = { [K in CommandName]: Handler<K> };
/** The handlers of one area (`satisfies AreaHandlers` types their arguments). */
export type AreaHandlers = Partial<Handlers>;

/** Where the fake keeps the settings across reloads (the real app: a file). */
export const SETTINGS_KEY = "nauvi-fake-settings";
/** Like the backend's cap on log streams. */
const MAX_LOG_STREAMS = 10;

/** The fake backend's state, shared by the handlers and `window.__fake`. */
export interface FakeState {
  cluster: FakeCluster;
  watches: { id: string; kind: ResourceKind; namespace: string | null }[];
  /** Detail watches by id, with the `kindId|rowKey` they follow. */
  detailWatches: Map<string, string>;
  watchSeq: number;
  detailSeq: number;
  drainSeq: number;
  sessionSeq: number;
  /** `streamId` of the most recent log stream. */
  streamId: number | null;
  /** Running log streams, like the backend's map (with its cap). */
  logStreams: Set<number>;
  /** The channel of every log stream started, stopped or not (stragglers can still be sent). */
  logChannels: Map<number, Channel<LogMessage>>;
  /** The channel of every terminal session started, by session id (#115). */
  termChannels: Map<string, Channel<TermMessage>>;
  /** The channel of every table watch, detail watch and overview feed
   *  started, by id, stopped or not (#115). */
  watchChannels: Map<string, Channel<WatchMessage>>;
  detailChannels: Map<string, Channel<DetailState>>;
  overviewChannels: Map<number, Channel<OverviewMessage_Serialize>>;
  workloadsChannels: Map<number, Channel<WorkloadsMessage>>;
  applicationsChannels: Map<number, Channel<ApplicationsMessage>>;
  /** Running overview feeds, and the id of the latest one. */
  overviewFeeds: Set<number>;
  lastOverview: number | null;
  /** Workloads overview feeds by id, with their namespaces. */
  workloadsFeeds: Map<number, string[]>;
  lastWorkloads: number | null;
  /** Applications feeds by id, with their namespaces. */
  applicationsFeeds: Map<number, string[]>;
  lastApplications: number | null;
  /** Releases a `cmd_update_install` waiting half way through its download. */
  finishDownload: (() => void) | null;
  restarted: boolean;
  /** The nauvi:// link request waiting for the window (#299). */
  link: LinkRequest | null;
  /** The cluster the call being handled names (`""`: a global command). */
  target: string;
  /** Clusters connected in the background (`cmd_cluster_connect`). */
  connected: Set<string>;
}

export function newState(cluster: FakeCluster): FakeState {
  try {
    const saved = sessionStorage.getItem(SETTINGS_KEY);
    if (saved) cluster.settings = JSON.parse(saved) as FakeCluster["settings"];
  } catch {
    // Keep the defaults.
  }
  return {
    cluster,
    watches: [],
    detailWatches: new Map(),
    watchSeq: 0,
    detailSeq: 0,
    drainSeq: 0,
    sessionSeq: 0,
    streamId: null,
    logStreams: new Set(),
    logChannels: new Map(),
    termChannels: new Map(),
    watchChannels: new Map(),
    detailChannels: new Map(),
    overviewChannels: new Map(),
    workloadsChannels: new Map(),
    applicationsChannels: new Map(),
    overviewFeeds: new Set(),
    lastOverview: null,
    workloadsFeeds: new Map(),
    lastWorkloads: null,
    applicationsFeeds: new Map(),
    lastApplications: null,
    finishDownload: null,
    restarted: false,
    link: null,
    target: "",
    connected: new Set(),
  };
}

const sameResource = (a: ResourceRef, b: ResourceRef) =>
  a.group === b.group && a.version === b.version && a.kind === b.kind && a.plural === b.plural;
/** A JSON copy, like an event payload over real IPC. */
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** One message on the channel of table watch `id`, a JSON copy like real IPC. */
export function sendWatch(s: FakeState, id: string, message: WatchMessage) {
  s.watchChannels.get(id)?.onmessage(copy(message));
}

/** One message on the channel of detail watch `id`. */
export function sendDetail(s: FakeState, id: string, message: DetailState) {
  s.detailChannels.get(id)?.onmessage(copy(message));
}

/** One message on the channel of overview feed `id`. */
export function sendOverview(s: FakeState, id: number, message: OverviewMessage_Serialize) {
  s.overviewChannels.get(id)?.onmessage(copy(message));
}

/** One message on the channel of Workloads overview feed `id`. */
export function sendWorkloads(s: FakeState, id: number, message: WorkloadsMessage) {
  s.workloadsChannels.get(id)?.onmessage(copy(message));
}

/** One message on the channel of applications feed `id`. */
export function sendApplications(s: FakeState, id: number, message: ApplicationsMessage) {
  s.applicationsChannels.get(id)?.onmessage(copy(message));
}
export const rowKey = (namespace: string, name: string) => (namespace ? `${namespace}/${name}` : name);

export function kindOf(s: FakeState, resource: ResourceRef): ResourceKind {
  const kind = served(s, "kinds").find((k) => sameResource(k.resource, resource));
  if (!kind) throw `the server could not find the requested resource (${resource.plural})`;
  return kind;
}

export function rowsOf(s: FakeState, kind: ResourceKind): ResourceRow[] {
  const other = s.cluster.byCluster?.[s.target]?.rows;
  if (other) return (other[kind.id] ??= []);
  return (s.cluster.rows[kind.id] ??= []);
}

/** `cluster[field]`, or what the cluster of the call serves instead (`byCluster`). */
export function served<K extends "namespaces" | "kinds">(s: FakeState, field: K): FakeCluster[K] {
  const other = s.cluster.byCluster?.[s.target];
  return other && field in other ? (other[field] as FakeCluster[K]) : s.cluster[field];
}

export function findRow(
  s: FakeState,
  resource: ResourceRef,
  namespace: string,
  name: string,
): { kind: ResourceKind; row: ResourceRow } {
  const kind = kindOf(s, resource);
  const row = rowsOf(s, kind).find((r) => r.key === rowKey(namespace, name));
  if (!row) throw `${kind.resource.plural} "${name}" not found`;
  return { kind, row };
}

/** Remove a row and tell the watches of its kind (and the detail watches
 *  of the object), like the real watches would. */
export function removeRow(s: FakeState, kind: ResourceKind, key: string) {
  s.cluster.rows[kind.id] = rowsOf(s, kind).filter((r) => r.key !== key);
  for (const w of s.watches) {
    if (w.kind.id === kind.id) sendWatch(s, w.id, { type: "batch", snapshot: false, applied: [], deleted: [key] });
  }
  for (const [id, of] of s.detailWatches) {
    if (of === `${kind.id}|${key}`) sendDetail(s, id, { state: "deleted" });
  }
}

/** Add (or replace) a row and tell the watches of its kind. */
export function addRow(s: FakeState, kind: ResourceKind, row: ResourceRow) {
  s.cluster.rows[kind.id] = [...rowsOf(s, kind).filter((r) => r.key !== row.key), row];
  for (const w of s.watches) {
    if (w.kind.id === kind.id && (!w.namespace || w.namespace === row.namespace)) {
      sendWatch(s, w.id, { type: "batch", snapshot: false, applied: [row], deleted: [] });
    }
  }
}

/** Start log stream `id`, like the backend (which refuses past its cap). */
export function startStream(s: FakeState, id: number, channel: Channel<LogMessage>) {
  s.logStreams.delete(id);
  if (s.logStreams.size >= MAX_LOG_STREAMS) {
    throw `Too many log streams: ${MAX_LOG_STREAMS} are already open. Close a log tab to open another.`;
  }
  s.logStreams.add(id);
  s.logChannels.set(id, channel);
  s.streamId = id;
  return null;
}

/** Start terminal session `session` on `channel` (#115); returns the id. */
export function startTerm(s: FakeState, session: string, channel: Channel<TermMessage>) {
  s.termChannels.set(session, channel);
  return session;
}

/** Write `data` into terminal session `session`, as raw bytes like the backend. */
export function sendTerm(s: FakeState, session: string, data: string | Uint8Array) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  s.termChannels.get(session)?.onmessage(bytes.slice().buffer);
}

/** Input into terminal session `session`: Ctrl-C clears what waits, which
 *  the backend tells the tab with `cleared`. */
export function interrupted(s: FakeState, session: string, clear: boolean) {
  if (clear) s.termChannels.get(session)?.onmessage({ type: "cleared" });
  return null;
}

export function saveSettings(s: FakeState, next: FakeCluster["settings"]) {
  s.cluster.settings = next;
  sessionStorage.setItem(SETTINGS_KEY, JSON.stringify(s.cluster.settings));
}

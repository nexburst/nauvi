/**
 * What the fake backend's handlers share: the command types, the in-memory
 * cluster and the bookkeeping of the running watches, streams and feeds, and
 * small helpers on them. See the header of `../fake-backend.ts`.
 */

import type { commands } from "../../lib/bindings";
import { events } from "../../lib/bindings";
import type { LinkRequest, ResourceKind, ResourceRef, ResourceRow } from "../../lib/bindings";
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
  /** Running overview feeds, and the id of the latest one. */
  overviewFeeds: Set<number>;
  lastOverview: number | null;
  /** Workloads overview feeds by id, with their namespaces. */
  workloadsFeeds: Map<number, string[]>;
  lastWorkloads: number | null;
  /** Releases a `cmd_update_install` waiting half way through its download. */
  finishDownload: (() => void) | null;
  restarted: boolean;
  /** The nauvi:// link request waiting for the window (#299). */
  link: LinkRequest | null;
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
    overviewFeeds: new Set(),
    lastOverview: null,
    workloadsFeeds: new Map(),
    lastWorkloads: null,
    finishDownload: null,
    restarted: false,
    link: null,
  };
}

const sameResource = (a: ResourceRef, b: ResourceRef) =>
  a.group === b.group && a.version === b.version && a.kind === b.kind && a.plural === b.plural;
/** A JSON copy, like an event payload over real IPC. */
export const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
export const rowKey = (namespace: string, name: string) => (namespace ? `${namespace}/${name}` : name);

export function kindOf(s: FakeState, resource: ResourceRef): ResourceKind {
  const kind = s.cluster.kinds.find((k) => sameResource(k.resource, resource));
  if (!kind) throw `the server could not find the requested resource (${resource.plural})`;
  return kind;
}

export function rowsOf(s: FakeState, kind: ResourceKind): ResourceRow[] {
  return (s.cluster.rows[kind.id] ??= []);
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
    if (w.kind.id === kind.id) void events.watchBatch.emit({ id: w.id, snapshot: false, applied: [], deleted: [key] });
  }
  for (const [id, of] of s.detailWatches) {
    if (of === `${kind.id}|${key}`) void events.detailWatch.emit({ id, state: "deleted" });
  }
}

/** Add (or replace) a row and tell the watches of its kind. */
export function addRow(s: FakeState, kind: ResourceKind, row: ResourceRow) {
  s.cluster.rows[kind.id] = [...rowsOf(s, kind).filter((r) => r.key !== row.key), row];
  for (const w of s.watches) {
    if (w.kind.id === kind.id && (!w.namespace || w.namespace === row.namespace)) {
      void events.watchBatch.emit({ id: w.id, snapshot: false, applied: [row], deleted: [] });
    }
  }
}

/** Start log stream `id`, like the backend (which refuses past its cap). */
export function startStream(s: FakeState, id: number) {
  s.logStreams.delete(id);
  if (s.logStreams.size >= MAX_LOG_STREAMS) {
    throw `Too many log streams: ${MAX_LOG_STREAMS} are already open. Close a log tab to open another.`;
  }
  s.logStreams.add(id);
  s.streamId = id;
  return null;
}

export function saveSettings(s: FakeState, next: FakeCluster["settings"]) {
  s.cluster.settings = next;
  sessionStorage.setItem(SETTINGS_KEY, JSON.stringify(s.cluster.settings));
}

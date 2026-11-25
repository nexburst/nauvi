import { Channel } from "@tauri-apps/api/core";
import { api, visibleCluster } from "../cluster";
import type { DetailState, ResourceDetail } from "../bindings";
import type { Target } from "./detail.svelte";
import { isNotFound } from "../clusterError";

/**
 * The detail of one object, kept up to date: a first `cmd_get_resource_detail`
 * (fast, and the place where "not found" or "forbidden" shows up), then a
 * `cmd_detail_watch` whose messages, on its own channel (#115), replace it. Both panels
 * create one on mount and `stop()` it on destroy.
 */
export class LiveDetail {
  info = $state.raw<ResourceDetail | null>(null);
  loadError = $state("");
  /** The object is gone; `info` is its last known state. */
  deleted = $state(false);
  /** The watch is failing and retrying; `info` may be stale. */
  watchError = $state("");
  /** The first load finished, successfully or not. */
  loaded = $state(false);

  #watchId: string | null = null;
  #stopped = false;
  /** A watch event arrived: it is newer than the first get. */
  #fromWatch = false;
  /** Watch messages that came before the first get finished. */
  #buffer: DetailState[] = [];

  #target: Target;

  constructor(target: Target) {
    this.#target = target;
  }

  async start() {
    const t = this.#target;
    if (this.#stopped) return;
    const channel = new Channel<DetailState>((m) => this.#onEvent(m));
    const [detail, watch] = await Promise.allSettled([
      api(visibleCluster()).cmdGetResourceDetail(t.resource, t.namespace, t.name),
      api(visibleCluster()).cmdDetailWatch(t.resource, t.namespace, t.name, channel),
    ]);
    if (watch.status === "fulfilled") {
      if (this.#stopped) {
        api(visibleCluster()).cmdWatchStop(watch.value).catch(() => {});
      } else {
        this.#watchId = watch.value;
      }
    } else {
      this.watchError = `Live updates could not start: ${String(watch.reason)}`;
    }
    if (this.#stopped) return;
    if (detail.status === "fulfilled") {
      if (!this.#fromWatch) this.info = detail.value;
    } else if (!this.#fromWatch) {
      this.loadError = String(detail.reason);
      // Gone before the panel opened: back/forward to an object deleted since (#223).
      if (isNotFound(this.loadError, t.name)) this.deleted = true;
    }
    this.loaded = true;
    const buffered = this.#buffer.splice(0);
    if (this.#watchId !== null) buffered.forEach((ev) => this.#onEvent(ev));
  }

  #onEvent(ev: DetailState) {
    if (this.#stopped) return;
    if (!this.loaded || this.#watchId === null) {
      // Newer than the first get: replayed once it (and the watch) resolved.
      if (!this.loaded) this.#buffer.push(ev);
      return;
    }
    this.#fromWatch = true;
    if (ev.state === "detail") {
      this.info = ev.detail;
      this.deleted = false;
      this.watchError = "";
      this.loadError = "";
    } else if (ev.state === "deleted") {
      this.deleted = true;
      this.watchError = "";
    } else {
      this.watchError = ev.error;
    }
  }

  stop() {
    this.#stopped = true;
    this.#buffer = [];
    if (this.#watchId) api(visibleCluster()).cmdWatchStop(this.#watchId).catch(() => {});
    this.#watchId = null;
  }
}

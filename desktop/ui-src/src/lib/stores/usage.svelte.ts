import { commands } from "../bindings";
import type { MetricsKind, UsageHistoryView, UsageRange } from "../bindings";

/** Same pace as the table's metrics poll (stores/live.svelte.ts). */
export const USAGE_INTERVAL_MS = 20_000;

/** What a feed charts: a pod or node, or all the pods of a workload. */
export type UsageTarget =
  | { what: MetricsKind; namespace: string | null; name: string }
  | { workload: string; namespace: string; name: string };

/** The history of `t` over `range`. */
function fetchUsage(t: UsageTarget, range: UsageRange): Promise<UsageHistoryView> {
  return "workload" in t
    ? commands.cmdWorkloadUsageHistory(t.workload, t.namespace, t.name, range)
    : commands.cmdUsageHistory(t.what, t.namespace, t.name, range);
}

/**
 * The usage history of one pod or node (`cmd_usage_history`), or the summed
 * history of a workload's pods (`cmd_workload_usage_history`), for the
 * charts in its detail panel. Polled while the panel is open; the backend samples
 * the object itself when no table did lately, so history keeps growing.
 * The panel calls `stop()` in `onDestroy`.
 *
 * `range` is what the user picked: a Prometheus range (the default, 1h)
 * or `live`. Without a Prometheus the backend answers with the live
 * history and a note saying why.
 */
export class UsageFeed {
  data = $state.raw<UsageHistoryView | null>(null);
  error = $state("");
  range = $state<UsageRange>("1h");

  #target: UsageTarget;
  #timer: ReturnType<typeof setInterval> | null = null;
  #stopped = false;

  constructor(target: UsageTarget) {
    this.#target = target;
  }

  start() {
    void this.load();
    this.#timer = setInterval(() => void this.load(), USAGE_INTERVAL_MS);
  }

  async load() {
    try {
      const range = this.range;
      const data = await fetchUsage(this.#target, range);
      // A reply to an older range is dropped; the newer request follows.
      if (this.#stopped || range !== this.range) return;
      this.data = data;
      this.error = "";
    } catch (e) {
      if (!this.#stopped) this.error = String(e);
    }
  }

  setRange(range: UsageRange) {
    if (range === this.range) return;
    this.range = range;
    void this.load();
  }

  stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

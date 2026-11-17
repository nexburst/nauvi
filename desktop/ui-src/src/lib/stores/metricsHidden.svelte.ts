// "Hide metrics" (#327): a per-cluster setting that hides CPU and memory
// usage (table columns, sparklines, usage charts, the overview's usage) and
// stops polling the metrics API for that cluster.

import { currentContextName } from "./app.svelte";
import { contextSettings, updateContext } from "./settings.svelte";

/** Whether metrics are hidden for `context` (default: this window's). */
export function metricsHidden(context: string = currentContextName()): boolean {
  return contextSettings(context).hide_metrics;
}

export function setMetricsHidden(context: string, hidden: boolean): Promise<void> {
  return updateContext(context, { hide_metrics: hidden });
}

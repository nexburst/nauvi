// Prometheus detection (`commands/prometheus.rs`).

import type { PrometheusStatus } from "../../lib/bindings";
import type { AreaHandlers, FakeState } from "./state";

/** Like `cmd_prometheus_status`: the current context's setting, else what was detected. */
export function prometheusStatus(s: FakeState): PrometheusStatus {
  const { cluster } = s;
  const ctx = cluster.contexts.find((c) => c.current)?.name ?? "";
  const setting = (cluster.settings.contexts[ctx]?.prometheus ?? "").trim();
  if (setting.toLowerCase() === "off") {
    return { target: "", from_settings: false, note: "Prometheus is turned off for this context in Settings." };
  }
  if (setting) {
    const target = setting.includes(":") ? setting : `${setting}:9090`;
    return { target, from_settings: true, note: "" };
  }
  const p = cluster.prometheus;
  return { target: p.detected, from_settings: false, note: p.detected ? "" : p.note };
}

export function prometheusHandlers(s: FakeState) {
  return {
    cmdPrometheusStatus: () => prometheusStatus(s),
  } satisfies AreaHandlers;
}

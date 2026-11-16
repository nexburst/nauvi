// One-click metrics: the add-ons, RBAC and their install (`commands/metrics_addons.rs`).

import { ADDONS, installAddon } from "../fixtures/metricsAddons";
import { prometheusFixture } from "../fixtures/usage";
import { copy } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function metricsAddonsHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    cmdMetricsAddons: () => copy(ADDONS),
    cmdMetricsAddonAccess: (addon, namespace) => {
      const reason = cluster.metricsAddons.denied[addon] ?? "";
      if (!namespace.trim()) throw "Choose a namespace first";
      return { id: addon, allowed: !reason, reason };
    },
    cmdMetricsAddonInstall: (request) => {
      const result = installAddon(cluster.metricsAddons, request);
      // The new Prometheus is detected at once.
      if (!request.dry_run && request.addon === "prometheus") {
        cluster.prometheus = { ...prometheusFixture(), detected: `${request.namespace}/${request.name}-server:http` };
      }
      return result;
    },
  } satisfies AreaHandlers;
}

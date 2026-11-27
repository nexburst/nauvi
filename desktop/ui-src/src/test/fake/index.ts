/**
 * The fake backend's command handlers, one file per command module of the
 * backend (`desktop/src/commands/<module>.rs` -> `<module>.ts`, with `-` for
 * `_`). This list is sorted, one area per line, with a trailing comma: add a
 * new area at its sorted place.
 */

import { actionsHandlers } from "./actions";
import { applicationsHandlers } from "./applications";
import { askAiHandlers } from "./ask-ai";
import { autostartHandlers } from "./autostart";
import { catalogHandlers } from "./catalog";
import { clusterHandlers } from "./cluster";
import { clustersHandlers } from "./clusters";
import { debugHandlers } from "./debug";
import { execHandlers } from "./exec";
import { filesHandlers } from "./files";
import { helpHandlers } from "./help";
import { helmHandlers } from "./helm";
import { helmChartsHandlers } from "./helm-charts";
import { imageScanHandlers } from "./image-scan";
import { imageSecurityHandlers } from "./image-security";
import { imageTriageHandlers } from "./image-triage";
import { kubectlHandlers } from "./kubectl";
import { linksHandlers } from "./links";
import { localShellHandlers } from "./local-shell";
import { logsHandlers } from "./logs";
import { metricsAddonsHandlers } from "./metrics-addons";
import { overviewHandlers } from "./overview";
import { podEnvHandlers } from "./pod-env";
import { portforwardHandlers } from "./portforward";
import { prometheusHandlers } from "./prometheus";
import { proxyHandlers } from "./proxy";
import { registryTagsHandlers } from "./registry-tags";
import { resourcesHandlers } from "./resources";
import { settingsHandlers } from "./settings";
import type { FakeState, Handlers } from "./state";
import { updaterHandlers } from "./updater";
import { usageHandlers } from "./usage";
import { watchHandlers } from "./watch";
import { windowHandlers } from "./window";
import { workloadsHandlers } from "./workloads";

/** Every command's handler. The `Handlers` type makes `npm run check` fail
 *  while a command in `bindings.ts` has none. */
export function allHandlers(s: FakeState): Handlers {
  return {
    ...actionsHandlers(s),
    ...applicationsHandlers(s),
    ...askAiHandlers(s),
    ...autostartHandlers(s),
    ...catalogHandlers(s),
    ...clusterHandlers(s),
    ...clustersHandlers(s),
    ...debugHandlers(s),
    ...execHandlers(s),
    ...filesHandlers(s),
    ...helpHandlers(s),
    ...helmHandlers(s),
    ...helmChartsHandlers(s),
    ...imageScanHandlers(s),
    ...imageSecurityHandlers(s),
    ...imageTriageHandlers(s),
    ...kubectlHandlers(s),
    ...linksHandlers(s),
    ...localShellHandlers(s),
    ...logsHandlers(s),
    ...metricsAddonsHandlers(s),
    ...overviewHandlers(s),
    ...podEnvHandlers(s),
    ...portforwardHandlers(s),
    ...prometheusHandlers(s),
    ...proxyHandlers(s),
    ...registryTagsHandlers(s),
    ...resourcesHandlers(s),
    ...settingsHandlers(s),
    ...updaterHandlers(s),
    ...usageHandlers(s),
    ...watchHandlers(s),
    ...windowHandlers(s),
    ...workloadsHandlers(s),
  };
}

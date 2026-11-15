// In-app updates (`commands/updater.rs`).

import { events } from "../../lib/bindings";
import { copy } from "./state";
import type { AreaHandlers, FakeState } from "./state";

export function updaterHandlers(s: FakeState) {
  const { cluster } = s;
  return {
    cmdUpdateCheck: (startup) => {
      const u = cluster.update.check;
      if (startup && !cluster.settings.check_updates) {
        return {
          ...copy(u),
          status: "skipped",
          version: "",
          can_install: false,
          note: "The update check on start is turned off in Settings.",
        };
      }
      return copy(u);
    },
    cmdUpdateInstall: async () => {
      const { check, size } = cluster.update;
      if (check.status !== "available") throw "There is no update to install. Check for updates first.";
      if (!check.can_install) {
        throw `This copy of kubeloupe cannot install updates itself. Download ${check.version} from ${check.release_url}.`;
      }
      await events.updateProgress.emit({ phase: "downloading", downloaded: 0, total: size });
      await events.updateProgress.emit({ phase: "downloading", downloaded: Math.round(size * 0.45), total: size });
      await new Promise<void>((resolve) => (s.finishDownload = resolve));
      await events.updateProgress.emit({ phase: "installing", downloaded: size, total: size });
      s.restarted = true;
      return null;
    },
  } satisfies AreaHandlers;
}

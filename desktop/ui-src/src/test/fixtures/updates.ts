// In-app updates (#30) of the fake backend: what `cmd_update_check` finds
// and how big the download of `cmd_update_install` is. The fake behaves like
// a release build (the real debug build skips the check).

import type { UpdateCheck } from "../../lib/bindings";

export interface FakeUpdate {
  /** What a check returns (the start-up check is skipped when Settings turn it off). */
  check: UpdateCheck;
  /** The download's size in bytes. */
  size: number;
}

export const CURRENT_VERSION = "0.1.0";

/** The default: the running version is the latest. */
export function upToDate(): FakeUpdate {
  return {
    check: {
      status: "up_to_date",
      current_version: CURRENT_VERSION,
      version: "",
      notes: "",
      release_url: "https://github.com/nexburst/nauvi/releases",
      can_install: false,
      note: "",
    },
    size: 0,
  };
}

/** A newer release; `note` says why it cannot be installed in place. */
export function available(version: string, canInstall = true, note = ""): FakeUpdate {
  return {
    check: {
      status: "available",
      current_version: CURRENT_VERSION,
      version,
      notes: `See https://github.com/nexburst/nauvi/releases/tag/v${version}`,
      release_url: `https://github.com/nexburst/nauvi/releases/tag/v${version}`,
      can_install: canInstall,
      note,
    },
    size: 13_500_000,
  };
}

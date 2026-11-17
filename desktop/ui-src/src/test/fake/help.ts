// The Help menu, About and the app log (`commands/help.rs`).

import type { Diagnostics } from "../../lib/bindings";
import type { AreaHandlers, FakeState } from "./state";

export const FAKE_DIAGNOSTICS: Diagnostics = {
  version: "0.1.0",
  commit: "0123456789ab",
  os: "Ubuntu 24.04.1 LTS, Linux 6.8.0",
  arch: "x86_64",
  webview: "WebKitGTK 2.48.0",
  debug_build: false,
  text: "nauvi 0.1.0\nCommit: 0123456789ab\nOS: Ubuntu 24.04.1 LTS, Linux 6.8.0 (x86_64)\nWebview: WebKitGTK 2.48.0",
};

export function helpHandlers(_s: FakeState) {
  return {
    cmdDiagnostics: () => ({ ...FAKE_DIAGNOSTICS }),
    // The backend opens the URL or folder; tests read `calls("cmdHelpOpen")`.
    cmdHelpOpen: () => null,
    cmdLogUiError: () => undefined,
  } satisfies AreaHandlers;
}

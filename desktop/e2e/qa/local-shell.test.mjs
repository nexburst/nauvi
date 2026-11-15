// Helper: launching with a given environment (`launch(name, { env })`, plus
// the profile's HOME).
// Checks (#43): a local terminal runs $SHELL with the app's HOME, and kubectl
// in it uses the app's context and namespace through a temp kubeconfig.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { CONTEXT } from "../lib/app.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";

const T = { timeout: 120_000 };
const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

describe("local shell with a chosen SHELL and HOME", { timeout: 10 * 60_000 }, () => {
  const s = appSession("local-shell", { env: { SHELL } });

  it("opens $SHELL in the app's HOME", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.palette("local term", "New local terminal");
    const term = terminal(app);
    await term.waitFor(`kubectl uses context ${CONTEXT}`);
    await term.waitForPrompt();
    assert.equal(await term.run("echo $HOME"), app.profile.home);
    assert.equal(await term.run("ps -o comm= -p $$"), SHELL.split("/").pop());
  });

  it("points kubectl at the app's context", T, async () => {
    const term = terminal(s.app);
    assert.equal(await term.run("kubectl config current-context"), CONTEXT);
    assert.match(await term.run("kubectl get ns demo -o name"), /^namespace\/demo$/);
  });
});

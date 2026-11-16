// Helpers: typing into xterm and reading its screen (lib/terminal.mjs),
// resizing the window (lib/window.mjs).
// Checks (#19, #67): the pod terminal runs commands, the PTY follows a
// window resize, and `exit` shows "[session closed]".

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 120_000 };
let ns;

describe("pod terminal", { timeout: 10 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-term", httpPodYaml("shell"));
    waitPodReady(ns, "shell");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("terminal");

  it("types a command and reads its output", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.openDetail("Pods", ns, "shell");
    await (await app.find(By.xpath("//*[@data-testid='detail-panel']//button[normalize-space()='Shell']"))).click();
    const term = terminal(app);
    await term.waitForPrompt();
    assert.equal(await term.run("echo qa-$((6*7))"), "qa-42");
  });

  it("follows a window resize", T, async () => {
    const { app } = s;
    const term = terminal(app);
    const [rows, cols] = await term.size();
    await resizeWindow(app, 900, 700);
    // xterm refits, then the PTY gets the new size.
    const after = await app.waitFor(
      async () => {
        const size = await term.size();
        return size[1] < cols ? size : null;
      },
      { timeout: 20_000, message: `fewer than ${cols} columns after shrinking the window` },
    );
    assert.ok(after[1] < cols, `columns ${cols} -> ${after[1]}`);
    console.log(`stty size: ${rows}x${cols} -> ${after[0]}x${after[1]}`);
    await resizeWindow(app, 1400, 900);
  });

  it("shows [session closed] after exit", T, async () => {
    const term = terminal(s.app);
    await term.type("exit");
    await term.waitFor("[session closed]");
  });
});

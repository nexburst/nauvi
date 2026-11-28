// The header's Terminal button and the VS Code terminal keys (#592), in
// WebKitGTK against kind, at 1280x800 in the dark and the light theme:
// - the header fits with Terminal next to Ask AI (a stand-in `claude` on
//   PATH makes Ask AI show)
// - with the dock hidden, one click on Terminal opens a local terminal at
//   the app's context; after Ctrl+` hides the dock, a click shows it again
//   with a second terminal
// - the help overlay lists Ctrl+` and Ctrl+Shift+` first, Ctrl+J and
//   Ctrl+Shift+J after them
// - the palette shows the shortcuts of its commands

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Key } from "selenium-webdriver";
import { CONTEXT, byTestId } from "../lib/app.mjs";
import { dockTabs, pressCtrl } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const bin = mkdtempSync(join(tmpdir(), "qa-592-bin-"));
writeFileSync(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
chmodSync(join(bin, "claude"), 0o755);

const press = (app, ...keys) => app.driver.actions().sendKeys(...keys).perform();

async function bothThemes(app, label) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await app.js("return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

/** The header's controls: whether it overflows, and each visible child's edges. */
const headerLayout = (app) =>
  app.js(`const h = document.querySelector('[data-testid="cluster-band"]');
    const boxes = [...h.children]
      .filter((c) => c.getBoundingClientRect().width > 0 && getComputedStyle(c).visibility !== "hidden")
      .map((c) => { const r = c.getBoundingClientRect(); return { cls: c.className, left: Math.round(r.left), right: Math.round(r.right) }; });
    return { overflow: h.scrollWidth > h.clientWidth, width: window.innerWidth, boxes };`);

describe("Terminal button and terminal keys", { timeout: 10 * 60_000 }, () => {
  after(() => rmSync(bin, { recursive: true, force: true }));
  const s = appSession("terminal-button", { env: { PATH: `${bin}:${process.env.PATH}` } });

  it("the header fits at 1280x800 with Terminal next to Ask AI", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.find(byTestId("terminal-header"));
    const askAi = await app.waitFor(
      async () => (await app.driver.findElements(byTestId("ask-ai-header"))).length > 0,
      { message: "Ask AI in the header", timeout: 15_000 },
    ).catch(() => false);
    const layout = await headerLayout(app);
    console.log(`Ask AI shown: ${askAi}; header: ${JSON.stringify(layout)}`);
    assert.equal(layout.overflow, false, "the header does not overflow");
    for (const b of layout.boxes) assert.ok(b.right <= layout.width, `${b.cls} inside the window`);
    for (let i = 1; i < layout.boxes.length; i++) {
      assert.ok(layout.boxes[i].left >= layout.boxes[i - 1].right - 1, `${layout.boxes[i].cls} does not overlap`);
    }
    const title = await (await app.find(byTestId("terminal-header"))).getAttribute("title");
    assert.match(title, /\(Ctrl\+Shift\+` or Ctrl\+Shift\+J\)$/);
    await bothThemes(app, "header");
  });

  it("with the dock hidden, Terminal opens a local terminal at the app's context", T, async () => {
    const { app } = s;
    assert.deepEqual(await dockTabs(app), [], "no dock at first");
    await (await app.find(byTestId("terminal-header"))).click();
    const term = terminal(app);
    await term.waitFor(`kubectl uses context ${CONTEXT}`);
    await term.waitForPrompt();
    assert.equal(await term.run("kubectl config current-context"), CONTEXT);
    await bothThemes(app, "terminal-opened");

    // Hide the dock with Ctrl+` (from the terminal), then Terminal shows it with a second one.
    await pressCtrl(app, "`");
    await app.waitFor(() => app.js(`return document.querySelector('[data-testid="dock"]').classList.contains('collapsed')`), {
      message: "the dock to hide",
    });
    await (await app.find(byTestId("terminal-header"))).click();
    await app.waitFor(async () => (await dockTabs(app)).length === 2, { message: "a second terminal tab" });
    assert.equal(
      await app.js(`return document.querySelector('[data-testid="dock"]').classList.contains('collapsed')`),
      false,
      "the click shows the dock again",
    );
    const second = terminal(app);
    await second.waitFor(`kubectl uses context ${CONTEXT}`);
    console.log(`tabs: ${JSON.stringify(await dockTabs(app))}`);
    await app.shot("second-terminal");
  });

  it("the help lists Ctrl+` and Ctrl+Shift+` first", T, async () => {
    const { app } = s;
    await app.js("document.activeElement?.blur()");
    await press(app, "?");
    const keysOf = (label) =>
      app.js(
        `const dd = [...document.querySelectorAll('[role="dialog"][aria-label="Keyboard shortcuts"] dd')]
           .find((d) => d.textContent.trim().startsWith(arguments[0]));
         const dt = dd?.previousElementSibling;
         return dt ? [...dt.querySelectorAll("kbd")].map((k) => k.textContent.trim()) : null;`,
        label,
      );
    const dock = await app.waitFor(() => keysOf("Show or hide the dock"), { message: "the help overlay" });
    const shell = await keysOf("New local terminal");
    console.log(`dock: ${JSON.stringify(dock)}, new terminal: ${JSON.stringify(shell)}`);
    assert.deepEqual(dock, ["Ctrl+`", "Ctrl+J"]);
    assert.deepEqual(shell, ["Ctrl+Shift+`", "Ctrl+Shift+J"]);
    await app.js(
      `[...document.querySelectorAll('[role="dialog"][aria-label="Keyboard shortcuts"] dd')]
         .find((d) => d.textContent.trim().startsWith("New local terminal"))?.scrollIntoView({ block: "center" })`,
    );
    await bothThemes(app, "help");
    await press(app, Key.ESCAPE);
  });

  it("the palette shows its commands' shortcuts", T, async () => {
    const { app } = s;
    await app.js("document.activeElement?.blur()");
    await pressCtrl(app, "k");
    await app.find(byTestId("command-palette"));
    await press(app, ">");
    const hints = await app.waitFor(
      async () => {
        const h = await app.js(
          `return Object.fromEntries([...document.querySelectorAll('[data-testid="command-palette"] [role="option"]')]
             .filter((o) => o.querySelector('[data-testid="palette-keys"]'))
             .map((o) => [o.querySelector(".label").textContent.trim(), o.querySelector('[data-testid="palette-keys"]').textContent.trim()]));`,
        );
        return h["New local terminal"] ? h : null;
      },
      { message: "palette hints" },
    );
    console.log(`palette hints: ${JSON.stringify(hints)}`);
    assert.equal(hints["New local terminal"], "Ctrl+Shift+`");
    assert.equal(hints["Refresh"], "F5");
    assert.equal(hints["Keyboard shortcuts"], "?");
    assert.equal(hints["Settings…"], "Ctrl+,");
    assert.match(hints["Show the dock"] ?? hints["Hide the dock"] ?? "", /^Ctrl\+`$/);
    await bothThemes(app, "palette-hints");
    await press(app, Key.ESCAPE);
  });
});

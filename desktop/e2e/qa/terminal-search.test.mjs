// Helpers: the terminal (lib/terminal.mjs), the theme (lib/panels.mjs).
// Checks (#222): Ctrl+Shift+F in a pod shell opens a search bar over the
// terminal with a match count, next/previous (Enter / Shift+Enter) and
// match case; Esc closes it and the shell has the focus again. Plain Ctrl+F
// still reaches the shell (a local terminal reads it as byte 06). The
// search addon runs under the app's CSP (#227). Screenshots at 1280x800 in
// the dark and light themes, with matches and with none.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Key } from "selenium-webdriver";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { panelButton } from "../lib/dock.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const BAR = `Array.from(document.querySelectorAll('[data-testid="terminal-search"]')).find((el) => el.offsetParent !== null)`;

async function pressSearch(app) {
  await app.driver.actions().keyDown(Key.CONTROL).keyDown(Key.SHIFT).sendKeys("f").keyUp(Key.SHIFT).keyUp(Key.CONTROL).perform();
}

/** The visible search bar's count, whether its input has the focus, and whether it shows at all. */
function bar(app) {
  return app.js(`const bar = ${BAR};
    if (!bar) return null;
    return {
      count: bar.querySelector('[data-testid="terminal-search-count"]').textContent.trim(),
      focused: document.activeElement === bar.querySelector('input'),
      decorations: bar.closest('[data-testid="terminal"]').querySelectorAll('.xterm-decoration').length,
    };`);
}

function waitCount(app, re, message) {
  return app.waitFor(
    async () => {
      const b = await bar(app);
      return b && re.test(b.count) ? b : null;
    },
    { message },
  );
}

/** Type into the visible search bar's input, like a user. */
async function typeInBar(app, text, ...keys) {
  const input = await app.waitFor(() => app.js(`return ${BAR}?.querySelector('input') ?? null`), {
    message: "the search input",
  });
  await input.sendKeys(text, ...keys);
}

const parse = (count) => count.match(/^(\d+) of (\d+)$/)?.slice(1).map(Number) ?? null;

describe("terminal search", { timeout: 10 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-search", httpPodYaml("shell"));
    waitPodReady(ns, "shell");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("terminal-search");

  it("Ctrl+Shift+F searches a pod shell's output, with a count and next/previous", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "dark");
    await waitLive(app);
    await app.openDetail("Pods", ns, "shell");
    await panelButton(app, "Open terminal");
    const term = terminal(app);
    await term.waitForPrompt();
    await term.type("clear");
    await term.type("for i in 1 2 3 4 5; do echo needle-$i; done; echo NEEDLE-UPPER");
    await term.waitFor(/^NEEDLE-UPPER$/m);
    assert.equal(await bar(app), null, "no search bar before the shortcut");

    await pressSearch(app);
    const opened = await app.waitFor(() => bar(app), { message: "the search bar" });
    assert.ok(opened.focused, "the search input has the focus");
    await typeInBar(app, "needle");
    const first = await waitCount(app, /^\d+ of \d+$/, "a match count");
    const [i1, total] = parse(first.count);
    // 5 lines, NEEDLE-UPPER, and the command line itself (twice).
    assert.ok(total >= 6, `at least 6 matches, got ${first.count}`);
    assert.ok(first.decorations > 0, "the matches are highlighted");
    await app.shot("dark-matches");

    await typeInBar(app, Key.ENTER);
    const next = await waitCount(app, new RegExp(`^(?!${i1} of)\\d+ of ${total}$`), "Enter to move to another match");
    await typeInBar(app, Key.chord(Key.SHIFT, Key.ENTER));
    await waitCount(app, new RegExp(`^${i1} of ${total}$`), `Shift+Enter back from ${next.count}`);

    // Match case: NEEDLE-UPPER no longer counts.
    await app.js(`${BAR}.querySelector('button[title="Match case"]').click()`);
    const cased = await waitCount(app, /^\d+ of \d+$/, "a count with match case");
    assert.ok(parse(cased.count)[1] < total, `fewer matches with match case: ${cased.count} vs ${total}`);

    await setTheme(app, "light");
    await app.shot("light-matches");
  });

  it("says when nothing matches", T, async () => {
    const { app } = s;
    await typeInBar(app, Key.chord(Key.CONTROL, "a"), "zz-not-in-output");
    await waitCount(app, /^No matches$/, "No matches");
    const disabled = await app.js(`return ${BAR}.querySelector('button[aria-label="Next match"]').disabled`);
    assert.equal(disabled, true, "Next is disabled without matches");
    await app.shot("light-no-matches");
    await setTheme(app, "dark");
    await app.shot("dark-no-matches");
  });

  it("Esc closes it and the shell has the keyboard again", T, async () => {
    const { app } = s;
    await typeInBar(app, Key.ESCAPE);
    await app.waitFor(async () => (await bar(app)) === null, { message: "the search bar to close" });
    const term = terminal(app);
    assert.equal(await term.run("hostname"), "shell");
    await app.shot("dark-closed");
  });

  it("plain Ctrl+F still reaches a local shell", T, async () => {
    const { app } = s;
    await app.palette("local term", "New local terminal");
    const term = terminal(app);
    await term.waitForPrompt();
    await term.type(`IFS= read -r x; printf 'got:%s\\n' "$(printf %s "$x" | od -An -tx1 | tr -d ' ')"`);
    await app.driver.actions().keyDown(Key.CONTROL).sendKeys("f").keyUp(Key.CONTROL).perform();
    await term.type("", { enter: true });
    await term.waitFor(/^got:06$/m, { message: "the shell to read Ctrl+F as 06" });
    assert.equal(await bar(app), null, "Ctrl+F did not open the search");

    // And Ctrl+Shift+F searches this terminal too.
    await pressSearch(app);
    await app.waitFor(() => bar(app), { message: "the search bar in the local terminal" });
    await typeInBar(app, "got:06");
    await waitCount(app, /^\d+ of \d+$/, "a match in the local terminal");
    await app.shot("dark-local-shell");
  });
});

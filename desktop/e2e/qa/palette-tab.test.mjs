// Tab in the command palette (#591), in WebKitGTK against kind, at 1280x800
// in the dark and the light theme:
// - `:na` + Tab completes to `:namespaces` with the Namespaces kind
//   highlighted, the focus still in the palette's input; Enter opens it
// - after Tab, ↓/↑ and Esc still work
// - on actions (`>`), Tab and Shift+Tab move through the results and the
//   focus never leaves the input

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };

const press = (app, ...keys) => app.driver.actions().sendKeys(...keys).perform();
const ctrl = (app, key) => app.driver.actions().keyDown(Key.CONTROL).sendKeys(key).keyUp(Key.CONTROL).perform();
const shiftTab = (app) => app.driver.actions().keyDown(Key.SHIFT).sendKeys(Key.TAB).keyUp(Key.SHIFT).perform();
const paletteOpen = async (app) => (await app.driver.findElements(byTestId("command-palette"))).length > 0;
/** The palette's query, whether its input has the focus, and the highlighted result. */
const state = (app) =>
  app.js(`const p = document.querySelector('[data-testid="command-palette"]');
    const input = p?.querySelector('input[role="combobox"]');
    return {
      query: input?.value ?? null,
      focused: !!input && document.activeElement === input,
      active: p?.querySelector('[role="option"][aria-selected="true"] .label')?.textContent ?? "",
      options: p?.querySelectorAll('[role="option"]').length ?? 0,
    };`);

async function bothThemes(app, label) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await app.js("return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

async function openPalette(app, query) {
  await app.js("document.activeElement?.blur()");
  await ctrl(app, "k");
  await app.find(byTestId("command-palette"));
  await press(app, query);
  await app.waitFor(async () => (await state(app)).options > 0, { message: `results for "${query}"` });
}

describe("command palette Tab", { timeout: 10 * 60_000 }, () => {
  const s = appSession("palette-tab");

  it(":na Tab completes to :namespaces and keeps the focus; Enter opens Namespaces", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await openPalette(app, ":na");
    await press(app, Key.TAB);
    const after = await app.waitFor(
      async () => {
        const st = await state(app);
        return st.query === ":namespaces" ? st : null;
      },
      { message: "the query completed to :namespaces" },
    );
    console.log(`after Tab: ${JSON.stringify(after)}`);
    assert.equal(after.focused, true, "the input keeps the focus");
    assert.equal(after.active, "Namespaces", "the Namespaces kind is highlighted");
    await bothThemes(app, "completed");
    await press(app, Key.ENTER);
    await app.waitFor(async () => !(await paletteOpen(app)), { message: "the palette to close" });
    await app.waitFor(
      async () => (await app.js(`return document.querySelector('[role="grid"]')?.getAttribute("aria-label") ?? ""`)) === "Namespaces",
      { message: "the Namespaces table" },
    );
    await app.shot("namespaces-opened");
  });

  it("after Tab the arrows and Esc still work", T, async () => {
    const { app } = s;
    await openPalette(app, ":po");
    await press(app, Key.TAB);
    await app.waitFor(async () => (await state(app)).query === ":pods", { message: "the query completed to :pods" });
    const first = (await state(app)).active;
    await press(app, Key.ARROW_DOWN);
    const down = await state(app);
    console.log(`first: ${first}, after ↓: ${down.active} (${down.options} results)`);
    if (down.options > 1) assert.notEqual(down.active, first, "↓ moves");
    await press(app, Key.ARROW_UP);
    assert.equal((await state(app)).active, first, "↑ moves back");
    await press(app, Key.ESCAPE);
    await app.waitFor(async () => !(await paletteOpen(app)), { message: "Esc to close the palette" });
  });

  it("on actions Tab and Shift+Tab move through the results; the focus never leaves the palette", T, async () => {
    const { app } = s;
    await openPalette(app, ">");
    const first = (await state(app)).active;
    for (let i = 0; i < 3; i++) await press(app, Key.TAB);
    const moved = await state(app);
    console.log(`after 3 Tabs: ${JSON.stringify(moved)}`);
    assert.equal(moved.query, ">", "Tab does not change an action query");
    assert.equal(moved.focused, true, "the input keeps the focus");
    assert.notEqual(moved.active, first, "Tab moved the highlight");
    await bothThemes(app, "tab-moved");
    for (let i = 0; i < 3; i++) await shiftTab(app);
    const back = await state(app);
    assert.equal(back.focused, true, "Shift+Tab keeps the focus in the input");
    assert.equal(back.active, first, "Shift+Tab moves back");
    // Many Tabs: still inside.
    for (let i = 0; i < 30; i++) await press(app, Key.TAB);
    assert.equal((await state(app)).focused, true, "30 Tabs later the input still has the focus");
    await press(app, Key.ESCAPE);
    await app.waitFor(async () => !(await paletteOpen(app)), { message: "Esc to close the palette" });
    await app.shot("closed");
  });
});

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// #181: the rows the shell is told about all fit in the dock: the last one
// (vim's status line, htop's key bar) is not cut by the dock's bottom edge.

/** How the terminal's screen sits in its box, in CSS pixels. */
async function geometry(page: Page) {
  return page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('[data-testid="terminal"]')!;
    const screen = box.querySelector<HTMLElement>(".xterm-screen")!;
    const b = box.getBoundingClientRect();
    const sc = screen.getBoundingClientRect();
    const st = getComputedStyle(box);
    return {
      contentBottom: b.bottom - parseFloat(st.paddingBottom) - parseFloat(st.borderBottomWidth),
      contentRight: b.right - parseFloat(st.paddingRight) - parseFloat(st.borderRightWidth),
      screenBottom: sc.bottom,
      screenRight: sc.right,
      screenHeight: sc.height,
    };
  });
}

for (const size of [
  { width: 1280, height: 800 },
  { width: 1280, height: 797 },
  { width: 1000, height: 640 },
]) {
  test(`every terminal row fits the dock at its default height (${size.width}x${size.height})`, async ({ page }) => {
    await page.setViewportSize(size);
    const fake = await openApp(page);
    await openKind(page, "Pods");
    await row(page, "web-1").click({ button: "right" });
    await page.getByRole("menu").getByRole("menuitem", { name: "Shell" }).click();
    await expect(page.getByTestId("terminal").locator(".xterm-screen")).toBeVisible();
    await expect.poll(async () => (await fake.calls("cmdExecStart")).length).toBe(1);
    const { rows } = (await fake.lastCall("cmdExecStart")) as { rows: number };
    const resized = (await fake.calls("cmdExecResize")) as { rows: number }[];
    const told = resized.length ? resized[resized.length - 1].rows : rows;

    const g = await geometry(page);
    const cell = g.screenHeight / told;
    expect(cell, "a row is 10 to 30 px high").toBeGreaterThan(10);
    expect(cell).toBeLessThan(30);
    // The last row ends inside the box's content area, not under its padding or edge.
    expect(g.screenBottom).toBeLessThanOrEqual(g.contentBottom + 0.5);
    expect(g.screenRight).toBeLessThanOrEqual(g.contentRight + 0.5);
    // And no whole row is wasted.
    expect(g.contentBottom - g.screenBottom).toBeLessThan(cell);
  });
}

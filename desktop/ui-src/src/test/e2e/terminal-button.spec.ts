// The header's Terminal button, the VS Code keys first on every platform,
// and shortcut hints in the palette (#592).
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./helpers";

const dock = (page: Page) => page.getByTestId("dock");
const terminalButton = (page: Page) => page.getByTestId("terminal-header");
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const help = (page: Page) => page.getByRole("dialog", { name: "Keyboard shortcuts" });
const option = (page: Page, label: string) =>
  palette(page)
    .getByRole("option")
    .filter({ has: page.locator(".label", { hasText: label }) });

/** As on macOS: `isMacPlatform` reads `navigator.platform`. */
const asMac = (page: Page) =>
  page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));

test("with the dock hidden, one click on Terminal opens a local terminal at the app's context", async ({ page }) => {
  const fake = await openApp(page);
  await expect(dock(page)).toHaveCount(0);
  await expect(terminalButton(page)).toHaveText("Terminal");
  await expect(terminalButton(page)).toHaveAttribute("title", /\(Ctrl\+Shift\+` or Ctrl\+Shift\+J or Ctrl\+T\)$/);
  await terminalButton(page).click();
  await expect(dock(page).getByRole("tab")).toHaveText(["kind-dev · default"]);
  await expect.poll(() => fake.calls("cmdLocalShellStart")).toHaveLength(1);
  expect(await fake.lastCall("cmdLocalShellStart")).toMatchObject({ namespace: "default" });

  // Hidden again, a click shows the dock with a second terminal.
  await page.keyboard.press("Control+`");
  await expect(dock(page).getByRole("tab")).toHaveCount(1);
  await terminalButton(page).click();
  await expect(dock(page).getByRole("tab")).toHaveCount(2);
  await expect(page.locator(".xterm-helper-textarea").last()).toBeFocused();
  expect(fake.errors).toEqual([]);
});

test("on macOS the help, the + and Terminal tooltips and the palette show ⌃` and ⌃⇧` first", async ({ page }) => {
  await asMac(page);
  await openApp(page);
  await expect(terminalButton(page)).toHaveAttribute("title", /\(⌃⇧` or ⇧⌘J or ⌘T\)$/);
  await terminalButton(page).click();
  await expect(dock(page).getByRole("button", { name: "New local terminal" })).toHaveAttribute(
    "title",
    "New local terminal (⌃⇧` or ⇧⌘J or ⌘T)",
  );

  // The new terminal takes the focus: once it has, leave it for the app's keys.
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("?");
  const keysOf = (label: RegExp) =>
    help(page).locator("dd", { hasText: label }).locator("xpath=preceding-sibling::dt[1]").locator("kbd");
  await expect(keysOf(/^Show or hide the dock/)).toHaveText(["⌃`", "⌘J"]);
  await expect(keysOf(/^New local terminal/)).toHaveText(["⌃⇧`", "⇧⌘J", "⌘T"]);
});

test("palette entries with a shortcut show it", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("Control+k");
  await page.keyboard.type(">");
  await expect(option(page, "New local terminal").getByTestId("palette-keys")).toHaveText("Ctrl+Shift+`");
  await expect(option(page, "Refresh").getByTestId("palette-keys")).toHaveText("F5");
  await expect(option(page, "Keyboard shortcuts").getByTestId("palette-keys")).toHaveText("?");
  await expect(option(page, "Settings…").getByTestId("palette-keys")).toHaveText("Ctrl+,");
  await expect(option(page, "Go to Overview").getByTestId("palette-keys")).toHaveText("1");
  // A key does not make its row taller.
  const heights = await palette(page)
    .getByRole("option")
    .evaluateAll((os) => os.map((o) => Math.round(o.getBoundingClientRect().height)));
  expect(new Set(heights).size).toBe(1);
  await expect(option(page, "Check for updates").getByTestId("palette-keys")).toHaveCount(0);
  await page.keyboard.press("Escape");

  // With a dock tab, Hide the dock shows Ctrl+`.
  await terminalButton(page).click();
  await expect(dock(page).getByRole("tab")).toHaveCount(1);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+k");
  await page.keyboard.type("hide the dock");
  await expect(option(page, "Hide the dock").getByTestId("palette-keys")).toHaveText("Ctrl+`");
});

for (const theme of ["dark", "light"] as const) {
  test(`at 1280x800 the header still fits with Terminal and Ask AI (${theme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.emulateMedia({ colorScheme: theme });
    await openApp(page, (cluster) => {
      cluster.askAi = { found: ["claude"], nauvi: true, customError: "" };
    });
    await expect(page.getByTestId("ask-ai-header")).toBeVisible();
    const header = page.getByTestId("cluster-band");
    const fits = await header.evaluate((h) => h.scrollWidth <= h.clientWidth);
    expect(fits).toBe(true);
    // Every control is inside the window, none on top of the next.
    const boxes = await header.evaluate((h) =>
      [...h.children]
        .filter((c) => c.getBoundingClientRect().width > 0 && getComputedStyle(c).visibility !== "hidden")
        .map((c) => {
          const r = c.getBoundingClientRect();
          return { left: Math.round(r.left), right: Math.round(r.right) };
        }),
    );
    for (const b of boxes) expect(b.right).toBeLessThanOrEqual(1280);
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].left).toBeGreaterThanOrEqual(boxes[i - 1].right - 1);
    await expect(terminalButton(page)).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: test.info().outputPath(`header-${theme}.png`) });
  });
}

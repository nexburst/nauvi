// The webview's own behaviour (#205): the engine's context menu only where
// typing goes, and its reload keys running the app's Refresh instead.

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

/**
 * Right-click `target` and tell whether the engine's menu would open: a
 * listener added after the app's sees whether the event was prevented.
 */
async function engineMenuOn(page: Page, target: Locator): Promise<boolean> {
  await page.evaluate(() => {
    window.addEventListener("contextmenu", (e) => ((window as unknown as { lastMenu: boolean }).lastMenu = !e.defaultPrevented), {
      once: true,
    });
  });
  await target.click({ button: "right" });
  return page.evaluate(() => (window as unknown as { lastMenu: boolean }).lastMenu);
}

/** Set a marker a real page load would wipe. */
const markPage = (page: Page) => page.evaluate(() => ((window as unknown as { marker: number }).marker = 205));
const pageKept = (page: Page) => page.evaluate(() => (window as unknown as { marker?: number }).marker === 205);

test("the engine's menu opens only in text fields, the YAML editor and the terminal", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Deployments");

  expect(await engineMenuOn(page, page.getByRole("button", { name: "Refresh" }))).toBe(false);
  // A kind in the sidebar opens the app's own menu (pin, #481), not the engine's.
  const pods = page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true });
  expect(await engineMenuOn(page, pods)).toBe(false);
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect(await engineMenuOn(page, page.locator("#table-filter"))).toBe(true);
  // A row opens the app's own menu instead.
  expect(await engineMenuOn(page, row(page, "web"))).toBe(false);
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  await row(page, "web").click();
  await page.locator("aside").getByRole("tab", { name: "YAML" }).click();
  await expect(page.locator("aside .code-editor")).toHaveAttribute("data-ready", "true");
  expect(await engineMenuOn(page, page.locator("aside .cm-content"))).toBe(true);
  expect(await engineMenuOn(page, page.locator("aside h3", { hasText: "YAML" }))).toBe(false);

  await page.keyboard.press("ControlOrMeta+Shift+j");
  const term = page.getByTestId("dock").locator(".xterm");
  await expect(term).toContainText("kubectl uses context");
  expect(await engineMenuOn(page, term)).toBe(true);
});

test("F5 and Ctrl/Cmd+R run Refresh, never a page reload", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Deployments");
  await markPage(page);
  const lists = async () => (await fake.calls("cmdListNamespaces")).length;

  for (const key of ["F5", "ControlOrMeta+r", "ControlOrMeta+Shift+r", "Control+F5"]) {
    const before = await lists();
    const watch = await fake.lastWatchId();
    await page.keyboard.press(key);
    // Refresh restarts the table's watch and lists the namespaces again.
    await expect.poll(lists, key).toBeGreaterThan(before);
    await expect.poll(() => fake.lastWatchId(), key).not.toBe(watch);
  }
  // From the table filter too.
  await page.locator("#table-filter").click();
  let before = await lists();
  await page.keyboard.press("F5");
  await expect.poll(lists).toBeGreaterThan(before);

  // From the YAML editor, which keeps its edit.
  await row(page, "web").click();
  await page.locator("aside").getByRole("tab", { name: "YAML" }).click();
  await expect(page.locator("aside .code-editor")).toHaveAttribute("data-ready", "true");
  const editor = page.getByRole("textbox", { name: "Deployment YAML", exact: true });
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText("# kept\n");
  before = await lists();
  await page.keyboard.press("ControlOrMeta+r");
  await expect.poll(lists).toBeGreaterThan(before);
  await expect(editor).toContainText("# kept");
  expect(await pageKept(page)).toBe(true);
  expect(fake.errors).toEqual([]);
});

test("behind a dialog the reload keys do nothing", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await markPage(page);
  await row(page, "web-1").click({ button: "right" });
  await page.getByRole("menuitem", { name: /Delete/ }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  const before = (await fake.calls("cmdListNamespaces")).length;
  await page.keyboard.press("F5");
  await page.keyboard.press("ControlOrMeta+r");
  await expect(page.getByRole("alertdialog")).toBeVisible();
  expect((await fake.calls("cmdListNamespaces")).length).toBe(before);
  expect(await pageKept(page)).toBe(true);
});

test("the Refresh button names its keys", async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole("button", { name: "Refresh" })).toHaveAttribute("title", /^Refresh \(F5 or (Ctrl\+R|⌘R)\)$/);
});

test("in a terminal, Ctrl+R and F5 go to the shell", async ({ page }) => {
  const fake = await openApp(page);
  const mac = await page.evaluate(() => /Mac/.test(navigator.platform));
  test.skip(mac, "F5 is the shell's and ⌘R refreshes on macOS: checked by the unit tests");
  await page.keyboard.press("ControlOrMeta+Shift+j");
  await expect(page.getByTestId("dock").locator(".xterm")).toContainText("kubectl uses context");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  const before = (await fake.calls("cmdListNamespaces")).length;
  await page.keyboard.press("Control+r");
  await page.keyboard.press("F5");
  await expect
    .poll(async () => (await fake.calls("cmdLocalShellInput")).map((c) => c.data).join(""))
    .toBe("\x12\x1b[15~");
  expect((await fake.calls("cmdListNamespaces")).length).toBe(before);
});

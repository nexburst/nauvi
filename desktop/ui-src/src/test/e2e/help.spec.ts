import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./helpers";

// The Help menu, About with Copy diagnostics, and UI errors forwarded to
// the app log (#208).

const helpButton = (page: Page) => page.getByRole("button", { name: "Help", exact: true });
const menu = (page: Page) => page.getByTestId("context-menu");

test("the Help menu opens the documentation, a bug report and the log folder", async ({ page }) => {
  const fake = await openApp(page);
  await helpButton(page).click();
  await expect(menu(page).getByRole("menuitem")).toHaveText([
    "Documentation",
    "Report a bug…",
    "Open log folder",
    "About nauvi",
  ]);
  await menu(page).getByRole("menuitem", { name: "Documentation" }).click();
  await expect(menu(page)).toHaveCount(0);
  await helpButton(page).click();
  await menu(page).getByRole("menuitem", { name: "Report a bug…" }).click();
  await helpButton(page).click();
  await menu(page).getByRole("menuitem", { name: "Open log folder" }).click();
  // The page only names the item; the backend has the URLs and the folder.
  await expect.poll(() => fake.calls("cmdHelpOpen")).toEqual([
    { item: "documentation" },
    { item: "report_bug" },
    { item: "log_folder" },
  ]);
  expect(fake.errors).toEqual([]);
});

test("Escape closes the Help menu; a failure shows a notice", async ({ page }) => {
  const fake = await openApp(page);
  await helpButton(page).click();
  await expect(menu(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu(page)).toHaveCount(0);

  await fake.failNext("cmdHelpOpen", "Could not open the log folder /x: no file manager");
  await helpButton(page).click();
  await menu(page).getByRole("menuitem", { name: "Open log folder" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not open the log folder /x: no file manager");
});

test("About shows the version and commit and copies the diagnostics", async ({ page }) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (t: string) => void copied.push(t) },
      configurable: true,
    });
  });
  const fake = await openApp(page);
  await helpButton(page).click();
  await menu(page).getByRole("menuitem", { name: "About nauvi" }).click();
  const about = page.getByTestId("about-settings");
  await expect(about).toBeInViewport();
  await expect(page.getByTestId("about-version")).toContainText("nauvi 0.1.0");
  await expect(page.getByTestId("about-version")).toContainText("0123456789ab");
  await expect(page.getByTestId("diagnostics-text")).toContainText("Webview: WebKitGTK");

  await about.getByRole("button", { name: "Copy diagnostics" }).click();
  await expect(page.getByTestId("diagnostics-copied")).toHaveText("Copied.");
  const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  expect(copied).toHaveLength(1);
  expect(copied[0]).toContain("nauvi 0.1.0\nCommit: 0123456789ab");

  await about.getByRole("button", { name: "Open log folder" }).click();
  await expect.poll(() => fake.calls("cmdHelpOpen")).toEqual([{ item: "log_folder" }]);
  expect(fake.errors).toEqual([]);
});

test("a failed copy says so", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
  });
  await openApp(page);
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByTestId("about-settings").getByRole("button", { name: "Copy diagnostics" }).click();
  await expect(page.getByTestId("diagnostics-copied")).toContainText("Could not copy to the clipboard");
});

test("uncaught errors and rejections go to the app log, once each", async ({ page }) => {
  const fake = await openApp(page);
  await page.evaluate(() => {
    setTimeout(() => {
      throw new TypeError("x is not a function");
    });
    void Promise.reject(new Error("lost promise"));
    void Promise.reject(new Error("lost promise"));
  });
  await expect
    .poll(async () => (await fake.calls("cmdLogUiError")).map((c) => `${c.source}: ${c.message}`).sort())
    .toEqual(["error: TypeError: x is not a function", "rejection: Error: lost promise"]);
  const [first] = await fake.calls("cmdLogUiError");
  expect(typeof first.stack).toBe("string");
});

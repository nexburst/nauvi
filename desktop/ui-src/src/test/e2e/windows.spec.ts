import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// One window per cluster (#45). The fake backend cannot open real windows:
// these tests check the entry points call `cmd_open_window`, and how a page
// behaves as a window opened for a context (`test.html?window=cluster-1`).

const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const options = (page: Page) => palette(page).getByRole("option");
const contextSelect = (page: Page) => page.getByRole("combobox", { name: "Cluster context" });

test("the header opens the current context in a new window", async ({ page }) => {
  const fake = await openApp(page);
  await contextSelect(page).selectOption("prod");
  await expect.poll(async () => (await fake.calls("cmdSetContext")).length).toBe(1);

  await page.getByRole("button", { name: "Open in new window" }).click();
  await expect.poll(() => fake.calls("cmdOpenWindow")).toEqual([{ context: "prod" }]);
  // This window stays where it was.
  await expect(contextSelect(page)).toHaveValue("prod");
  expect(fake.errors).toEqual([]);
});

test("the palette opens a chosen context in a new window", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("open context");
  await expect(options(page).first()).toContainText("Open context in new window…");
  await page.keyboard.press("Enter");

  // It opens again on the contexts, with the `win ` prefix.
  await expect(palette(page).getByRole("combobox")).toHaveValue("win ");
  await expect(options(page)).toHaveText(["Open kind-dev in new window", "Open prod in new window"]);
  await page.keyboard.type("prod");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect.poll(() => fake.calls("cmdOpenWindow")).toEqual([{ context: "prod" }]);
  // No switch in this window.
  expect(await fake.calls("cmdSetContext")).toEqual([]);
  await expect(row(page, "web-1")).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("a failure to open a window is shown", async ({ page }) => {
  const fake = await openApp(page);
  await fake.failNext("cmdOpenWindow", "Could not open a new window: no display");
  await page.getByRole("button", { name: "Open in new window" }).click();
  await expect(page.getByText("Could not open a new window: no display")).toBeVisible();
});

test("a window opened for a context does not switch to the remembered one", async ({ page }) => {
  const fake = await openApp(
    page,
    (cluster) => {
      // The backend connected this window to prod before it loaded.
      cluster.contexts = cluster.contexts.map((c) => ({ ...c, current: c.name === "prod" }));
      cluster.contexts.push({ name: "staging", current: false, namespace: null });
      cluster.settings.last_context = "kind-dev";
    },
    { url: "/test.html?window=cluster-1" },
  );
  await expect(contextSelect(page)).toHaveValue("prod");
  expect(await fake.calls("cmdSetContext")).toEqual([]);

  // Switching here is this window's business: the main window's context
  // (`last_context`) is not touched.
  await contextSelect(page).selectOption("staging");
  await expect.poll(async () => (await fake.calls("cmdSetContext")).length).toBe(1);
  const settings = await page.evaluate(() => window.__fake.cluster.settings);
  expect(settings.last_context).toBe("kind-dev");
  const updates = await fake.calls("cmdUpdateSettings");
  expect(updates.some((u) => "last_context" in (u.patch as object))).toBe(false);
  expect(fake.errors).toEqual([]);
});

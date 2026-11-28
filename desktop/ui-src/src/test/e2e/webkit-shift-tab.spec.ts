import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { FakeCluster } from "../fixtures/cluster";
import { openApp, openKind, row } from "./helpers";

// WebKitGTK names Shift+Tab by its keysym (ISO_Left_Tab): `key` is
// "Unidentified", `code` is "Tab" (#598). Chromium never sends that, so these
// tests dispatch the event the real webview sends to the focused element.

const grid = (page: Page) => page.getByRole("grid");
const dialog = (page: Page) => page.getByTestId("action-dialog");
const confirmButton = (page: Page) => page.getByTestId("action-confirm");
const protectedConfirm = (page: Page) => page.getByTestId("protected-confirm");
const menu = (page: Page) => page.getByRole("menu");

/** WebKitGTK's Shift+Tab, on the focused element. Returns whether a handler took it. */
const webkitShiftTab = (page: Page) =>
  page.evaluate(() => {
    const e = new KeyboardEvent("keydown", {
      key: "Unidentified",
      code: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    (document.activeElement ?? document.body).dispatchEvent(e);
    return e.defaultPrevented;
  });

const protectedDev = (cluster: FakeCluster) => {
  cluster.settings.contexts["kind-dev"] = {
    view: "",
    namespaces: [],
    typed_namespaces: [],
    prometheus: "",
    display_name: "",
    color: "",
    default_namespace: "",
    shell_cwd: "",
    last_used: 0,
    hide_metrics: false,
    mode: "protected",
    mode_source: { file: "", given: "", context: "" },
  };
};

async function selectTwo(page: Page) {
  await openKind(page, "Pods");
  await expect(row(page, "crashed")).toBeVisible();
  await grid(page).focus();
  await page.keyboard.press("j");
  await page.keyboard.press(" ");
  await page.keyboard.press("j");
  await page.keyboard.press(" ");
  await expect(page.getByRole("toolbar", { name: "Selection" })).toContainText("2 selected");
}

test("WebKitGTK's Shift+Tab goes round a confirm dialog's buttons", async ({ page }) => {
  const fake = await openApp(page);
  await selectTwo(page);
  await page.keyboard.press("Control+d");
  await expect(confirmButton(page)).toBeFocused();
  const cancel = dialog(page).getByRole("button", { name: "Cancel" });
  expect(await webkitShiftTab(page)).toBe(true);
  await expect(cancel).toBeFocused();
  expect(await webkitShiftTab(page)).toBe(true);
  await expect(confirmButton(page)).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(await fake.calls("cmdBulkDelete")).toEqual([]);
});

test("WebKitGTK's Shift+Tab stays in a protected cluster's type-the-name prompt", async ({ page }) => {
  const fake = await openApp(page, protectedDev);
  await selectTwo(page);
  await page.keyboard.press("Control+d");
  await expect(confirmButton(page)).toBeFocused();
  await page.keyboard.press("Enter");
  const input = protectedConfirm(page).getByTestId("protected-confirm-input");
  await expect(input).toBeFocused();
  expect(await webkitShiftTab(page)).toBe(true);
  await expect(protectedConfirm(page).getByRole("button", { name: "Cancel" })).toBeFocused();
  expect(await webkitShiftTab(page)).toBe(true);
  await expect(input).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(protectedConfirm(page)).toHaveCount(0);
  expect(await fake.calls("cmdBulkDelete")).toEqual([]);
});

test("WebKitGTK's Shift+Tab closes the context menu", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await expect(menu(page)).toBeVisible();
  expect(await webkitShiftTab(page)).toBe(true);
  await expect(menu(page)).toHaveCount(0);
});

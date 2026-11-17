import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { ClusterStateChanged } from "../../lib/bindings";
import { openApp } from "./helpers";

// Idle disconnect (ADR 0007, #333): the timeout in Settings, and what the
// backend's reaper reports about the clusters the window does not show.

const settingsDialog = (page: Page) => page.getByTestId("settings");
const idleSelect = (page: Page) =>
  settingsDialog(page).getByRole("combobox", {
    name: "Disconnect idle clusters after",
  });

async function openSettings(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  await expect(settingsDialog(page)).toBeVisible();
}

function emit(page: Page, change: ClusterStateChanged) {
  return page.evaluate((c) => window.__fake.emitClusterState(c), change);
}

test("the idle timeout defaults to 10 minutes, can be never, and is remembered", async ({ page }) => {
  const fake = await openApp(page);
  await openSettings(page);
  await expect(idleSelect(page)).toHaveValue("10");
  await expect(idleSelect(page).locator("option")).toHaveText([
    "1 minute",
    "5 minutes",
    "10 minutes",
    "30 minutes",
    "1 hour",
    "Never",
  ]);
  await idleSelect(page).selectOption({ label: "Never" });
  expect((await fake.lastCall("cmdUpdateSettings")).patch).toEqual({
    idle_disconnect_minutes: 0,
  });
  await idleSelect(page).selectOption({ label: "1 minute" });
  // No cluster command for a setting.
  expect((await fake.lastCall("cmdUpdateSettings")).cluster).toBeUndefined();

  await page.reload();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toBeVisible();
  await openSettings(page);
  await expect(idleSelect(page)).toHaveValue("1");
  expect(fake.errors).toEqual([]);
});

test("a value set outside the choices still shows", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.settings = { ...cluster.settings, idle_disconnect_minutes: 7 };
  });
  await openSettings(page);
  await expect(idleSelect(page)).toHaveValue("7");
  await expect(idleSelect(page).locator("option:checked")).toHaveText("7 minutes");
});

test("Settings lists the background clusters and what keeps them connected", async ({ page }) => {
  const fake = await openApp(page);
  await openSettings(page);
  // None yet.
  await expect(settingsDialog(page).getByTestId("background-clusters")).toHaveCount(0);

  await emit(page, {
    cluster: "prod",
    state: "connected",
    pinnedBy: ["port-forward", "log-stream"],
  });
  const list = settingsDialog(page).getByTestId("background-clusters");
  await expect(list.locator("li")).toHaveText(["prod Connected, kept by a port-forward and a log stream."]);

  await emit(page, { cluster: "prod", state: "idle", pinnedBy: [] });
  await expect(list.locator("li")).toHaveText([/^prod Disconnected while idle/]);

  await emit(page, {
    cluster: "staging",
    state: "connected",
    pinnedBy: ["browser-login"],
  });
  await expect(list.locator("li")).toHaveText([
    /^prod Disconnected while idle/,
    /^staging Connected, kept by its browser login/,
  ]);

  // The window's own cluster is never listed; a disconnected one goes.
  await emit(page, { cluster: "kind-dev", state: "connected", pinnedBy: [] });
  await emit(page, { cluster: "prod", state: "disconnected", pinnedBy: [] });
  await expect(list.locator("li")).toHaveText([/^staging/]);
  expect(fake.errors).toEqual([]);
});

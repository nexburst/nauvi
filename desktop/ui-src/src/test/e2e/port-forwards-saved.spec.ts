// Saved port-forwards (#217): kept across restarts, edited, started,
// stopped and deleted in Network → Port Forwards.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

const dialog = (page: Page) => page.getByTestId("forward-dialog");
const forwardRows = (page: Page) => page.getByTestId("forward-row");

async function openForwardsView(page: Page) {
  await openKind(page, "Port Forwards");
  await expect(page.getByTestId("port-forwards")).toBeVisible();
}

/** Forward Service demo/api port 80 from its context menu. */
async function forwardApi(page: Page, local: string, opts: { auto?: boolean } = {}) {
  await openKind(page, "Services");
  await row(page, "api").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Port forward…" }).click();
  await dialog(page).getByLabel("Local port").fill(local);
  if (opts.auto) await dialog(page).getByLabel("Start automatically").check();
  await dialog(page).getByTestId("forward-confirm").click();
  await expect(dialog(page)).toHaveCount(0);
}

test("a forward is edited to https and opens itself in the browser", async ({ page }) => {
  const fake = await openApp(page);
  await forwardApi(page, "18443");
  expect(await page.evaluate(() => window.__fake.opened())).toEqual([]);

  await openForwardsView(page);
  const r = forwardRows(page).first();
  await expect(r).toContainText("http://127.0.0.1:18443");
  await r.getByRole("button", { name: "Edit svc/demo/api:80" }).click();
  const d = dialog(page);
  await expect(d.getByRole("heading")).toHaveText("Edit port forward");
  await expect(d.getByLabel("Local port")).toHaveValue("18443");
  await expect(d.getByLabel("Service port")).toHaveValue("80");
  await d.getByLabel("https").check();
  await d.getByLabel("Open in browser").check();
  await d.getByLabel("Local port").fill("18444");
  await expect(d.getByTestId("forward-confirm")).toHaveText("Save and restart");
  await d.getByTestId("forward-confirm").click();
  await expect(d).toHaveCount(0);

  // Restarted on the new port, with an https URL, and opened.
  await expect(forwardRows(page)).toHaveCount(1);
  await expect(r).toContainText("https://127.0.0.1:18444");
  await expect.poll(() => page.evaluate(() => window.__fake.opened())).toEqual(["https://127.0.0.1:18444"]);
  expect(await fake.calls("cmdPortforwardStartSaved")).toHaveLength(2);

  // Editing a stopped forward only saves it.
  await r.getByRole("button", { name: "Stop https://127.0.0.1:18444" }).click();
  await expect(r).toContainText("Stopped");
  await r.getByRole("button", { name: "Edit svc/demo/api:80" }).click();
  await expect(d.getByTestId("forward-confirm")).toHaveText("Save");
  await d.getByLabel("Local port").fill("bad");
  await d.getByTestId("forward-confirm").click();
  await expect(d.getByRole("alert")).toHaveText("The local port must be a number between 0 and 65535, or empty.");
  await d.getByLabel("Local port").fill("");
  await d.getByTestId("forward-confirm").click();
  await expect(d).toHaveCount(0);
  await expect(r).toContainText("Stopped");
  await expect(r).toContainText("auto → 80");
  expect(await fake.calls("cmdPortforwardStartSaved")).toHaveLength(2);
  expect(fake.errors).toEqual([]);
});

test("saved forwards come back after a restart: stopped, or started if asked", async ({ page }) => {
  await openApp(page);
  await forwardApi(page, "8081", { auto: true });
  await forwardApi(page, "8082");

  // A reload is a restart: the fake backend's running forwards are gone, the settings stay.
  await page.reload();
  await openForwardsView(page);
  await expect(forwardRows(page)).toHaveCount(2);
  const auto = forwardRows(page).nth(0);
  const manual = forwardRows(page).nth(1);
  await expect(auto).toContainText("auto-start");
  await expect(auto).toContainText("Listening");
  await expect(auto).toContainText("http://127.0.0.1:8081");
  await expect(manual).toContainText("Stopped");
  await expect(manual).toContainText("http://127.0.0.1:8082");
  await expect(page.getByRole("contentinfo")).toContainText("2 forwards, 1 running");
  // Starting on its own never opens the browser.
  expect(await page.evaluate(() => window.__fake.opened())).toEqual([]);
  await manual.getByRole("button", { name: "Start svc/demo/api:80" }).click();
  await expect(manual).toContainText("Listening");

  await manual.getByRole("button", { name: "Delete svc/demo/api:80" }).click();
  await expect(forwardRows(page)).toHaveCount(1);
  await page.reload();
  await openForwardsView(page);
  await expect(forwardRows(page)).toHaveCount(1);
});

test("a saved forward that cannot start says why in its row", async ({ page }) => {
  const fake = await openApp(page);
  await forwardApi(page, "8090");
  await openForwardsView(page);
  const r = forwardRows(page).first();
  await r.getByRole("button", { name: "Stop http://127.0.0.1:8090" }).click();
  await expect(r).toContainText("Stopped");

  // Something else took the port meanwhile.
  await fake.setCluster(
    (c) =>
      c.forwards.push({
        id: "pf-other",
        saved_id: "elsewhere",
        target: { kind: "pod", namespace: "demo", name: "web-1" },
        remote: "80",
        remote_port: 80,
        local_port: 8090,
        url: "http://127.0.0.1:8090",
        started_at: 0,
        status: { pod: "web-1", connections: 0, total_connections: 0, last_error: "" },
      }),
    null,
  );
  await r.getByRole("button", { name: "Start svc/demo/api:80" }).click();
  await expect(r).toContainText("local port 8090 is already in use");
  // A forward without a saved entry here is still listed.
  await expect(forwardRows(page)).toHaveCount(2);
});

test("the empty manager explains how to start one", async ({ page }) => {
  await openApp(page);
  await openForwardsView(page);
  await expect(page.getByTestId("forwards-empty")).toContainText("No port-forwards.");
  await expect(page.getByRole("contentinfo")).toContainText("0 forwards, 0 running");
});

test("a saved forward another window runs is not started twice (#292)", async ({ page }) => {
  // On every load (a reload is a restart), another window runs the
  // auto-start forwards already, as when two restored windows connect.
  const fake = await openApp(page, (c) => {
    c.forwardsElsewhere = Object.values(c.settings.forwards)
      .flat()
      .filter((f) => f.auto_start)
      .map((f) => f.id);
  });
  await forwardApi(page, "18080", { auto: true });

  await page.reload();
  await openForwardsView(page);
  const r = forwardRows(page).first();
  await expect(r).toContainText("Running in another window");
  await expect(r).not.toContainText("already in use");
  // #297: Start is not offered there (it would fail with "port in use"); the
  // tooltip says why. Edit and Delete still are.
  const startBtn = r.getByRole("button", { name: /^Start / });
  await expect(startBtn).toBeDisabled();
  await expect(r.getByTestId("forward-start")).toHaveAttribute("title", /another window: stop it there/);
  await expect(r.getByRole("button", { name: /^Edit / })).toBeEnabled();
  await expect(r.getByRole("button", { name: /^Delete / })).toBeEnabled();
  // The other window stopped it: Start is back, without a tooltip.
  await fake.setCluster((c) => {
    c.forwardsElsewhere = [];
  }, null);
  await expect(r).toContainText("Stopped");
  await expect(startBtn).toBeEnabled();
  await expect(r.getByTestId("forward-start")).not.toHaveAttribute("title");
  await expect(page.getByText("did not start")).toHaveCount(0);
  await expect(page.getByRole("contentinfo")).toContainText("1 forward, 0 running");
  expect(await fake.calls("cmdPortforwardAutostart")).toHaveLength(1);
  expect(fake.errors).toEqual([]);
});

test("a long status keeps the row's buttons in view at 1280x800", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const fake = await openApp(page);
  await forwardApi(page, "18081");
  await openForwardsView(page);
  await fake.setCluster((c) => {
    c.forwards[0].status.last_error =
      "pod nginx-59b667b7bf-jzllk port 80: Se ha forzado la interrupción de una conexión existente por el host remoto. (os error 10054)";
  }, null);
  const r = forwardRows(page).first();
  await expect(r).toContainText("Se ha forzado");
  await expect(r.getByRole("button", { name: "Stop http://127.0.0.1:18081" })).toBeInViewport({ ratio: 1 });
  const overflow = await page.getByTestId("port-forwards").evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

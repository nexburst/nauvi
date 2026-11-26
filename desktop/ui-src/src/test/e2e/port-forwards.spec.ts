import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

const panel = (page: Page) => page.locator("aside");
const dialog = (page: Page) => page.getByTestId("forward-dialog");
const forwardRows = (page: Page) => page.getByTestId("forward-row");

async function openForwardsView(page: Page) {
  await openKind(page, "Port Forwards");
  await expect(page.getByTestId("port-forwards")).toBeVisible();
}

test("a pod forward outlives its panel and is listed, opened and stopped from Port Forwards", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panel(page).locator(".title")).toHaveText("demo/web-1");
  await expect.poll(() => fake.activeDetailWatches()).toHaveLength(1);
  await panel(page).getByLabel("Pod port").fill("8080");
  await panel(page).getByLabel("Local port").fill("18080");
  await panel(page).getByRole("button", { name: "Forward", exact: true }).click();
  await expect(panel(page).getByText("Forwarding http://127.0.0.1:18080 → web-1:8080")).toBeVisible();
  expect(await fake.lastCall("cmdPortforwardStart")).toEqual({
    target: { kind: "pod", namespace: "demo", name: "web-1" },
    remotePort: "8080",
    localPort: 18080,
  });

  // Closing the panel leaves the forward running.
  await page.getByRole("button", { name: "Close details" }).click();
  await expect(panel(page)).toHaveCount(0);
  expect(await fake.calls("cmdPortforwardStop")).toEqual([]);

  await openForwardsView(page);
  await expect(page.getByText("Forwards are saved per cluster.")).toBeVisible();
  await expect(forwardRows(page)).toHaveCount(1);
  const r = forwardRows(page).first();
  await expect(r).toContainText("pod/demo/web-1");
  await expect(r).toContainText("18080 → 8080");
  await expect(r).toContainText("http://127.0.0.1:18080");
  await expect(r).toContainText("Listening");
  await expect(page.getByRole("contentinfo")).toContainText("1 forward");

  await r.getByRole("button", { name: "Open http://127.0.0.1:18080 in the browser" }).click();
  await expect.poll(() => page.evaluate(() => window.__fake.opened())).toEqual(["http://127.0.0.1:18080"]);

  // A failing forward says why.
  await fake.setCluster((c) => (c.forwards[0].status.last_error = "pod web-1: Already gone: the object no longer exists."), null);
  await expect(r).toContainText("pod web-1: Already gone: the object no longer exists.");

  // Stopping keeps it saved: it can start again, or be deleted.
  await r.getByRole("button", { name: "Stop http://127.0.0.1:18080" }).click();
  expect((await fake.lastCall("cmdPortforwardStop")).id).toMatch(/^pf-/);
  await expect(r).toContainText("Stopped");
  await expect(r).toContainText("18080 → 8080");
  await r.getByRole("button", { name: "Start pod/demo/web-1:8080" }).click();
  await expect(r).toContainText("Listening");
  await r.getByRole("button", { name: "Delete pod/demo/web-1:8080" }).click();
  await expect(forwardRows(page)).toHaveCount(0);
  await expect(page.getByText("No port-forwards.")).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("the pod panel's status line goes when its forward stops", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panel(page).locator(".title")).toHaveText("demo/web-1");
  const status = panel(page).getByText(/^Forwarding http/);

  // Stopped from the panel.
  await panel(page).getByLabel("Pod port").fill("8080");
  await panel(page).getByRole("button", { name: "Forward", exact: true }).click();
  await expect(status).toHaveText("Forwarding http://127.0.0.1:8080 → web-1:8080");
  await panel(page).getByRole("button", { name: "Stop http://127.0.0.1:8080" }).click();
  await expect(panel(page).getByRole("button", { name: "Stop http://127.0.0.1:8080" })).toHaveCount(0);
  await expect(status).toHaveCount(0);

  // Stopped elsewhere (Port Forwards view, a context switch): the next poll drops it.
  await panel(page).getByRole("button", { name: "Forward", exact: true }).click();
  await expect(status).toHaveText("Forwarding http://127.0.0.1:8080 → web-1:8080");
  await fake.setCluster((c) => (c.forwards = []), null);
  await expect(status).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("the context menu starts a Service forward on a chosen port", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Services");
  await row(page, "api").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Port forward…" }).click();

  const d = dialog(page);
  await expect(d).toContainText("svc/demo/api");
  // The same words as the Port Forwards view (#498).
  await expect(d.getByTestId("forward-lifetime")).toHaveText(
    "Saved for this cluster in Network → Port Forwards. It keeps running until you stop it, disconnect its cluster, close this window or quit nauvi.",
  );
  await expect(d).toContainText("Leave empty to pick one for you (the same port when it is free and ≥ 1024).");
  // Only the TCP ports are offered, the first one picked.
  const select = d.getByLabel("Service port");
  await expect(select.locator("option")).toHaveText(["80/http → web", "9090/metrics → 9090"]);
  await expect(select).toHaveValue("80");

  await d.getByLabel("Local port").fill("abc");
  await d.getByTestId("forward-confirm").click();
  await expect(d.getByRole("alert")).toHaveText("The local port must be a number between 0 and 65535, or empty.");

  await d.getByLabel("Local port").fill("9000");
  await d.getByTestId("forward-confirm").click();
  await expect(d).toHaveCount(0);
  expect((await fake.lastCall("cmdPortforwardSave")).forward).toEqual({
    id: "",
    target: { kind: "service", namespace: "demo", name: "api" },
    remote: "80",
    local_port: "9000",
    https: false,
    // Port 80/http: opened in the browser unless unchecked (#498).
    open_in_browser: true,
    auto_start: false,
  });
  await expect(page.getByText("Forwarding http://127.0.0.1:9000 → svc/demo/api:80")).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.__fake.opened())).toEqual(["http://127.0.0.1:9000"]);

  // The same local port again is refused, in plain words, inside the dialog.
  await row(page, "api").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Port forward…" }).click();
  await d.getByLabel("Service port").selectOption("9090");
  // 9090 is a web port too: checked (the untouched default was not remembered).
  await expect(d.getByLabel("Open in browser")).toBeChecked();
  await d.getByLabel("Local port").fill("9000");
  await d.getByTestId("forward-confirm").click();
  await expect(d.getByRole("alert")).toHaveText(
    "local port 9000 is already in use: pick another one, or leave it empty for a free one",
  );
  await d.getByRole("button", { name: "Cancel" }).click();

  await openForwardsView(page);
  await expect(forwardRows(page)).toHaveCount(1);
  await expect(forwardRows(page).first()).toContainText("svc/demo/api");
  await expect(forwardRows(page).first()).toContainText("api-1");
});

test("an unchecked Open in browser is remembered for the next forward (#498)", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Services");
  await row(page, "api").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Port forward…" }).click();
  const d = dialog(page);
  await expect(d.getByLabel("Service port")).toHaveValue("80");
  await expect(d.getByLabel("Open in browser")).toBeChecked();
  await d.getByLabel("Open in browser").uncheck();
  await d.getByTestId("forward-confirm").click();
  await expect(d).toHaveCount(0);
  expect((await fake.lastCall("cmdPortforwardSave")).forward).toMatchObject({ open_in_browser: false });
  expect(await page.evaluate(() => window.__fake.opened())).toEqual([]);

  await row(page, "api").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Port forward…" }).click();
  await expect(d.getByLabel("Service port")).toHaveValue("80");
  await expect(d.getByLabel("Open in browser")).not.toBeChecked();
  await d.getByRole("button", { name: "Cancel" }).click();

  // The Port Forwards view says what stops a forward in the dialog's words.
  await openForwardsView(page);
  await expect(page.getByTestId("forwards-lifetime")).toHaveText(
    "Forwards are saved per cluster. Each keeps running until you stop it, disconnect its cluster, close this window or quit nauvi.",
  );
  expect(fake.errors).toEqual([]);
});

test("an untouched default is not remembered: after a non-web forward, port 80/http still opens (#498)", async ({
  page,
}) => {
  const fake = await openApp(page);
  // A deployment forward on 5432, the checkbox left as it was (off).
  await openKind(page, "Deployments");
  await row(page, "web").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Port forward…" }).click();
  const d = dialog(page);
  await d.getByLabel("Remote port").fill("5432");
  await expect(d.getByLabel("Open in browser")).not.toBeChecked();
  // Typing a web port name follows the port's default.
  await d.getByLabel("Remote port").fill("http");
  await expect(d.getByLabel("Open in browser")).toBeChecked();
  await d.getByLabel("Remote port").fill("5432");
  await expect(d.getByLabel("Open in browser")).not.toBeChecked();
  await d.getByTestId("forward-confirm").click();
  await expect(d).toHaveCount(0);
  expect((await fake.lastCall("cmdPortforwardSave")).forward).toMatchObject({ remote: "5432", open_in_browser: false });

  // A Service on 80/http: still checked.
  await openKind(page, "Services");
  await row(page, "api").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Port forward…" }).click();
  await expect(d.getByLabel("Service port")).toHaveValue("80");
  await expect(d.getByLabel("Open in browser")).toBeChecked();
  await d.getByRole("button", { name: "Cancel" }).click();

  // An unchecked web port is remembered for web ports only.
  await row(page, "api").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Port forward…" }).click();
  await expect(d.getByLabel("Service port")).toHaveValue("80");
  await d.getByLabel("Open in browser").uncheck();
  await d.getByTestId("forward-confirm").click();
  await expect(d).toHaveCount(0);
  await row(page, "api").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Port forward…" }).click();
  await expect(d.getByLabel("Service port")).toHaveValue("80");
  await expect(d.getByLabel("Open in browser")).not.toBeChecked();
  await d.getByRole("button", { name: "Cancel" }).click();
  expect(fake.errors).toEqual([]);
});

test("the Service panel forwards each TCP port", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Services");
  await row(page, "api").click();
  const ports = panel(page).getByTestId("service-ports");
  await expect(ports).toContainText("80/http → web");
  await expect(ports).toContainText("53/dns → 53");
  // UDP cannot be forwarded.
  await expect(ports.getByRole("button", { name: /^Forward port/ })).toHaveCount(2);

  await ports.getByRole("button", { name: "Forward port 9090" }).click();
  expect(await fake.lastCall("cmdPortforwardStart")).toEqual({
    target: { kind: "service", namespace: "demo", name: "api" },
    remotePort: "9090",
    localPort: null,
  });
  // The button becomes the forward's URL, which opens it.
  await ports.getByRole("button", { name: "Open http://127.0.0.1:9090" }).click();
  await expect.poll(() => page.evaluate(() => window.__fake.opened())).toEqual(["http://127.0.0.1:9090"]);

  // The sidebar counts it.
  await expect(page.getByRole("navigation").getByRole("button", { name: "Port Forwards" })).toContainText("1");
});

test("a deployment forward asks for a port name or number", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Deployments");
  await row(page, "web").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Port forward…" }).click();
  const d = dialog(page);
  await expect(d).toContainText("deploy/demo/web");
  await d.getByLabel("Remote port").fill("HTTP");
  await d.getByLabel("Remote port").press("Enter");
  await expect(d.getByRole("alert")).toHaveText('"HTTP" is neither a port number nor a port name.');
  await d.getByLabel("Remote port").fill("http");
  await d.getByLabel("Remote port").press("Enter");
  await expect(d).toHaveCount(0);
  expect((await fake.lastCall("cmdPortforwardSave")).forward).toMatchObject({
    target: { kind: "deployment", namespace: "demo", name: "web" },
    remote: "http",
    local_port: "",
  });
});

test("disconnecting a cluster in the tree takes its forwards off Port Forwards at once (#498)", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.backgroundForwards = [
      {
        cluster: "kind-dev",
        forward: {
          id: "pf-bg",
          saved_id: "fwd-bg",
          target: { kind: "service", namespace: "demo", name: "web" },
          remote: "80",
          remote_port: 80,
          local_port: 40080,
          url: "http://127.0.0.1:40080",
          started_at: 1,
          status: { pod: "web-1", connections: 0, total_connections: 0, last_error: "" },
        },
      },
    ];
  });
  const node = (id: string) => page.locator(`[data-testid="cluster-node"][data-cluster="${id}"]`);
  // Show prod: kind-dev's forward runs on, listed with its cluster.
  await node("prod").getByRole("button", { name: "prod", exact: true }).click();
  await expect(node("prod")).toHaveAttribute("data-state", "visible");
  await openForwardsView(page);
  const other = page.locator('[data-testid="forward-row-other"][data-cluster="kind-dev"]');
  await expect(other).toContainText("http://127.0.0.1:40080");

  // Faster than the view's 3 s poll.
  await page.clock.install();
  await node("kind-dev").hover();
  await node("kind-dev").getByRole("button", { name: "Disconnect kind-dev" }).click();
  await expect(other).toHaveCount(0, { timeout: 1000 });
});

test("the header chip's Disconnect takes the cluster's forwards off Port Forwards at once too (#498)", async ({
  page,
}) => {
  await openApp(page, (cluster) => {
    cluster.backgroundForwards = [
      {
        cluster: "kind-dev",
        forward: {
          id: "pf-bg",
          saved_id: "fwd-bg",
          target: { kind: "service", namespace: "demo", name: "web" },
          remote: "80",
          remote_port: 80,
          local_port: 40080,
          url: "http://127.0.0.1:40080",
          started_at: 1,
          status: { pod: "web-1", connections: 0, total_connections: 0, last_error: "" },
        },
      },
    ];
  });
  const node = (id: string) => page.locator(`[data-testid="cluster-node"][data-cluster="${id}"]`);
  await node("prod").getByRole("button", { name: "prod", exact: true }).click();
  await expect(node("prod")).toHaveAttribute("data-state", "visible");
  await openForwardsView(page);
  const other = page.locator('[data-testid="forward-row-other"][data-cluster="kind-dev"]');
  await expect(other).toContainText("http://127.0.0.1:40080");
  const chip = page.getByTestId("cluster-chip").filter({ hasText: "kind-dev" });
  await chip.getByRole("button", { name: "Disconnect kind-dev" }).click();
  await expect(other).toHaveCount(0, { timeout: 1000 });
});

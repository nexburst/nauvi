import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

const dock = (page: Page) => page.getByTestId("dock");
const tabs = (page: Page) => dock(page).getByRole("tab");
const pane = (page: Page, tabId: string) => dock(page).locator(`[data-testid="dock-pane"][data-tab="${tabId}"]`);
const panel = (page: Page) => page.getByTestId("detail-panel");

async function menuItem(page: Page, name: string, item: string) {
  await row(page, name).click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: item, exact: true }).click();
}

test("Attach opens the pod's main process in a dock tab; closing it detaches", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await menuItem(page, "web-1", "Attach");

  await expect(tabs(page)).toHaveText(["Attach: web-1"]);
  await expect.poll(() => fake.calls("cmdAttachStart")).toHaveLength(1);
  // No container: the backend picks the pod's default one.
  expect(await fake.lastCall("cmdAttachStart")).toMatchObject({ namespace: "demo", name: "web-1", container: null });
  // The note sent before the session id was known shows in the terminal.
  const term = pane(page, "attach:demo/web-1/").getByTestId("terminal");
  await expect(term).toContainText("Attached to web-1/app in demo. Closing this tab detaches.");
  // An attach, not a new shell.
  expect(await fake.calls("cmdExecStart")).toHaveLength(0);

  await dock(page).getByRole("button", { name: "Close Attach: web-1" }).click();
  await expect.poll(() => fake.calls("cmdExecClose")).toEqual([{ session: "attach-1" }]);
  expect(fake.errors).toEqual([]);
});

test("attaching to a container without stdin says why in the terminal", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.attachError =
      "container app was not started with stdin open (stdin: true in its spec), so there is no input to attach to. Use Shell to run a new shell in it, or Logs to see its output.";
  });
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await panel(page).getByRole("button", { name: "Attach", exact: true }).click();
  const term = pane(page, "attach:demo/web-1/").getByTestId("terminal");
  await expect(term).toContainText("Could not open terminal: container app was not started with stdin open");
});

test("All containers merges a pod's containers, each line tagged with its container", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panel(page).locator("h3", { hasText: "Containers" })).toBeVisible();
  await panel(page).getByRole("button", { name: "Logs", exact: true }).click();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(1);

  const logs = pane(page, "logs:demo/web-1");
  const picker = logs.getByTitle("Container", { exact: true });
  await expect(picker.locator("option")).toHaveText(["All containers", "init-db (init)", "app", "sidecar"]);
  await expect(picker).toHaveValue("app");
  await picker.selectOption({ label: "All containers" });

  await expect.poll(() => fake.calls("cmdStreamPodAllLogs")).toHaveLength(1);
  const call = await fake.lastCall("cmdStreamPodAllLogs");
  expect(call).toMatchObject({ namespace: "demo", name: "web-1", options: { container: null, tailLines: 200 } });
  // Previous logs are per container.
  await expect(logs.getByRole("checkbox", { name: "Previous" })).toBeDisabled();
  // The single-container stream was replaced.
  expect(await fake.activeLogStreams()).toEqual([call.streamId]);

  await fake.emitTaggedLines([
    { pod: "web-1", container: "app", line: "GET /healthz 200" },
    { pod: "web-1", container: "sidecar", line: "synced config" },
  ]);
  const lines = logs.getByTestId("log-line");
  await expect(lines).toHaveText(["[app]GET /healthz 200", "[sidecar]synced config"]);

  // The filter matches the container prefix too.
  await logs.getByPlaceholder("Filter logs…").fill("sidecar");
  await expect(lines).toHaveText(["[sidecar]synced config"]);

  // Back to one container: a plain stream again.
  await picker.selectOption("app");
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(2);
  expect(fake.errors).toEqual([]);
});

test("a pod with one container is not offered All containers", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await menuItem(page, "crashed", "Logs");
  const picker = pane(page, "logs:demo/crashed").getByTitle("Container", { exact: true });
  await expect(picker.locator("option")).toHaveText(["app"]);
});

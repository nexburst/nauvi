import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// #492: at 1280x800 with the pod's panel open, a log tab has one toolbar row
// and room for at least 12 lines. #493: "Previous" says which run is shown,
// a finished run is not followed, and the previous run is offered while the
// current one has not logged anything.

const dock = (page: Page) => page.getByTestId("dock");
const panel = (page: Page) => page.getByTestId("detail-panel");
const pane = (page: Page, tabId: string) => dock(page).locator(`[data-testid="dock-pane"][data-tab="${tabId}"]`);
const context = (page: Page, tabId: string) => pane(page, tabId).getByTestId("dock-context");

async function openCrashedLogs(page: Page) {
  await row(page, "crashed").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Logs", exact: true }).click();
}

test("one toolbar row and at least 12 lines at 1280x800 with the panel open", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panel(page).locator(".card").first()).toBeVisible();
  await panel(page).getByRole("button", { name: "Logs", exact: true }).click();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(1);
  await fake.emitLogLines(Array.from({ length: 40 }, (_, i) => `line ${i}`));

  const p = pane(page, "logs:demo/web-1");
  const toolbar = p.getByTestId("log-toolbar");
  // One row: the container, Previous, the search, Follow, Options, Download.
  const box = (await toolbar.boundingBox())!;
  expect(box.height).toBeLessThan(44);
  for (const name of ["Following", "Log options", "Download"]) {
    const b = (await p.getByRole("button", { name, exact: true }).boundingBox())!;
    expect(b.y).toBeGreaterThanOrEqual(box.y);
    expect(b.y + b.height).toBeLessThanOrEqual(box.y + box.height);
  }
  // No second heading: the context line names the pod.
  await expect(p.locator("h3")).toHaveCount(0);
  const out = (await p.getByTestId("log-output").boundingBox())!;
  expect(Math.floor(out.height / 18)).toBeGreaterThanOrEqual(12);
  expect(fake.errors).toEqual([]);
});

test("Options holds the rest and counts what changes the lines shown", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await panel(page).getByRole("button", { name: "Logs", exact: true }).click();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(1);
  const options = dock(page).getByRole("button", { name: "Log options" });
  const menu = dock(page).getByTestId("log-options");
  await expect(menu).toBeHidden();
  await options.click();
  await expect(menu).toBeVisible();
  await menu.getByTitle("Since", { exact: true }).selectOption("300");
  await menu.getByRole("searchbox", { name: "Exclude lines" }).fill("health");
  await expect(options).toContainText("2");
  // Escape and a click outside close it.
  await menu.getByRole("searchbox", { name: "Exclude lines" }).press("Escape");
  await expect(menu).toBeHidden();
  await options.click();
  await expect(menu).toBeVisible();
  await dock(page).getByTestId("log-output").click();
  await expect(menu).toBeHidden();
  expect(fake.errors).toEqual([]);
});

test("one line reads 1 line", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await panel(page).getByRole("button", { name: "Logs", exact: true }).click();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(1);
  await fake.emitLogLines(["only"]);
  await expect(dock(page).getByTestId("log-status")).toHaveText("1 line");
});

test("Previous names the run and its exit code; a finished run is not followed", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await openCrashedLogs(page);
  const id = "logs:demo/crashed";
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(1);
  // Waiting to restart: the current log is the run that crashed.
  await expect(context(page, id)).toContainText(
    "container app, last run, exited with code 137 (OOMKilled), 3m ago; waiting to restart: CrashLoopBackOff, from all time",
  );
  const follow = pane(page, id).getByTestId("log-follow");
  await expect(follow).toBeEnabled();

  await pane(page, id).getByRole("checkbox", { name: "Previous" }).check();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(2);
  expect((await fake.lastCall("cmdStreamPodLogs")).previous).toBe(true);
  await expect(pane(page, id).getByTestId("log-run")).toHaveText("previous run, exited with code 137 (OOMKilled), 3m ago");
  await expect(follow).toBeDisabled();
  await expect(follow).toHaveAttribute("title", "A finished run cannot be followed");

  await fake.emitLogLines(["FATAL: out of memory"]);
  await expect(pane(page, id).getByTestId("log-line")).toHaveText(["FATAL: out of memory"]);
  await page.evaluate(() => window.__fake.emitLogEnd(""));
  await expect(pane(page, id).getByTestId("log-line")).toHaveText(["FATAL: out of memory", "[end of the previous run]"]);

  // Off again: the current run, followed.
  await pane(page, id).getByRole("checkbox", { name: "Previous" }).uncheck();
  await expect(follow).toBeEnabled();
  await expect(follow).toHaveText("Following");
  expect(fake.errors).toEqual([]);
});

test("a restarted container that has not logged yet offers the run that crashed", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    const c = cluster.details["v1/pods|demo/crashed"].pod.containers[0];
    c.state = { state: "running", reason: "", message: "", exit_code: 0, since: "4s" };
    c.last_state = { state: "terminated", reason: "Error", message: "", exit_code: 1, since: "5s" };
    c.restarts = 2;
  });
  await openKind(page, "Pods");
  await openCrashedLogs(page);
  const id = "logs:demo/crashed";
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(1);
  await expect(context(page, id)).toContainText("current run, started 4s ago after 2 restarts");
  const offer = pane(page, id).getByTestId("log-offer");
  await expect(offer).toContainText("This run has not logged anything yet.");
  await offer.getByRole("button", { name: "Show the run that crashed" }).click();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(2);
  expect((await fake.lastCall("cmdStreamPodLogs")).previous).toBe(true);
  await expect(pane(page, id).getByRole("checkbox", { name: "Previous" })).toBeChecked();
  await expect(pane(page, id).getByTestId("log-run")).toHaveText("previous run, exited with code 1, 5s ago");
  await expect(offer).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

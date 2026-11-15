import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";
import type { Fake } from "./helpers";

// #178: the "Saved to …" note after Download stays several seconds while new
// lines arrive, in one line, without moving the log list.

const panel = (page: Page) => page.getByTestId("detail-panel");
const logs = (page: Page) => page.getByTestId("dock");
const logLines = (page: Page) => logs(page).getByTestId("log-line");
const note = (page: Page) => logs(page).getByTestId("log-saved");

async function openPodLogs(page: Page): Promise<Fake> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.install();
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panel(page).locator(".card").first()).toBeVisible();
  await panel(page).getByRole("button", { name: "Logs", exact: true }).click();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(1);
  return fake;
}

test("the note survives new log lines and goes after 10 s", async ({ page }) => {
  const fake = await openPodLogs(page);
  await fake.emitLogLines(["one", "two"]);
  await expect(logLines(page)).toHaveCount(2);

  await logs(page).getByRole("button", { name: "Download" }).click();
  const { filename } = await fake.lastCall("cmdSaveLogs");
  await expect(note(page)).toHaveText(`Saved to Downloads/${filename}`);
  await expect(note(page)).toHaveAttribute("title", `/home/tester/Downloads/${filename}`);

  // A streaming pod: lines keep coming, the note and the line count both stay.
  for (let i = 0; i < 3; i++) {
    await page.clock.runFor(2_000);
    await fake.emitLogLines([`line ${i}`]);
  }
  await expect(logLines(page)).toHaveCount(5);
  await expect(note(page)).toHaveText(`Saved to Downloads/${filename}`);
  await expect(logs(page).locator(".logs-options")).toContainText("5 lines");

  await page.clock.runFor(5_000);
  await expect(note(page)).toHaveText("");
  expect(fake.errors).toEqual([]);
});

test("a long file name stays on one line and does not move the log list", async ({ page }) => {
  const fake = await openPodLogs(page);
  await fake.emitLogLines(["one"]);
  await expect(logLines(page)).toHaveCount(1);
  const header = logs(page).locator(".logs-header");
  const output = logs(page).getByTestId("log-output");
  const before = { header: await header.boundingBox(), output: await output.boundingBox() };

  await logs(page).getByRole("button", { name: "Download" }).click();
  await expect(note(page)).toContainText("Saved to Downloads/");
  const after = { header: await header.boundingBox(), output: await output.boundingBox() };
  expect(after.header?.height).toBe(before.header?.height);
  expect(after.output?.y).toBe(before.output?.y);
  // Clipped with an ellipsis rather than wrapped.
  const style = await note(page).evaluate((el) => {
    const s = getComputedStyle(el);
    return { whiteSpace: s.whiteSpace, overflow: s.textOverflow };
  });
  expect(style).toEqual({ whiteSpace: "nowrap", overflow: "ellipsis" });
  await expect(logs(page).getByRole("button", { name: "Download" })).toBeInViewport();
});

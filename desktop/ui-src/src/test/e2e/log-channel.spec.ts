import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";
import type { Fake } from "./helpers";

// #115: each log stream has its own channel; lines come as raw UTF-8 and
// the rest (errors, the end, merged lines) as JSON on the same channel.

const panel = (page: Page) => page.getByTestId("detail-panel");
const logs = (page: Page) => page.getByTestId("dock");
const logLines = (page: Page) => logs(page).getByTestId("log-line");

async function openPodLogs(page: Page): Promise<Fake> {
  await page.setViewportSize({ width: 1280, height: 800 });
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panel(page).locator(".card").first()).toBeVisible();
  await panel(page).getByRole("button", { name: "Logs", exact: true }).click();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(1);
  return fake;
}

test("raw lines keep multi-byte characters and empty lines", async ({ page }) => {
  const fake = await openPodLogs(page);
  await fake.emitLogLines(["héllo wörld", "", "日本語 ✓"]);
  await expect(logLines(page)).toHaveText(["héllo wörld", "", "日本語 ✓"]);
});

test("a restarted stream gets a new channel; the old one is ignored", async ({ page }) => {
  const fake = await openPodLogs(page);
  const first = await fake.lastStreamId();
  await logs(page).getByRole("checkbox", { name: "Timestamps" }).check();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(2);
  const calls = await fake.calls("cmdStreamPodLogs");
  expect(calls[1].onEvent).not.toEqual(calls[0].onEvent);
  await fake.emitLogLines(["from the old stream"], first ?? undefined);
  await fake.emitLogLines(["from the new stream"]);
  await page.evaluate(() => window.__fake.emitLogEnd("container not found"));
  await expect(logLines(page)).toHaveText(["from the new stream", "container not found", "[stream ended]"]);
});

test("each raw batch is acknowledged with its bytes, events are not (#397)", async ({ page }) => {
  const fake = await openPodLogs(page);
  const id = await fake.lastStreamId();
  await fake.emitLogLines(["héllo", "two"]);
  await page.evaluate(() => window.__fake.emitLogEnd("gone"));
  await expect(logLines(page)).toHaveText(["héllo", "two", "gone", "[stream ended]"]);
  // "héllo\ntwo" is 10 bytes of UTF-8.
  await expect.poll(() => fake.calls("cmdLogAck")).toEqual([{ streamId: id, bytes: 10 }]);
});

test("a failed ack is sent once more, and the tab keeps working (#397)", async ({ page }) => {
  const fake = await openPodLogs(page);
  const id = await fake.lastStreamId();
  await fake.failNext("cmdLogAck", "lost");
  await fake.emitLogLines(["one"]);
  await expect(logLines(page)).toHaveText(["one"]);
  await expect.poll(() => fake.calls("cmdLogAck")).toEqual([
    { streamId: id, bytes: 3 },
    { streamId: id, bytes: 3 },
  ]);
  await fake.emitLogLines(["two"]);
  await expect(logLines(page)).toHaveText(["one", "two"]);
});

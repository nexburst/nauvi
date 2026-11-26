// Pod panel follow-ups (#513): Usage is one line when there is no data,
// "Describe" and "Copy kubectl describe" are in the palette, and long event
// messages wrap inside the panel, folded to a few lines with "Show all".
// (The `openApp` init functions are serialized: their strings are inline.)
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

const panel = (page: Page) => page.getByTestId("detail-panel");
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const option = (page: Page, label: string) =>
  palette(page)
    .getByRole("option")
    .filter({ has: page.getByText(label, { exact: true }) });

async function captureClipboard(page: Page) {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = copied;
    // writeText only: the fallback path, as without ClipboardItem.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (t: string) => void copied.push(t) },
      configurable: true,
    });
  });
}
const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

/** Focus the first row (`crashed`, in demo) and open the palette on `query`. */
async function paletteOn(page: Page, query: string, { focusRow = true } = {}) {
  if (focusRow) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ControlOrMeta+k");
  await expect(palette(page)).toBeVisible();
  await page.keyboard.type(query);
}

test("a pod without usage data has Usage on one line, the why in its tooltip", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-2").click();
  const usage = panel(page).getByTestId("usage-charts");
  const empty = usage.getByTestId("usage-empty");
  await expect(empty).toHaveText("No usage data yet");
  await expect(empty).toHaveAttribute("title", /metrics-server has no sample for this pod, or is not installed\./);
  await expect(empty).toHaveAttribute("title", /No Prometheus Service found/);
  // The Prometheus search is not spelled out on the panel.
  await expect(usage.getByTestId("usage-note")).toHaveCount(0);
  const heading = await usage.getByRole("heading", { name: "Usage" }).boundingBox();
  const line = await empty.boundingBox();
  expect(Math.abs(heading!.y + heading!.height / 2 - (line!.y + line!.height / 2))).toBeLessThan(4);
  const box = await usage.boundingBox();
  expect(box!.height).toBeLessThan(48);
  // A pod with data keeps its note and charts.
  await panel(page).getByRole("button", { name: "Close details" }).click();
  await row(page, "web-1").click();
  await expect(usage.getByTestId("usage-chart-cpu")).toBeVisible();
  await expect(usage.getByTestId("usage-note")).toContainText("No Prometheus Service found");
  await expect(usage.getByTestId("usage-empty")).toHaveCount(0);
});

test("Describe in the palette opens the panel; Copy kubectl describe copies its text", async ({ page }) => {
  await captureClipboard(page);
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await paletteOn(page, "describe");
  await expect(option(page, "Describe")).toContainText("demo/crashed");
  await expect(option(page, "Copy kubectl describe")).toBeVisible();
  await option(page, "Describe").click();
  await expect(palette(page)).toHaveCount(0);
  await expect(panel(page)).toContainText("demo/crashed");

  // Still on crashed: the palette is about the focused row.
  await paletteOn(page, "kubectl describe", { focusRow: false });
  await option(page, "Copy kubectl describe").click();
  await expect(page.getByTestId("action-notice")).toContainText("Copied the describe of Pod crashed");
  const [text] = await copied(page);
  expect(text).toMatch(/^Name: +crashed\nNamespace: +demo\nKind: +Pod\n/);
  expect(await fake.lastCall("cmdDescribeResource")).toEqual({
    resource: expect.objectContaining({ kind: "Pod" }),
    namespace: "demo",
    name: "crashed",
  });
  expect(fake.errors).toEqual([]);
});

test("Copy kubectl describe says why when the object cannot be read", async ({ page }) => {
  await captureClipboard(page);
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await fake.failNext("cmdDescribeResource", 'pods "crashed" not found');
  await paletteOn(page, "copy kubectl describe");
  await option(page, "Copy kubectl describe").click();
  await expect(page.getByRole("alert")).toContainText('Could not describe Pod crashed: pods "crashed" not found');
  expect(await copied(page)).toEqual([]);
});

test("long event messages wrap inside the panel and fold to a few lines", async ({ page }) => {
  await openApp(page, (cluster) => {
    const d = cluster.details["v1/pods|demo/crashed"];
    const ref = "registry.invalid/inventory-api:1.2.3@sha256:" + "0123456789abcdef".repeat(4);
    d.events = [
      {
        type: "Warning",
        reason: "Failed",
        message:
          `Failed to pull image "${ref}": rpc error: code = Unknown desc = failed to pull and unpack image ` +
          `"${ref}": failed to resolve reference "${ref}": failed to do request: Head ` +
          '"https://registry.invalid/v2/inventory-api/manifests/1.2.3": dial tcp: lookup registry.invalid ' +
          "on 10.96.0.10:53: no such host",
        count: 3,
        age: "20s",
        time: 0,
      },
      {
        type: "Normal",
        reason: "Scheduled",
        message: "Successfully assigned demo/crashed to node-2",
        count: 1,
        age: "2m",
        time: 0,
      },
    ];
  });
  await openKind(page, "Pods");
  await row(page, "crashed").click();
  const events = panel(page).locator("table.events");
  await expect(events).toBeVisible();
  // Nothing runs past the panel's edge.
  const fits = await events.evaluate((t) => {
    const scroller = t.parentElement!;
    return { table: t.scrollWidth, box: scroller.clientWidth, scroll: scroller.scrollWidth };
  });
  expect(fits.table).toBeLessThanOrEqual(fits.box);
  expect(fits.scroll).toBeLessThanOrEqual(fits.box);
  const messages = events.getByTestId("event-message");
  const long = messages.first();
  const short = messages.nth(1);
  // The long one is folded, with all of it a click away; the short one is not.
  const more = events.getByRole("button", { name: "Show all" });
  await expect(more).toHaveCount(1);
  await expect(long).toHaveAttribute("title", /no such host$/);
  await expect(short).not.toHaveAttribute("title");
  const folded = (await long.boundingBox())!.height;
  await more.click();
  const less = events.getByRole("button", { name: "Show less" });
  await expect(less).toHaveAttribute("aria-expanded", "true");
  await expect.poll(async () => (await long.boundingBox())!.height).toBeGreaterThan(folded + 10);
  await expect(long).not.toHaveAttribute("title");
  await less.click();
  await expect(events.getByRole("button", { name: "Show all" })).toBeVisible();
  await expect.poll(async () => (await long.boundingBox())!.height).toBeLessThan(folded + 1);
});

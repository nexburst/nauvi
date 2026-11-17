import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";
import type { Fake } from "./helpers";

// #339: the log viewer's exclude box (grep -v), lines of context around
// the matches in filter mode (grep -C), and the header of a download.

const panel = (page: Page) => page.getByTestId("detail-panel");
const logs = (page: Page) => page.getByTestId("dock");
const logLines = (page: Page) => logs(page).getByTestId("log-line");
const search = (page: Page) => logs(page).getByRole("searchbox", { name: /^(Filter|Find in) logs$/ });
const excludeBox = (page: Page) => logs(page).getByRole("searchbox", { name: "Exclude lines" });
const contextSelect = (page: Page) => logs(page).getByRole("combobox", { name: "Context lines" });
const count = (page: Page) => logs(page).getByTestId("log-match-count");
const toggle = (page: Page, title: string) => logs(page).getByTitle(title, { exact: true });
const HIGHLIGHT = "Highlight the matches and keep the other lines, instead of filtering";

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

const LINES = [
  "l1 GET /health 200",
  "l2 start",
  "l3 ERROR db timeout",
  "l4 retry",
  "l5 GET /health 200",
  "l6 idle",
  "l7 idle",
  "l8 idle",
  "l9 ERROR db down",
  "l10 GET /health 200",
];

test("exclude hides matching lines, with or without a filter, in either mode", async ({ page }) => {
  const fake = await openPodLogs(page);
  await fake.emitLogLines(LINES);
  await expect(logLines(page)).toHaveCount(10);

  await excludeBox(page).fill("health");
  await expect(logLines(page)).toHaveCount(7);
  await expect(logLines(page).filter({ hasText: "health" })).toHaveCount(0);

  await search(page).fill("l1");
  // l1 and l10 match the filter, but both are excluded.
  await expect(count(page)).toHaveText("No matches");
  await expect(logLines(page)).toHaveCount(0);

  await search(page).fill("db");
  await expect(logLines(page)).toHaveText(["l3 ERROR db timeout", "l9 ERROR db down"]);

  // Highlight keeps every line that is not excluded.
  await toggle(page, HIGHLIGHT).click();
  await expect(logLines(page)).toHaveCount(7);
  await expect(count(page)).toHaveText("2 matches");

  // New lines are excluded as they arrive.
  await fake.emitLogLines(["l11 GET /health 200", "l12 ERROR db again"]);
  await expect(logLines(page)).toHaveCount(8);
  await expect(count(page)).toHaveText("3 matches");

  // The match case and regex toggles apply to the exclude box too.
  await excludeBox(page).fill("HEALTH");
  await expect(logLines(page)).toHaveCount(8);
  await toggle(page, "Match case").click();
  await expect(logLines(page)).toHaveCount(12);
  await toggle(page, "Match case").click();
  await toggle(page, "Regular expression").click();
  await excludeBox(page).fill("idle|retry");
  await expect(logLines(page)).toHaveCount(8);
  await expect(logLines(page).filter({ hasText: /idle|retry/ })).toHaveCount(0);

  // An invalid exclude regex is shown and keeps the last good one.
  await excludeBox(page).fill("(idle");
  await expect(logs(page).getByTestId("log-exclude-error")).toContainText("Invalid exclude regex");
  await expect(excludeBox(page)).toHaveAttribute("aria-invalid", "true");
  await expect(logLines(page)).toHaveCount(8);
  await excludeBox(page).fill("");
  await expect(logs(page).getByTestId("log-exclude-error")).toHaveCount(0);
  await expect(logLines(page)).toHaveCount(12);
  expect(fake.errors).toEqual([]);
});

test("context lines around matches, with -- between groups that are apart", async ({ page }) => {
  const fake = await openPodLogs(page);
  await fake.emitLogLines(LINES);
  await search(page).fill("ERROR");
  await expect(logLines(page)).toHaveText(["l3 ERROR db timeout", "l9 ERROR db down"]);

  await contextSelect(page).selectOption({ label: "Context ±1" });
  await expect(logLines(page)).toHaveText([
    "l2 start",
    "l3 ERROR db timeout",
    "l4 retry",
    "--",
    "l8 idle",
    "l9 ERROR db down",
    "l10 GET /health 200",
  ]);
  // Context lines are not matches; only the matches are marked and counted.
  await expect(logs(page).locator('[data-testid="log-line"].context')).toHaveCount(4);
  await expect(count(page)).toHaveText("2 matches");
  await expect(logLines(page).locator("mark")).toHaveText(["ERROR", "ERROR"]);

  // Groups that touch or overlap run together, without a separator.
  await contextSelect(page).selectOption({ label: "Context ±2" });
  await expect(logLines(page)).toHaveText([
    "l1 GET /health 200",
    "l2 start",
    "l3 ERROR db timeout",
    "l4 retry",
    "l5 GET /health 200",
    "--",
    "l7 idle",
    "l8 idle",
    "l9 ERROR db down",
    "l10 GET /health 200",
  ]);

  // Excluded lines are gone before the context is taken (grep -v, then -C).
  await excludeBox(page).fill("health");
  await expect(logLines(page)).toHaveText([
    "l2 start",
    "l3 ERROR db timeout",
    "l4 retry",
    "l6 idle",
    "l7 idle",
    "l8 idle",
    "l9 ERROR db down",
  ]);
  await excludeBox(page).fill("");

  // Lines that arrive later: "after" context, and "before" context across batches.
  await contextSelect(page).selectOption({ label: "Context ±1" });
  await expect(logLines(page)).toHaveCount(7);
  await fake.emitLogLines(["l11 ERROR mid"]);
  await expect(logLines(page).last()).toHaveText("l11 ERROR mid");
  await fake.emitLogLines(["l12 after"]);
  await expect(logLines(page).last()).toHaveText("l12 after");
  await fake.emitLogLines(["l13 gone"]);
  await fake.emitLogLines(["l14 before"]);
  await fake.emitLogLines(["l15 ERROR late"]);
  await expect(logLines(page)).toHaveText([
    "l2 start",
    "l3 ERROR db timeout",
    "l4 retry",
    "--",
    "l8 idle",
    "l9 ERROR db down",
    "l10 GET /health 200",
    "l11 ERROR mid",
    "l12 after",
    "--",
    "l14 before",
    "l15 ERROR late",
  ]);

  // n / N go through the matches only.
  await search(page).press("Enter");
  // From the lines in view (the dock may not show them all).
  await expect(count(page)).toHaveText(/^[1-4] of 4$/);
  await expect(logs(page).locator('[data-testid="log-line"].current')).toContainText("ERROR");

  // Highlight shows every line: no context then.
  await toggle(page, HIGHLIGHT).click();
  await expect(contextSelect(page)).toBeDisabled();
  await expect(logLines(page)).toHaveCount(15);
  await expect(logs(page).locator('[data-testid="log-line"].context')).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("a download has a header and, while filtering, holds the lines shown", async ({ page }) => {
  const fake = await openPodLogs(page);
  await fake.emitLogLines(LINES);
  await expect(logLines(page)).toHaveCount(10);
  await search(page).fill("ERROR");
  await contextSelect(page).selectOption({ label: "Context ±1" });
  await excludeBox(page).fill("retry");
  await expect(logLines(page)).toHaveText([
    "l2 start",
    "l3 ERROR db timeout",
    "l5 GET /health 200",
    "--",
    "l8 idle",
    "l9 ERROR db down",
    "l10 GET /health 200",
  ]);

  await logs(page).getByRole("button", { name: "Download" }).click();
  await expect.poll(() => fake.calls("cmdSaveLogs")).toHaveLength(1);
  const content = (await fake.lastCall("cmdSaveLogs")).content as string;
  const [header, body] = content.split("\n#\n");
  expect(header.split("\n")).toEqual([
    "# nauvi logs",
    "# Context:    kind-dev",
    "# Namespace:  demo",
    "# Pod:        web-1",
    "# Container:  app",
    "# Requested:  last 200 lines, all time",
    "# Time range: unknown (no timestamps on the lines)",
    '# Filter:     match "ERROR" (text, ignore case), 1 line of context; exclude "retry"',
    "# Lines:      6 of 10",
    expect.stringMatching(/^# Saved: +\d{4}-\d\d-\d\dT[\d:.]+Z$/),
  ]);
  expect(body).toBe(
    "l2 start\nl3 ERROR db timeout\nl5 GET /health 200\n--\nl8 idle\nl9 ERROR db down\nl10 GET /health 200\n",
  );

  // Without a filter: the whole buffer, and the time range of the lines.
  await search(page).fill("");
  await excludeBox(page).fill("");
  await fake.emitLogLines(["2026-11-16T10:00:00Z first", "2026-11-16T10:05:00.5Z last"]);
  await expect(logLines(page)).toHaveCount(12);
  await logs(page).getByRole("button", { name: "Download" }).click();
  await expect.poll(() => fake.calls("cmdSaveLogs")).toHaveLength(2);
  const second = (await fake.lastCall("cmdSaveLogs")).content as string;
  expect(second).toContain("# Filter:     none\n# Lines:      12\n");
  expect(second).toContain("# Time range: 2026-11-16T10:00:00.000Z to 2026-11-16T10:05:00.500Z\n");
  expect(second.split("\n#\n")[1].split("\n")).toHaveLength(13);

  // Download right after typing (before the search ran): what that search shows.
  await excludeBox(page).fill("health");
  await logs(page).getByRole("button", { name: "Download" }).click();
  await expect.poll(() => fake.calls("cmdSaveLogs")).toHaveLength(3);
  const third = (await fake.lastCall("cmdSaveLogs")).content as string;
  expect(third).toContain('# Filter:     exclude "health" (text, ignore case)\n# Lines:      9 of 12\n');
  expect(third).not.toContain("/health");
  expect(fake.errors).toEqual([]);
});

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";
import type { Fake } from "./helpers";

// #220: the log viewer's search: match case and regex toggles, highlight
// instead of filter with next / previous (Enter, n / N, the arrows), an
// inline error for an invalid regex, a time limit for a regex that
// backtracks without end, and "Jump to time".

// Clock times in "Jump to time" are local: make local UTC, like the lines.
test.use({ timezoneId: "UTC" });

const panel = (page: Page) => page.getByTestId("detail-panel");
const logs = (page: Page) => page.getByTestId("dock");
const logLines = (page: Page) => logs(page).getByTestId("log-line");
const search = (page: Page) => logs(page).getByRole("searchbox");
const count = (page: Page) => logs(page).getByTestId("log-match-count");
const toggle = (page: Page, title: string) => logs(page).getByTitle(title, { exact: true });

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

const LINES = ["GET /health 200", "ERROR db timeout", "GET /api 500 error", "GET /api 503", "all good"];

test("match case and regex narrow the filter; the default is unchanged", async ({ page }) => {
  const fake = await openPodLogs(page);
  await fake.emitLogLines(LINES);
  await expect(logLines(page)).toHaveCount(5);

  // Default: case-insensitive text, filtering.
  await search(page).fill("error");
  await expect(logLines(page)).toHaveText(["ERROR db timeout", "GET /api 500 error"]);
  await expect(count(page)).toHaveText("2 matches");

  await toggle(page, "Match case").click();
  await expect(toggle(page, "Match case")).toHaveAttribute("aria-pressed", "true");
  await expect(logLines(page)).toHaveText(["GET /api 500 error"]);
  await toggle(page, "Match case").click();

  await search(page).fill("5\\d\\d");
  await expect(logLines(page)).toHaveCount(0);
  await toggle(page, "Regular expression").click();
  await expect(logLines(page)).toHaveText(["GET /api 500 error", "GET /api 503"]);
  await expect(logLines(page).locator("mark")).toHaveText(["500", "503"]);

  // New lines are matched as they arrive.
  await fake.emitLogLines(["GET / 502", "GET / 201"]);
  await expect(logLines(page)).toHaveText(["GET /api 500 error", "GET /api 503", "GET / 502"]);
  expect(fake.errors).toEqual([]);
});

test("an invalid regex shows inline and keeps the last good search", async ({ page }) => {
  const fake = await openPodLogs(page);
  await fake.emitLogLines(LINES);
  await toggle(page, "Regular expression").click();
  await search(page).fill("GET /api");
  await expect(logLines(page)).toHaveCount(2);

  await search(page).fill("GET (/api");
  const error = logs(page).getByTestId("log-search-error");
  await expect(error).toContainText("Invalid regex");
  await expect(search(page)).toHaveAttribute("aria-invalid", "true");
  await expect(logLines(page)).toHaveCount(2);

  await search(page).fill("GET (/api)");
  await expect(error).toHaveCount(0);
  await expect(search(page)).not.toHaveAttribute("aria-invalid", "true");
  await expect(logLines(page)).toHaveCount(2);
  expect(fake.errors).toEqual([]);
});

test("highlight mode keeps every line; Enter, n / N and the arrows go through the matches", async ({ page }) => {
  const fake = await openPodLogs(page);
  await fake.emitLogLines(LINES);
  await toggle(page, "Highlight the matches and keep the other lines, instead of filtering").click();
  await expect(search(page)).toHaveAttribute("placeholder", "Find in logs…");
  await search(page).fill("get");
  await expect(logLines(page)).toHaveCount(5);
  await expect(logLines(page).locator("mark")).toHaveText(["GET", "GET", "GET"]);
  await expect(count(page)).toHaveText("3 matches");

  const current = logs(page).locator('[data-testid="log-line"].current');
  await search(page).press("Enter");
  await expect(count(page)).toHaveText("1 of 3");
  await expect(current).toHaveText("GET /health 200");
  await search(page).press("Enter");
  await expect(current).toHaveText("GET /api 500 error");
  await search(page).press("Shift+Enter");
  await expect(current).toHaveText("GET /health 200");

  // n / N in the log output (it takes the focus on a click).
  await logLines(page).nth(4).click();
  await page.keyboard.press("N");
  await expect(count(page)).toHaveText("3 of 3");
  await expect(current).toHaveText("GET /api 503");
  await page.keyboard.press("n");
  await expect(count(page)).toHaveText("1 of 3");

  await logs(page).getByRole("button", { name: "Next match" }).click();
  await expect(count(page)).toHaveText("2 of 3");
  await logs(page).getByRole("button", { name: "Previous match" }).click();
  await expect(count(page)).toHaveText("1 of 3");

  // Back to filtering: only the matches.
  await toggle(page, "Highlight the matches and keep the other lines, instead of filtering").click();
  await expect(logLines(page)).toHaveCount(3);

  await search(page).fill("nothing like it");
  await expect(count(page)).toHaveText("No matches");
  await expect(logs(page).getByRole("button", { name: "Next match" })).toBeDisabled();
  expect(fake.errors).toEqual([]);
});

test("a regex that backtracks without end is stopped and the UI stays usable", async ({ page }) => {
  const fake = await openPodLogs(page);
  await fake.emitLogLines(["a".repeat(40) + "!", "ok line"]);
  await toggle(page, "Regular expression").click();
  await search(page).fill("(a+)+$");
  const error = logs(page).getByTestId("log-search-error");
  await expect(error).toContainText("Regex too slow", { timeout: 10_000 });
  // The search is dropped: every line is back.
  await expect(logLines(page)).toHaveCount(2);
  // The page answers meanwhile and afterwards.
  await search(page).fill("ok");
  await expect(logLines(page)).toHaveText(["ok line"]);
  await expect(error).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("a regex over 50,000 lines does not block the page", async ({ page }) => {
  const fake = await openPodLogs(page);
  const batch = Array.from({ length: 10_000 }, (_, i) => `req ${i} status ${i % 100 === 0 ? 500 : 200}`);
  for (let k = 0; k < 5; k++) await fake.emitLogLines(batch);
  await expect(logs(page).locator(".logs-options")).toContainText("50,000+ lines");
  await toggle(page, "Regular expression").click();
  const t0 = Date.now();
  await search(page).fill("status 5\\d\\d$");
  await expect(count(page)).toHaveText("500 matches");
  console.log(`regex over 50,000 lines: ${Date.now() - t0} ms`);
  expect(fake.errors).toEqual([]);
});

test("Jump to time scrolls to the first line at or after it", async ({ page }) => {
  const fake = await openPodLogs(page);
  const base = Date.UTC(2026, 10, 16, 10, 0, 0);
  const lines = Array.from(
    { length: 600 },
    (_, i) => `${new Date(base + i * 1000).toISOString().replace(".000Z", ".123456789Z")} tick ${i}`,
  );
  await fake.emitLogLines(lines);
  await expect(logs(page).locator(".logs-options")).toContainText("600 lines");

  const jump = logs(page).getByRole("textbox", { name: "Jump to time" });
  await jump.fill("10:05:00");
  await jump.press("Enter");
  const jumped = logs(page).locator('[data-testid="log-line"].jumped');
  await expect(jumped).toHaveText(/ tick 300$/);
  await expect(jumped).toBeInViewport();

  await jump.fill("2026-11-16T10:02:30.5Z");
  await logs(page).getByRole("button", { name: "Go", exact: true }).click();
  await expect(jumped).toHaveText(/ tick 151$/);
  await expect(jumped).toBeInViewport();

  const note = logs(page).getByTestId("log-jump-note");
  await jump.fill("09:00");
  await jump.press("Enter");
  await expect(jumped).toHaveText(/ tick 0$/);
  await expect(note).toContainText("Nothing that early");

  await jump.fill("lunch");
  await jump.press("Enter");
  await expect(note).toContainText("Not a time");
  expect(fake.errors).toEqual([]);
});

test("Jump to time without timestamps says to turn them on", async ({ page }) => {
  const fake = await openPodLogs(page);
  await fake.emitLogLines(LINES);
  const jump = logs(page).getByRole("textbox", { name: "Jump to time" });
  await jump.fill("10:00");
  await jump.press("Enter");
  await expect(logs(page).getByTestId("log-jump-note")).toHaveText("The lines have no time: turn on Timestamps");
  expect(fake.errors).toEqual([]);
});

test("without a current match, n / N start from the lines in view", async ({ page }) => {
  const fake = await openPodLogs(page);
  await fake.emitLogLines(Array.from({ length: 2000 }, (_, i) => `line ${i}${i % 100 === 0 ? " hit" : ""}`));
  await toggle(page, "Highlight the matches and keep the other lines, instead of filtering").click();
  await search(page).fill("hit");
  await expect(count(page)).toHaveText("20 matches");
  // Following, at the bottom: N goes to the newest match, not the oldest
  // (which a busy stream trims away soon).
  await search(page).press("Shift+Enter");
  await expect(count(page)).toHaveText("20 of 20");
  await expect(logs(page).locator('[data-testid="log-line"].current')).toHaveText("line 1900 hit");
  expect(fake.errors).toEqual([]);
});

test("a regex matches the container prefix of merged lines", async ({ page }) => {
  const fake = await openPodLogs(page);
  await logs(page).getByTitle("Container", { exact: true }).selectOption({ label: "All containers" });
  await expect.poll(() => fake.calls("cmdStreamPodAllLogs")).toHaveLength(1);
  await fake.emitTaggedLines([
    { pod: "web-1", container: "app", line: "GET /healthz 200" },
    { pod: "web-1", container: "sidecar", line: "synced config" },
  ]);
  await expect(logLines(page)).toHaveCount(2);
  await toggle(page, "Regular expression").click();
  await search(page).fill("^\\[side");
  await expect(logLines(page)).toHaveText(["[sidecar]synced config"]);
  await expect(logLines(page).locator("mark")).toHaveText(["[side"]);
  expect(fake.errors).toEqual([]);
});

// #272: stepping to a match turns Follow off, so new lines do not scroll
// it away; the match stays in view.
test("stepping to a match turns Follow off and keeps the match in view", async ({ page }) => {
  const fake = await openPodLogs(page);
  await fake.emitLogLines(Array.from({ length: 2000 }, (_, i) => `line ${i}${i % 100 === 0 ? " hit" : ""}`));
  await toggle(page, "Highlight the matches and keep the other lines, instead of filtering").click();
  await search(page).fill("hit");
  await expect(count(page)).toHaveText("20 matches");
  const followBox = logs(page).getByLabel("Follow");
  await expect(followBox).toBeChecked();
  await search(page).press("Shift+Enter");
  await expect(count(page)).toHaveText("20 of 20");
  await expect(followBox).not.toBeChecked();
  const current = logs(page).locator('[data-testid="log-line"].current');
  await expect(current).toHaveText("line 1900 hit");
  // More lines come in: the view stays at the match.
  await fake.emitLogLines(Array.from({ length: 500 }, (_, i) => `more ${i}`));
  await expect(logs(page).locator(".logs-options")).toContainText("2,500 lines");
  await expect(current).toBeInViewport();
  // Follow on again: back to the newest line.
  await followBox.check();
  await expect(logLines(page).filter({ hasText: "more 499" })).toBeInViewport();
  expect(fake.errors).toEqual([]);
});

test("at a match with Follow off, trimming the oldest lines does not move the view", async ({ page }) => {
  const fake = await openPodLogs(page);
  const batch = (from: number) => Array.from({ length: 10_000 }, (_, i) => `line ${from + i}${(from + i) % 1000 === 0 ? " hit" : ""}`);
  for (let k = 0; k < 5; k++) await fake.emitLogLines(batch(k * 10_000));
  // 54,000 shown: just under the trim (55,000).
  await fake.emitLogLines(batch(50_000).slice(0, 4000));
  await toggle(page, "Highlight the matches and keep the other lines, instead of filtering").click();
  await search(page).fill("hit");
  await expect(count(page)).toHaveText("54 matches");
  // The newest match, near the end of the list.
  await search(page).press("Shift+Enter");
  const current = logs(page).locator('[data-testid="log-line"].current');
  await expect(current).toHaveText("line 53000 hit");
  // 2,000 more: 6,000 of the oldest are trimmed above the view and the list
  // gets shorter (the browser clamps the scroll position first).
  await fake.emitLogLines(batch(54_000).slice(0, 2000));
  await expect(count(page)).toHaveText(/^\d+ of 50$/);
  await expect(current).toHaveText("line 53000 hit");
  await expect(current).toBeInViewport();
  expect(fake.errors).toEqual([]);
});

// #272: the worker keeps its own copy of the lines; new lines and a full
// buffer (trimmed at the start) are searched right.
test("a regex search stays right as lines come in and the buffer is trimmed", async ({ page }) => {
  const fake = await openPodLogs(page);
  const batch = (from: number) =>
    Array.from({ length: 10_000 }, (_, i) => `req ${from + i} status ${(from + i) % 100 === 0 ? 500 : 200}`);
  for (let k = 0; k < 5; k++) await fake.emitLogLines(batch(k * 10_000));
  await toggle(page, "Regular expression").click();
  await search(page).fill("status 5\\d\\d$");
  await expect(count(page)).toHaveText("500 matches");
  // New lines are matched as they come (only they go to the worker).
  await fake.emitLogLines(batch(50_000));
  await expect(count(page)).toHaveText("600 matches");
  // 60,000 is over the cap (+10%): the oldest 10,000 were trimmed, here and
  // in the worker. A new search runs over lines 10,000 to 59,999.
  await expect(logs(page).locator(".logs-options")).toContainText("50,000+ lines");
  await search(page).fill("req [15]\\d{4} status 500$");
  await expect(count(page)).toHaveText("200 matches");
  // Following: the newest match is at the bottom, highlighted whole.
  await expect(logLines(page).last()).toHaveText("req 59900 status 500");
  await expect(logLines(page).last().locator("mark")).toHaveText("req 59900 status 500");
  await logs(page).locator('[data-testid="log-output"] .scroller').evaluate((el) => (el.scrollTop = 0));
  await expect(logLines(page).first()).toHaveText("req 10000 status 500");
  expect(fake.errors).toEqual([]);
});

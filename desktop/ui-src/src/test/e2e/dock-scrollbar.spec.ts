import { expect, test } from "@playwright/test";
import { openApp, openKind } from "./helpers";

// Headless Chromium hides scrollbars (they take no room), which would hide
// what this checks: that the dock strip's scrollbar is the styled 6px one.
// `launchOptions` needs its own worker, so this is a file of its own.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("with more tabs than fit, the strip's scrollbar sits below the tabs, not over them", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  const dock = page.getByTestId("dock");
  const tabs = dock.getByRole("tab");
  for (let i = 0; i < 14; i++) await page.keyboard.press("Control+Shift+Backquote");
  await expect(tabs).toHaveCount(14);
  const box = await dock.getByRole("tablist").evaluate((el: HTMLElement) => ({
    overflows: el.scrollWidth > el.clientWidth,
    scrollbar: el.offsetHeight - el.clientHeight,
    vertical: el.offsetWidth - el.clientWidth,
    tabBottom: Math.max(...Array.from(el.querySelectorAll(".tab"), (t) => t.getBoundingClientRect().bottom)),
    clientBottom: el.getBoundingClientRect().top + el.clientHeight,
  }));
  expect(box.overflows).toBe(true);
  // The styled scrollbar takes its own 6px below the tabs. WebKitGTK's
  // default overlay one takes none and covers their lower half (#116).
  // Only a horizontal one: no vertical scrollbar at the strip's end.
  expect(box.scrollbar).toBe(6);
  expect(box.vertical).toBe(0);
  expect(box.tabBottom).toBeLessThanOrEqual(box.clientBottom);

  // A click near the bottom of a tab reaches it; so does one on its ✕.
  const first = tabs.first();
  const r = (await first.boundingBox())!;
  await page.mouse.click(r.x + r.width / 2, r.y + r.height - 3);
  await expect(first).toHaveAttribute("aria-selected", "true");
  const close = dock.getByRole("button", { name: /^Close / }).first();
  const c = (await close.boundingBox())!;
  await page.mouse.click(c.x + c.width / 2, c.y + c.height - 3);
  await expect(tabs).toHaveCount(13);
});

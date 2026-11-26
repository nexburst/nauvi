import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// Every control says what it is (#483): a word on it, or a tooltip and an
// accessible name. And the problem pill leads to the problem pods (#491).

/**
 * The visible buttons of the window that have neither a visible word nor
 * a tooltip (`title`, or the action bar's own `data-tip`) with an accessible
 * name. A full-window scrim (tabindex -1, mouse only) is left out.
 */
function unlabelled(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== "hidden";
    };
    const visibleText = (b: Element) => {
      let out = "";
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        if (!parent || parent.closest("[aria-hidden='true']") || !shown(parent)) continue;
        out += n.textContent ?? "";
      }
      return out.trim();
    };
    const bad: string[] = [];
    for (const b of document.querySelectorAll("button, [role='button'], [role='tab']")) {
      if (!shown(b) || b.getAttribute("tabindex") === "-1") continue;
      const title = b.getAttribute("title") || b.getAttribute("data-tip-title") || (b as HTMLElement).dataset.tip || "";
      const name = (b.getAttribute("aria-label") || b.textContent || title).trim();
      const word = /\p{L}{3,}/u.test(visibleText(b));
      if (name && (word || title)) continue;
      bad.push(b.outerHTML.slice(0, 160));
    }
    return bad;
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
});

test("every button of the Overview, a table and the detail panel has a label or a tooltip", async ({ page }) => {
  await openApp(page);
  await expect(page.getByTestId("watch-dial")).toBeVisible();
  expect(await unlabelled(page), "on the Overview").toEqual([]);

  await page.getByTestId("watch-dial").click();
  await expect(page.getByTestId("watch-panel")).toBeVisible();
  expect(await unlabelled(page), "with the problem pods open").toEqual([]);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("watch-panel")).toHaveCount(0);

  await openKind(page, "Pods");
  await expect(row(page, "web-1")).toBeVisible();
  expect(await unlabelled(page), "on the Pods table").toEqual([]);

  await row(page, "web-1").click();
  await expect(page.getByTestId("detail-panel")).toBeVisible();
  expect(await unlabelled(page), "with the detail panel").toEqual([]);
});

test("the filter's options are labelled toggles, their state plain", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  const box = page.getByTestId("table-filter-box");
  const regex = box.getByRole("button", { name: "Regex (regular expression)" });
  await expect(box.getByRole("button", { name: "Match case" })).toHaveText("AaMatch case");
  await expect(regex).toHaveText(".*Regex");
  await expect(box.getByRole("button", { name: "Star this search" })).toContainText("Star");
  await regex.click();
  await expect(regex).toHaveAttribute("aria-pressed", "true");
  await expect(regex).toHaveAttribute("title", /on/);
  await expect(page.getByRole("searchbox", { name: "Filter" })).toHaveAttribute("placeholder", "Filter (regex)…");
});

test("the detail panel names Logs, Shell and Edit; Delete stands apart", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  const bar = page.getByTestId("detail-panel").getByRole("toolbar", { name: "Actions" });
  for (const name of ["Logs", "Shell", "Edit"]) {
    const word = bar.getByRole("button", { name, exact: true }).locator(".word");
    await expect(word).toBeVisible();
    await expect(word).toHaveText(name);
  }
  // Copy link has only its icon: its name shows on hover.
  await bar.getByRole("button", { name: "Copy link" }).hover();
  await expect(page.getByTestId("action-tip")).toHaveText("Copy link");
  // The destructive group is right of a divider, right of the rest.
  const edit = (await bar.getByRole("button", { name: "Edit", exact: true }).boundingBox())!;
  const evict = (await bar.getByRole("button", { name: "Evict", exact: true }).boundingBox())!;
  expect(evict.x).toBeGreaterThan(edit.x);
});

test("a title shows as the app's tooltip, on hover and on keyboard focus", async ({ page }) => {
  await openApp(page);
  const settings = page.getByRole("button", { name: "Settings" });
  await settings.hover();
  await expect(page.getByTestId("tooltip")).toHaveText(/^Settings \(Ctrl\+,\)$/);
  // The engine's own tooltip would be a second one: the title is set aside meanwhile.
  await expect(settings).not.toHaveAttribute("title");
  await page.mouse.move(640, 500);
  await expect(page.getByTestId("tooltip")).toHaveCount(0);
  await expect(settings).toHaveAttribute("title", /^Settings/);

  await page.getByRole("button", { name: "Help" }).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("tooltip")).toContainText("keyboard shortcuts");
});

test("the problem pill lists the problem pods; one click opens one (#491)", async ({ page }) => {
  await openApp(page);
  const pill = page.getByTestId("watch-dial");
  await expect(pill).toHaveText("2 problem pods");
  await expect(pill).toHaveAttribute("title", "2 pods need a look. Click to see them.");
  await pill.click();
  const problems = page.getByTestId("watch-problem");
  await expect(problems).toHaveCount(2);
  await expect(problems.first()).toContainText("demo/crashed");
  await expect(problems.first()).toContainText("CrashLoopBackOff · 12 restarts");
  await expect(problems.nth(1)).toContainText("Pending for 1h");
  // No streak or insignia on this tab.
  await expect(page.getByTestId("watch-panel")).not.toContainText("streak");

  await problems.first().getByRole("button", { name: "demo/crashed", exact: true }).click();
  await expect(page.getByTestId("watch-panel")).toHaveCount(0);
  await expect(page.getByTestId("detail-panel")).toBeVisible();
  await expect(row(page, "crashed")).toHaveClass(/selected/);
});

test("the footer's timeline is labelled, has a legend and opens the watch log", async ({ page }) => {
  await openApp(page);
  const line = page.getByTestId("wake-line");
  await expect(page.getByTestId("wake-caption")).toHaveText("Problem pods, last 12h");
  await expect(line).toHaveAttribute("title", /teal line: none/);
  await line.click();
  await expect(page.getByTestId("watch-tab-log")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("watch-panel")).toContainText("Watch log");
});

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { namespaceButton, openApp, openKind, row } from "./helpers";

// #176: no text field autocapitalises, autocorrects, spellchecks or
// autofills (macOS WKWebView turned "shell" into "Shell" in the filter).

/** Text fields on the page that miss one of the attributes, as "label: attr=value". */
async function notPlain(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const want: Record<string, string> = {
      autocapitalize: "off",
      autocorrect: "off",
      spellcheck: "false",
      autocomplete: "off",
    };
    const types = ["", "text", "search", "url", "email", "tel", "password", "number"];
    const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input, textarea")].filter(
      (el) => el instanceof HTMLTextAreaElement || types.includes((el.getAttribute("type") ?? "").toLowerCase()),
    );
    const bad: string[] = [];
    for (const el of fields) {
      const name = el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.id || el.className;
      for (const [attr, value] of Object.entries(want)) {
        if (el.getAttribute(attr) !== value) bad.push(`${name}: ${attr}=${el.getAttribute(attr)}`);
      }
    }
    return bad;
  });
}

async function fieldCount(page: Page): Promise<number> {
  return page.locator("input:not([type=checkbox]):not([type=radio]):not([type=range]), textarea").count();
}

test("the filter, the palette and the namespace picker take text as typed", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  const filter = page.getByRole("searchbox", { name: "Filter" });
  await expect(filter).toHaveAttribute("autocapitalize", "off");
  await expect(filter).toHaveAttribute("autocorrect", "off");
  await expect(filter).toHaveAttribute("spellcheck", "false");
  await expect(filter).toHaveAttribute("autocomplete", "off");
  await filter.fill("shell");
  await expect(filter).toHaveValue("shell");
  expect(await notPlain(page)).toEqual([]);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  expect(await notPlain(page)).toEqual([]);
  await page.keyboard.press("Escape");

  await namespaceButton(page).click();
  expect(await fieldCount(page)).toBeGreaterThan(1);
  expect(await notPlain(page)).toEqual([]);
});

test("fields in the detail panel, dialogs and settings are plain too", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(page.getByTestId("detail-panel")).toBeVisible();
  expect(await notPlain(page)).toEqual([]);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings).toBeVisible();
  expect(await fieldCount(page)).toBeGreaterThan(1);
  expect(await notPlain(page)).toEqual([]);
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Cluster catalog" }).click();
  await page.getByRole("button", { name: "More actions for prod", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  await expect(page.getByRole("dialog", { name: "Cluster settings" })).toBeVisible();
  expect(await notPlain(page)).toEqual([]);
});

test("a field added later and a field marked as prose", async ({ page }) => {
  await openApp(page);
  const attrs = await page.evaluate(async () => {
    const plain = document.createElement("input");
    const prose = document.createElement("textarea");
    prose.dataset.prose = "";
    const kept = document.createElement("input");
    kept.setAttribute("autocomplete", "username");
    document.body.append(plain, prose, kept);
    await new Promise((r) => setTimeout(r, 0));
    return [plain, prose, kept].map((el) => [el.getAttribute("autocorrect"), el.getAttribute("autocomplete")]);
  });
  expect(attrs).toEqual([
    ["off", "off"],
    [null, null],
    ["off", "username"],
  ]);
});

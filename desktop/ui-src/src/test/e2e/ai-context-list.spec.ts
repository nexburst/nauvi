import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { ContextMode } from "../../lib/bindings";
import type { FakeCluster } from "../fixtures/cluster";
import { openApp, openKind, row, rows } from "./helpers";

// The AI context list (#608): collect objects from the Overview, the
// tables (menu, Alt+click, selection) and the detail panel, then one Ask
// AI names them all. One list per context, in memory, at most 20.

const dialog = (page: Page) => page.getByTestId("ask-ai-dialog");
const prompt = (page: Page) => dialog(page).getByTestId("ask-ai-prompt");
const menu = (page: Page) => page.getByRole("menu");
const count = (page: Page) => page.getByTestId("ai-context-count");
const panel = (page: Page) => page.getByTestId("ai-context-panel");
const contextSelect = (page: Page) => page.getByRole("combobox", { name: "Cluster context" });

const withClaude = (cluster: FakeCluster) => {
  cluster.askAi = { found: ["claude"], nauvi: true, customError: "" };
};

const setTheme = (page: Page, theme: "light" | "dark") =>
  page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);

async function addFromMenu(page: Page, name: string) {
  await row(page, name).click({ button: "right" });
  await menu(page).getByRole("menuitem", { name: "Add to Ask AI" }).click();
}

test("collect a Deployment from the Overview, a Pod from its menu and a Node by Alt+click; one Ask AI names all three", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const fake = await openApp(page, withClaude);
  await expect(count(page)).toHaveCount(0);

  const group = page.getByRole("region", { name: "Problem groups" }).locator(".problem").first();
  await group.getByTestId("add-to-ask-ai").click();
  await expect(count(page)).toHaveText("1");
  // Once in, it is refused, with the reason.
  await expect(group.getByTestId("add-to-ask-ai")).toHaveAttribute("aria-disabled", "true");
  await expect(group.getByTestId("add-to-ask-ai")).toHaveAttribute("title", "Already in the Ask AI list.");

  await openKind(page, "Pods");
  await addFromMenu(page, "web-1");
  await expect(count(page)).toHaveText("2");
  // The menu's entry sits next to Ask AI about this…, greyed once in.
  await row(page, "web-1").click({ button: "right" });
  const items = await menu(page).getByRole("menuitem").allTextContents();
  expect(items[items.indexOf("Ask AI about this…") + 1]).toBe("Add to Ask AI");
  await expect(menu(page).getByTestId("menu-reason")).toHaveText("Already in the Ask AI list.");
  await page.keyboard.press("Escape");

  await openKind(page, "Nodes");
  await row(page, "node-1").getByRole("gridcell", { name: "node-1", exact: true }).click({ modifiers: ["Alt"] });
  await expect(count(page)).toHaveText("3");
  // Alt+click adds, it does not open the panel.
  await expect(page.getByTestId("detail-panel")).toHaveCount(0);

  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await page.screenshot({ path: test.info().outputPath(`header-count-${theme}.png`), clip: { x: 0, y: 0, width: 1280, height: 48 } });
  }

  await count(page).click();
  await expect(panel(page).getByTestId("ai-context-item")).toHaveCount(3);
  await panel(page).screenshot({ path: test.info().outputPath("list.png") });
  await panel(page).getByTestId("ai-context-ask").click();
  await expect(dialog(page)).toContainText("Ask AI about 3 objects");
  const text = await prompt(page).inputValue();
  const lines = text.split("\n");
  expect(lines[0]).toBe("Look at these objects in context kind-dev and tell me how they relate and what is wrong:");
  expect(lines[1]).toMatch(/^- \S+ demo\/\S+ \(\w+/);
  expect(lines[2]).toBe("- Pod demo/web-1");
  expect(lines[3]).toBe("- Node node-1");
  await dialog(page).screenshot({ path: test.info().outputPath("dialog-3.png") });

  // Cancel keeps the list.
  await dialog(page).getByRole("button", { name: "Cancel" }).click();
  await expect(count(page)).toHaveText("3");
  // Starting empties it.
  await count(page).click();
  await panel(page).getByTestId("ai-context-ask").click();
  await dialog(page).getByTestId("ask-ai-start").click();
  await expect.poll(() => fake.calls("cmdAskAiStart")).toHaveLength(1);
  expect(await fake.lastCall("cmdAskAiStart")).toMatchObject({ prompt: text });
  await expect(count(page)).toHaveCount(0);
  await expect(page.getByTestId("dock").getByRole("tab")).toHaveText(["AI: 3 objects"]);
  expect(fake.errors).toEqual([]);
});

test("Ask AI about these 4: the selected rows, in one dialog", async ({ page }) => {
  const fake = await openApp(page, withClaude);
  await openKind(page, "Pods");
  await expect(rows(page).nth(3)).toBeVisible();
  for (let i = 0; i < 4; i++) await rows(page).nth(i).getByRole("checkbox").click();
  const ask = page.getByTestId("bulk-ask-ai");
  await expect(ask).toHaveText("Ask AI about these 4");
  await page.getByRole("toolbar", { name: "Selection" }).screenshot({ path: test.info().outputPath("bulk.png") });
  await ask.click();
  await expect(dialog(page)).toContainText("Ask AI about 4 objects");
  const lines = (await prompt(page).inputValue()).split("\n");
  expect(lines.slice(1, 5).every((l) => l.startsWith("- Pod "))).toBe(true);
  // Not the list: it stays empty, and starting leaves it so.
  await dialog(page).getByTestId("ask-ai-start").click();
  await expect.poll(() => fake.calls("cmdAskAiStart")).toHaveLength(1);
  await expect(count(page)).toHaveCount(0);
});

test("one list per context; entries removable; the 21st refused with the reason", async ({ page }) => {
  await openApp(page, withClaude);
  await openKind(page, "Pods");
  await addFromMenu(page, "web-1");
  await expect(count(page)).toHaveText("1");

  await contextSelect(page).selectOption("prod");
  await expect(contextSelect(page)).toHaveValue("prod");
  await expect(count(page)).toHaveCount(0);
  await openKind(page, "Pods");
  await addFromMenu(page, "web-2");
  await expect(count(page)).toHaveText("1");
  await count(page).click();
  await expect(panel(page).getByTestId("ai-context-item")).toHaveText([/Pod demo\/web-2/]);
  await page.keyboard.press("Escape");

  await contextSelect(page).selectOption("kind-dev");
  await expect(contextSelect(page)).toHaveValue("kind-dev");
  await count(page).click();
  await expect(panel(page).getByTestId("ai-context-item")).toHaveText([/Pod demo\/web-1/]);
  await panel(page).getByTestId("ai-context-remove").click();
  await expect(count(page)).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);

  // Fill it to 20 from the store, then the 21st.
  await page.evaluate(async () => {
    const m = await import("/src/lib/stores/aiContext.svelte.ts");
    for (let i = 0; i < 20; i++) m.addToAiContext({ namespace: "", kind: "Node", name: `n-${i}` });
  });
  await expect(count(page)).toHaveText("20");
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Add to Ask AI" })).toBeDisabled();
  await expect(menu(page).getByTestId("menu-reason")).toHaveText(
    "The list holds 20 objects. Remove one to add another.",
  );
  await page.keyboard.press("Escape");
  await row(page, "web-1").click();
  const add = page.getByTestId("detail-panel").getByRole("button", { name: "Add to Ask AI" });
  await expect(add).toHaveAttribute("aria-disabled", "true");
});

test("the count pulses once per change, not under reduced motion; the key strip hints Alt+click", async ({ page }) => {
  await openApp(page, withClaude);
  await openKind(page, "Pods");
  await addFromMenu(page, "web-1");
  // The tests run with reduced motion: no animation.
  await expect(count(page).locator(".badge")).toHaveCSS("animation-name", "none");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await addFromMenu(page, "web-2");
  await expect(count(page)).toHaveText("2");
  await expect(count(page).locator(".badge")).toHaveCSS("animation-duration", "0.18s");
  await expect(count(page).locator(".badge")).toHaveCSS("min-width", "18px");
  await row(page, "web-1").click();
  await expect(page.getByTestId("row-keys")).toContainText(/(Alt\+|⌥\+)clickadd to Ask AI/);
});

for (const width of [1024, 1280]) {
  for (const theme of ["dark", "light"] as const) {
    test(`at ${width} px (${theme}) the header with a count does not wrap; Go to keeps its floor`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: theme });
      await openApp(page, withClaude);
      await openKind(page, "Pods");
      await addFromMenu(page, "web-1");
      await expect(count(page)).toHaveText("1");
      const header = page.getByTestId("cluster-band");
      expect(await header.evaluate((h) => h.scrollWidth <= h.clientWidth + 1)).toBe(true);
      expect(await header.evaluate((h) => h.getBoundingClientRect().height)).toBeLessThanOrEqual(41);
      const goto = await page.getByTestId("rail-goto").evaluate((el) => el.getBoundingClientRect().width);
      expect(goto).toBeGreaterThanOrEqual(width >= 1180 ? 280 : 120);
      for (const name of ["Settings", "Open in new window"]) {
        const free = await page.getByRole("button", { name, exact: true }).evaluate((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return r.right <= window.innerWidth && !!hit && el.contains(hit);
        });
        expect(free, name).toBe(true);
      }
      await page.screenshot({
        path: test.info().outputPath(`header-${width}-${theme}.png`),
        clip: { x: 0, y: 0, width, height: 48 },
      });
    });
  }
}

/** The page with an AI CLI and the context in `mode`. */
async function openWithMode(page: Page, mode: ContextMode) {
  await page.addInitScript(`window.__mode = ${JSON.stringify(mode)};`);
  return openApp(page, (cluster) => {
    cluster.askAi = { found: ["claude"], nauvi: true, customError: "" };
    cluster.settings.contexts["kind-dev"] = {
      view: "",
      namespaces: [],
      typed_namespaces: [],
      prometheus: "",
      display_name: "",
      color: "",
      default_namespace: "",
      shell_cwd: "",
      last_used: 0,
      hide_metrics: false,
      mode: (window as unknown as { __mode: ContextMode }).__mode,
      mode_source: { file: "", given: "", context: "" },
    };
  });
}

test("hidden without an AI CLI and on a read-only context", async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole("region", { name: "Problem groups" }).locator(".problem").first()).toBeVisible();
  await expect(page.getByTestId("add-to-ask-ai")).toHaveCount(0);
  await openKind(page, "Pods");
  await rows(page).first().getByRole("checkbox").click();
  await expect(page.getByTestId("bulk-ask-ai")).toHaveCount(0);
  await row(page, "web-1").click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Add to Ask AI" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("row-keys")).not.toContainText("Ask AI");

  const other = await page.context().newPage();
  await openWithMode(other, "readOnly");
  await expect(other.getByRole("region", { name: "Problem groups" }).locator(".problem").first()).toBeVisible();
  await expect(other.getByTestId("add-to-ask-ai")).toHaveCount(0);
  await openKind(other, "Pods");
  await row(other, "web-1").getByRole("gridcell", { name: "web-1", exact: true }).click({ modifiers: ["Alt"] });
  await expect(other.getByTestId("ai-context-count")).toHaveCount(0);
  await rows(other).first().getByRole("checkbox").click();
  await expect(other.getByTestId("bulk-ask-ai")).toHaveCount(0);
  await other.close();
});

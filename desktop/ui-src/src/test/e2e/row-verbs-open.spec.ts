import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

async function openYaml(page: Page, kindLabel: string, name: string) {
  const fake = await openApp(page);
  await openKind(page, kindLabel);
  await row(page, name).click();
  await page.locator("aside").getByRole("tab", { name: "YAML" }).click();
  return fake;
}

const DEPLOYMENT = { group: "apps", version: "v1", kind: "Deployment", plural: "deployments", namespaced: true };

/** The CodeMirror editor (its content element is the textbox), once loaded. */
async function editorOf(page: Page, kind: string): Promise<Locator> {
  await expect(page.locator("aside .code-editor")).toHaveAttribute("data-ready", "true");
  return page.getByRole("textbox", { name: `${kind} YAML`, exact: true });
}

/** Type at the end of the document, as raw text (no auto-indent). */
test("E on the object already open shows its YAML without rebuilding the editor", async ({ page }) => {
  await openYaml(page, "Secrets", "db-creds");
  const editor = await editorOf(page, "Secret");
  await expect(editor).toContainText("password: <hidden>");
  await page.evaluate(() => { (document.querySelector('[data-testid="yaml-editor"]') as any).__orig = true; });
  await page.locator(".cm-line", { hasText: "password:" }).click();
  for (const k of ["End", "t", "y", "p", "e", "d"]) await page.keyboard.press(k);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => !!(document.querySelector('[data-testid="yaml-editor"]') as any)?.__orig)).toBe(true);
  // From the Overview tab, E goes to the YAML tab.
  await page.locator("aside").getByRole("tab", { name: "Overview" }).click();
  await page.getByRole("grid").focus();
  await page.keyboard.press("e");
  await expect(page.locator("aside").getByRole("tab", { name: "YAML" })).toHaveAttribute("aria-selected", "true");
});

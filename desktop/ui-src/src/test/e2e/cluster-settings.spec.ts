import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { namespaceButton, openApp } from "./helpers";

// Per-cluster settings (#78): display name, colour, pin, default and
// accessible namespaces, Prometheus and the local shell's folder, saved per
// context id.

const dialog = (page: Page) => page.getByRole("dialog", { name: "Cluster settings" });
const contextSelect = (page: Page) => page.getByRole("combobox", { name: "Cluster context" });
const saved = (page: Page, id: string) =>
  page.evaluate((ctx) => window.__fake.cluster.settings.contexts[ctx], id);

async function openSettingsFor(page: Page, id: string) {
  await page.getByRole("button", { name: "Cluster catalog" }).click();
  await page.getByRole("button", { name: `More actions for ${id}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  await expect(dialog(page)).toBeVisible();
}

test("the settings page saves each field for its cluster", async ({ page }) => {
  const fake = await openApp(page);
  await openSettingsFor(page, "prod");
  await expect(dialog(page).getByTestId("cluster-about")).toContainText("Context prod");

  await dialog(page).getByRole("textbox", { name: "Display name" }).fill("Production");
  await dialog(page).getByRole("textbox", { name: "Display name" }).press("Tab");
  await dialog(page).getByRole("radio", { name: "Colour #ef4444" }).click();
  await expect(dialog(page).getByRole("radio", { name: "Colour #ef4444" })).toHaveAttribute("aria-checked", "true");

  const defaultNs = dialog(page).getByRole("textbox", { name: "Default namespace" });
  await defaultNs.fill("Not_Valid");
  await defaultNs.press("Tab");
  await expect(dialog(page)).toContainText("Not_Valid is not a valid namespace name");
  await defaultNs.fill("demo");
  await defaultNs.press("Tab");

  await dialog(page).getByRole("textbox", { name: "Accessible namespaces" }).fill("team-a, team-b");
  await dialog(page).getByRole("textbox", { name: "Accessible namespaces" }).press("Tab");
  await dialog(page).getByRole("textbox", { name: "Prometheus Service" }).fill("obs/prom:9090");
  await dialog(page).getByRole("textbox", { name: "Prometheus Service" }).press("Tab");
  await dialog(page).getByRole("textbox", { name: "Working directory" }).fill("~/src/prod");
  await dialog(page).getByRole("textbox", { name: "Working directory" }).press("Tab");
  await dialog(page).getByRole("checkbox", { name: /Pinned/ }).check();

  await expect.poll(() => saved(page, "prod")).toMatchObject({
    display_name: "Production",
    color: "#ef4444",
    default_namespace: "demo",
    typed_namespaces: ["team-a", "team-b"],
    prometheus: "obs/prom:9090",
    shell_cwd: "~/src/prod",
  });
  expect(await page.evaluate(() => window.__fake.cluster.settings.favourites)).toEqual(["prod"]);
  // Nothing of it leaked into the current context's entry.
  expect((await saved(page, "kind-dev"))?.display_name ?? "").toBe("");

  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  // The display name is what the catalog and the selector show.
  await expect(page.locator('[data-testid="catalog-row"][data-context="prod"]').getByTestId("catalog-name")).toHaveText(
    "Production",
  );
  await expect(contextSelect(page).locator('optgroup[label="Pinned"] option')).toHaveText(["Production"]);
  expect(fake.errors).toEqual([]);
});

test("a cluster opens in its default namespace and shows its colour", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.settings.contexts["prod"] = {
      view: "",
      namespaces: [],
      typed_namespaces: [],
      prometheus: "",
      display_name: "Production",
      color: "#22c55e",
      default_namespace: "demo",
      shell_cwd: "",
      last_used: 0,
      hide_metrics: false,
      mode: "normal",
    };
  });
  await expect(page.getByTestId("context-color")).toHaveCount(0);
  await contextSelect(page).selectOption("prod");
  await expect(contextSelect(page)).toHaveValue("prod");
  await expect(page.getByTestId("context-color")).toHaveCSS("background-color", "rgb(34, 197, 94)");
  await page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true }).click();
  await expect(namespaceButton(page)).toHaveText("demo");
  // Connecting records the last use, shown in the catalog.
  await expect.poll(async () => (await saved(page, "prod"))?.last_used ?? 0).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Cluster catalog" }).click();
  await expect(page.locator('[data-testid="catalog-row"][data-context="prod"]')).toContainText("just now");
});

test("cluster settings for this cluster are in the palette", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("cluster settings");
  await page.keyboard.press("Enter");
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByTestId("cluster-about")).toContainText("Context kind-dev");
  await dialog(page).getByRole("button", { name: "Close" }).click();
  await expect(dialog(page)).toHaveCount(0);
});

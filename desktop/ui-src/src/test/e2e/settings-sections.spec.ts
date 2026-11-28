import { expect, test } from "@playwright/test";
import { openApp } from "./helpers";

// Settings as the app opens it: one section at a time, a list on the left
// and a search. The other specs drive "All settings" (see src/test/main.ts).
test("Settings shows one section at a time; the search finds a setting in any of them", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("nauvi.settings.section", "appearance"));
  await openApp(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const tab = (name: string) => dialog.getByRole("tab", { name, exact: true });

  await expect(tab("Appearance")).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("radio", { name: "Light" })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Show timestamps" })).toBeHidden();

  await tab("Editor and logs").click();
  await expect(dialog.getByRole("checkbox", { name: "Show timestamps" })).toBeVisible();
  await expect(dialog.getByRole("radio", { name: "Light" })).toBeHidden();

  // The search shows every section with the text, whichever was picked.
  await dialog.getByRole("searchbox", { name: "Search settings" }).fill("prometheus");
  await expect(dialog.getByLabel("Prometheus Service")).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Show timestamps" })).toBeHidden();
  await dialog.getByRole("searchbox", { name: "Search settings" }).fill("no such setting");
  await expect(dialog.getByText('No setting matches "no such setting".')).toBeVisible();

  // Picking a section clears the search; the section is remembered.
  await tab("Metrics").click();
  await expect(dialog.getByRole("searchbox", { name: "Search settings" })).toHaveValue("");
  await expect(dialog.getByLabel("Prometheus Service")).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(tab("Metrics")).toHaveAttribute("aria-selected", "true");

  await tab("All settings").click();
  await expect(dialog.getByRole("radio", { name: "Light" })).toBeVisible();
  await expect(dialog.getByRole("checkbox", { name: "Show timestamps" })).toBeVisible();
});

test("on a wide window the Overview puts the namespaces beside the problems", async ({ page }) => {
  await openApp(page, undefined, { waitForKinds: false });
  const problems = page.getByRole("region", { name: "Problem groups" });
  const namespaces = page.getByRole("region", { name: "Pods by namespace" });
  await expect(namespaces.getByRole("table")).toBeVisible();
  const [a, b] = [await problems.boundingBox(), await namespaces.boundingBox()];
  expect(b!.x).toBeGreaterThan(a!.x + a!.width - 1);

  // Narrow: one column again.
  await page.setViewportSize({ width: 900, height: 800 });
  const [c, d] = [await problems.boundingBox(), await namespaces.boundingBox()];
  expect(d!.y).toBeGreaterThan(c!.y + c!.height - 1);
});

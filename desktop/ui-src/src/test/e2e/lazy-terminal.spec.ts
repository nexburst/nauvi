import { expect, test } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// xterm is loaded with the first terminal tab, not with the app (#353).
test("xterm loads only when the first terminal opens", async ({ page }) => {
  const xterm: string[] = [];
  page.on("request", (r) => {
    if (r.url().includes("xterm")) xterm.push(r.url());
  });
  await openApp(page);
  await openKind(page, "Pods");
  await expect(row(page, "web-1")).toBeVisible();
  expect(xterm).toEqual([]);

  await row(page, "web-1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Attach", exact: true }).click();
  await expect(page.getByTestId("dock").getByTestId("terminal").locator(".xterm-screen")).toBeVisible();
  expect(xterm.length).toBeGreaterThan(0);
});

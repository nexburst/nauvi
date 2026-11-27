import { expect, test } from "@playwright/test";
import { column, openApp, openKind, row, rows } from "./helpers";

// What the best Kubernetes clients share (docs/ux-standard.md): verbs on
// the focused row, a one-press "only what needs attention", an inverse filter.

test("L, S and E act on the focused row; the strip under the table says so", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await expect(row(page, "crashed")).toBeVisible();
  const dock = page.getByTestId("dock");

  await page.getByRole("grid").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("row-keys")).toContainText("logs");
  await expect(page.getByTestId("row-keys")).toContainText("shell");

  await page.keyboard.press("l");
  await expect(dock.getByRole("tab", { name: "Logs: crashed" })).toBeVisible();

  await page.getByRole("grid").focus();
  await page.keyboard.press("s");
  await expect(dock.getByRole("tab", { name: "Shell: crashed" })).toBeVisible();
  // The new terminal takes the keyboard once it is up: wait for it first.
  await expect(dock.getByTestId("terminal")).toBeVisible();

  // E opens the object on its YAML editor.
  await page.getByRole("grid").focus();
  await page.keyboard.press("e");
  await expect(page.getByTestId("detail-panel")).toContainText("crashed");
  await expect(page.getByTestId("detail-panel").locator(".cm-content")).toBeFocused();
});

test("E on a kind with tabs opens its YAML tab; S scales a workload, kinds without either say so", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Services");
  await page.getByRole("grid").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("s");
  await expect(page.getByRole("status")).toContainText("Services have no shell.");

  await openKind(page, "Deployments");
  await expect(row(page, "web")).toBeVisible();
  await page.getByRole("grid").focus();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByTestId("row-keys")).not.toContainText("shell");
  // As in k9s (#575): `s` on a scalable workload opens Scale.
  await page.keyboard.press("s");
  await expect(page.getByTestId("action-dialog")).toHaveAccessibleName("Scale Deployment");
  await expect(page.getByTestId("action-replicas")).toBeFocused();
  await page.keyboard.press("Escape");

  await page.getByRole("grid").focus();
  await page.keyboard.press("e");
  await expect(page.locator("aside").getByRole("tab", { name: "YAML" })).toHaveAttribute("aria-selected", "true");
});

test("Shift+R asks before restarting the focused workload", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Deployments");
  await expect(row(page, "web")).toBeVisible();
  await page.getByRole("grid").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Shift+R");
  await expect(page.getByTestId("action-dialog")).toBeVisible();
  await expect(page.getByTestId("action-dialog")).toContainText("on kind-dev");
  await page.keyboard.press("Escape");
});

test("Z keeps only the rows that need attention; a leading ! inverts the filter", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await expect(rows(page)).toHaveCount(5);

  await page.getByRole("grid").focus();
  await page.keyboard.press("z");
  expect((await column(page, "Name")).sort()).toEqual(["crashed", "db-0"]);
  await expect(page.getByTestId("problems-only")).toHaveAttribute("aria-pressed", "true");
  await page.getByTestId("problems-only").click();
  await expect(rows(page)).toHaveCount(5);

  await page.locator("#table-filter").fill("!web");
  expect((await column(page, "Name")).sort()).toEqual(["coredns-1", "crashed", "db-0"]);
  await page.locator("#table-filter").fill("!");
  await expect(rows(page)).toHaveCount(5);
});

test("A copies a prompt about the focused row for the user's own agent", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page);
  await openKind(page, "Pods");
  await expect(row(page, "crashed")).toBeVisible();
  await page.getByRole("grid").focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("a");
  await expect(page.getByRole("status")).toContainText("Copied a prompt about crashed");
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("Context (cluster): kind-dev");
  expect(text).toContain("Object: Pod demo/crashed");
  expect(text).toContain("CrashLoopBackOff, 12 restarts");
  expect(text).toContain("Do not change anything in the cluster.");
});

test("Settings shows the nauvi mcp entry for each agent, for this cluster, read-only", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const agents = page.getByTestId("agent-settings");
  await expect(agents).toContainText("stores no key");
  await expect(agents.getByTestId("mcp-entry").first()).toHaveText("claude mcp add nauvi -- nauvi --context kind-dev mcp");
  await expect(agents.getByTestId("mcp-entry")).toHaveCount(4);
  for (const text of await agents.getByTestId("mcp-entry").allTextContents()) expect(text).not.toContain("allow-writes");
});

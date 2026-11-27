import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, toggleNamespaces } from "./helpers";
import type { Fake } from "./helpers";
import type { FakeCluster } from "../fixtures/cluster";

// Image security (#534, ADR 0011): off by default, per cluster, and never
// asked for while off; one row per image with a verdict, the findings of
// one in the side panel, and the empty states told apart.

const view = (page: Page) => page.getByTestId("image-security");
const imageRows = (page: Page) => view(page).getByTestId("image-row");
const imageRow = (page: Page, image: string) => view(page).locator(`[data-testid="image-row"][data-key^="${image}@"]`);
const panel = (page: Page) => page.getByTestId("image-findings");
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

// Init functions run in the page as source text: no captured variables.
const turnOn = (cluster: FakeCluster) => {
  cluster.settings.image_security = { ...cluster.settings.image_security, enabled: true };
};

async function goToImageSecurity(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await palette(page).getByRole("combobox").fill("image security");
  await palette(page).getByRole("option", { name: /Go to Image security/ }).click();
  await expect(view(page)).toBeVisible();
}

async function calls(fake: Fake) {
  return (await fake.calls("cmdImageSecuritySummary")).length + (await fake.calls("cmdImageSecurityImage")).length;
}

test("off by default: no command of the module is invoked, and the view says how to turn it on", async ({ page }) => {
  const fake = await openApp(page);
  // Not in the sidebar while off.
  await expect(page.getByRole("navigation").getByRole("button", { name: "Image security" })).toHaveCount(0);
  await goToImageSecurity(page);
  await expect(view(page).getByTestId("empty-state")).toHaveAttribute("data-reason", "off");
  await expect(view(page)).toContainText("Image security is off for this cluster");
  // Switching namespaces and refreshing ask nothing either.
  await toggleNamespaces(page, "demo");
  await page.getByRole("button", { name: "Refresh" }).first().click();
  await page.waitForTimeout(300);
  expect(await calls(fake)).toBe(0);
  expect((await fake.calls("cmdGetSettings")).length).toBeGreaterThan(0);

  // Turned on for this cluster only: it reads, and the sidebar has it.
  await view(page).getByTestId("image-security-turn-on").click();
  await expect(imageRows(page).first()).toBeVisible();
  const saved = await page.evaluate(() => window.__fake.cluster.settings.contexts["kind-dev"]?.image_security);
  expect(saved).toBe("on");
  expect(await page.evaluate(() => window.__fake.cluster.settings.image_security.enabled)).toBe(false);
  await expect(page.getByRole("navigation").getByRole("button", { name: "Image security" })).toBeVisible();
});

test("a cluster set to off stays off although the app has it on", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings.image_security = { ...cluster.settings.image_security, enabled: true };
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
      mode: "normal",
      mode_source: { file: "", given: "", context: "" },
      image_security: "off",
    };
  });
  await goToImageSecurity(page);
  await expect(view(page)).toContainText("Image security is off for this cluster");
  await page.waitForTimeout(300);
  expect(await calls(fake)).toBe(0);
});

test("one row per image with a verdict; the panel says what to do", async ({ page }) => {
  const fake = await openApp(page, turnOn);
  await page.getByRole("navigation").getByRole("button", { name: "Image security" }).click();
  await expect(imageRows(page)).toHaveCount(6);
  await expect(view(page).getByTestId("image-security-headline")).toHaveText("2 images have fixes waiting");
  await expect(imageRow(page, "nginx:1.27")).toContainText("2 critical and 5 high. 6 of 7 have a fix.");
  await expect(imageRow(page, "nginx:1.27")).toHaveAttribute("data-tone", "critical");
  await expect(imageRow(page, "nginx:1.27")).toContainText("Trivy 0.69.3 through Trivy Operator, 2 days ago");
  await expect(imageRow(page, "redis:7.2")).toHaveAttribute("data-tone", "high");
  await expect(imageRow(page, "busybox:1.36")).toContainText("No known vulnerabilities.");
  await expect(imageRow(page, "ghcr.io/team-a/worker:3")).toContainText("Not scanned yet.");
  await expect(imageRow(page, "postgres:15")).toContainText("old scan");
  await expect(page.locator("footer")).toContainText("6 of 6 images");
  // One listing, for all namespaces.
  expect((await fake.calls("cmdImageSecuritySummary")).map((c) => c.namespaces)).toEqual([[]]);

  await imageRow(page, "nginx:1.27").click();
  await expect(panel(page).getByTestId("findings-verdict")).toHaveText("2 critical and 5 high. 6 of 7 have a fix.");
  await expect(panel(page).getByTestId("findings-fixes")).toContainText(
    "Updating openssl to 3.0.15-1 fixes 4 (2 critical).",
  );
  await expect(panel(page).getByTestId("findings-fixes")).toContainText("Updating curl to 7.88.1-10+deb12u8 fixes 2 high.");
  const noFix = panel(page).getByTestId("findings-nofix");
  await expect(noFix).toContainText("No fix yet (1): nothing to do now");
  await expect(noFix.getByText("libc6 2.36-9")).toBeHidden();
  await noFix.locator("summary").click();
  await expect(noFix.getByText("libc6 2.36-9")).toBeVisible();
  await expect(panel(page).getByTestId("findings-source")).toContainText("Trivy 0.69.3 through Trivy Operator");
  expect((await fake.lastCall("cmdImageSecurityImage")).image).toBe("nginx:1.27");
  await panel(page).getByRole("button", { name: "Close details" }).click();
  await expect(panel(page)).toHaveCount(0);

  // The filter searches images and workloads.
  await page.getByLabel("Filter").fill("cache");
  await expect(imageRows(page)).toHaveCount(1);
  await page.getByLabel("Filter").fill("");
});

test("the view follows the namespace picker, and Refresh reads the reports again", async ({ page }) => {
  const fake = await openApp(page, turnOn);
  await goToImageSecurity(page);
  await expect(imageRows(page)).toHaveCount(6);
  await toggleNamespaces(page, "demo");
  await expect(imageRows(page)).toHaveCount(3);
  const last = await fake.lastCall("cmdImageSecuritySummary");
  expect(last.namespaces).toEqual(["demo"]);
  expect(last.refresh).toBe(false);
  await page.getByRole("button", { name: "Refresh" }).first().click();
  await expect.poll(async () => (await fake.lastCall("cmdImageSecuritySummary")).refresh).toBe(true);
});

test("settings: severity, only fixable and left-out namespaces change what rows say", async ({ page }) => {
  await openApp(page, turnOn);
  await goToImageSecurity(page);
  await expect(imageRows(page)).toHaveCount(6);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const section = dialog.getByTestId("image-security-settings");
  await expect(section.getByRole("checkbox", { name: "Show image vulnerabilities" })).toBeChecked();
  await section.getByRole("combobox", { name: "Least severity to count" }).selectOption("critical");
  await section.getByRole("checkbox", { name: "Only vulnerabilities with a fix" }).check();
  await section.getByRole("textbox", { name: "Namespaces to leave out" }).fill("team-a");
  await section.getByRole("textbox", { name: "Namespaces to leave out" }).press("Tab");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(imageRows(page)).toHaveCount(3);
  await expect(imageRow(page, "nginx:1.27")).toContainText("2 critical. Each has a fix.");
  await expect(imageRow(page, "redis:7.2")).toContainText("No critical vulnerabilities with a fix.");
  const saved = await page.evaluate(() => window.__fake.cluster.settings.image_security);
  expect(saved).toMatchObject({ min_severity: "critical", only_fixable: true, excluded_namespaces: ["team-a"] });
});

test("the empty states look different: no operator, not scanned, not allowed", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings.image_security = { ...cluster.settings.image_security, enabled: true };
    cluster.imageSecurity = { state: "no_operator", images: [], details: {}, forbidden: [], notes: [] };
  });
  await goToImageSecurity(page);
  const state = view(page).getByTestId("image-security-state");
  await expect(state).toHaveAttribute("data-state", "no_operator");
  await expect(state).toContainText("This cluster has no Trivy Operator reports");

  await page.evaluate(() => {
    window.__fake.cluster.imageSecurity!.state = "no_reports";
  });
  await page.getByRole("button", { name: "Refresh" }).first().click();
  await expect(state).toHaveAttribute("data-state", "no_reports");
  await expect(state).toContainText("Not scanned yet");

  await page.evaluate(() => {
    const d = window.__fake.cluster.imageSecurity!;
    d.state = "ok";
    d.forbidden = ["demo"];
  });
  await toggleNamespaces(page, "demo");
  await expect(state).toHaveAttribute("data-state", "forbidden");
  await expect(state).toContainText("You are not allowed to list vulnerabilityreports in namespace demo");

  // An error is not an empty state.
  await fake.failNext("cmdImageSecuritySummary", "cannot read VulnerabilityReports: connection refused");
  await page.getByRole("button", { name: "Refresh" }).first().click();
  await expect(view(page)).toContainText("Could not read the image scans");
  await expect(view(page)).toContainText("connection refused");
});

test("the per-cluster setting is in the cluster settings", async ({ page }) => {
  await openApp(page);
  await page.getByRole("button", { name: "Cluster catalog" }).click();
  await page.getByRole("button", { name: "More actions for kind-dev", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  const dialog = page.getByRole("dialog", { name: "Cluster settings" });
  const select = dialog.getByRole("combobox", { name: "Image security for this cluster" });
  await expect(select).toHaveValue("default");
  await expect(select.locator("option").first()).toHaveText("As in Settings (off)");
  await select.selectOption("on");
  await expect
    .poll(() => page.evaluate(() => window.__fake.cluster.settings.contexts["kind-dev"]?.image_security))
    .toBe("on");
});

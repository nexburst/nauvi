import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./helpers";
import type { FakeCluster } from "../fixtures/cluster";

// The local scanner (#536, ADR 0011): a separate source in Settings → Image
// security; nothing of the scanner runs before its file is approved; a scan
// starts only from a click, one at a time, with Cancel; results show on the
// rows and in the panel, and failures say what happened.

const view = (page: Page) => page.getByTestId("image-security");
const imageRows = (page: Page) => view(page).getByTestId("image-row");
const imageRow = (page: Page, image: string) => view(page).locator(`[data-testid="image-row"][data-key^="${image}@"]`);
const panel = (page: Page) => page.getByTestId("image-findings");
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

// Init functions run in the page as source text: no captured variables.
const localOn = (cluster: FakeCluster) => {
  cluster.settings.image_security = { ...cluster.settings.image_security, enabled: true, source: "local" };
};
const localApproved = (cluster: FakeCluster) => {
  cluster.settings.image_security = { ...cluster.settings.image_security, enabled: true, source: "local" };
  cluster.imageScan = {
    found: { trivy: { path: "/usr/local/bin/trivy", version: "0.58.1", db: "2026-11-25T06:13:33Z" } },
    approved: { trivy: "/usr/local/bin/trivy" },
    changed: [],
    vulns: { "busybox:1.36": [] },
    errors: { "ghcr.io/team-a/app:2.1": "This computer cannot reach the registry ghcr.io. The scanner runs here, not in the cluster: check the network, VPN or proxy. (dial tcp: lookup ghcr.io: no such host)" },
    delayMs: 50,
    scanned: {},
    calls: [],
  };
};

async function goToImageSecurity(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await palette(page).getByRole("combobox").fill("image security");
  await palette(page).getByRole("option", { name: /Go to Image security/ }).click();
  await expect(view(page)).toBeVisible();
}

async function openSettingsSection(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  return { dialog, section: dialog.getByTestId("image-scanner-settings") };
}

test("the source is the cluster by default; choosing the local scanner asks to approve its file", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings.image_security = { ...cluster.settings.image_security, enabled: true };
  });
  await goToImageSecurity(page);
  await expect(imageRows(page)).toHaveCount(6);
  await expect(view(page).getByTestId("image-scan-bar")).toHaveCount(0);
  const { dialog, section } = await openSettingsSection(page);
  await expect(section.getByRole("combobox", { name: "Where vulnerabilities come from" })).toHaveValue("cluster");
  // Nothing about the scanner is asked while the source is the cluster.
  expect(await fake.calls("cmdImageScannerStatus")).toHaveLength(0);
  await section.getByRole("combobox", { name: "Where vulnerabilities come from" }).selectOption("local");
  const status = section.getByTestId("image-scanner-status");
  await expect(status).toHaveAttribute("data-state", "unapproved");
  await expect(status).toContainText("Trivy found at /usr/local/bin/trivy (on PATH). nauvi runs it only once you approve it.");
  await expect(section.getByTestId("image-scanner-file")).toHaveText("48.2 MB, SHA-256 3f1a9c0b7d2e…");
  await expect(section).toContainText("nauvi never downloads a scanner or a vulnerability database");
  await section.getByTestId("image-scanner-approve").click();
  await expect(status).toHaveAttribute("data-state", "ready");
  await expect(status).toContainText("Trivy 0.58.1 at /usr/local/bin/trivy. Its database was built 2026-11-25.");
  expect((await fake.lastCall("cmdImageScannerApprove")).path).toBe("/usr/local/bin/trivy");
  // Trivy's own options; Grype has none of them.
  await expect(section.getByRole("textbox", { name: "Trivy database repository" })).toBeVisible();
  await section.getByRole("combobox", { name: "Scanner on this computer" }).selectOption("grype");
  await expect(status).toHaveAttribute("data-state", "not_installed");
  await expect(status).toContainText("grype is not installed or not on PATH");
  await expect(section.getByRole("textbox", { name: "Trivy database repository" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  const saved = await page.evaluate(() => window.__fake.cluster.settings.image_security);
  expect(saved).toMatchObject({ source: "local", scanner: "grype" });
});

test("a changed binary and a malicious Trivy release are asked about again or refused", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.settings.image_security = { ...cluster.settings.image_security, enabled: true, source: "local" };
    cluster.imageScan = {
      found: { trivy: { path: "/usr/local/bin/trivy", version: "0.69.5", db: "" } },
      approved: { trivy: "/usr/local/bin/trivy" },
      changed: ["/usr/local/bin/trivy"],
      vulns: {},
      errors: {},
      delayMs: 50,
      scanned: {},
      calls: [],
    };
  });
  const { section } = await openSettingsSection(page);
  const status = section.getByTestId("image-scanner-status");
  await expect(status).toHaveAttribute("data-state", "changed");
  await expect(status).toContainText("changed since you approved it");
  await section.getByTestId("image-scanner-approve").click();
  await expect(status).toHaveAttribute("data-state", "refused");
  await expect(status).toContainText("CVE-2026-33634");
  await expect(section.getByTestId("image-scanner-approve")).toHaveCount(0);
});

test("local only: the pods' images, not scanned until a click; Scan all scans them one after another", async ({ page }) => {
  const fake = await openApp(page, localApproved);
  await goToImageSecurity(page);
  await expect(imageRows(page)).toHaveCount(6);
  await expect(imageRow(page, "nginx:1.27")).toContainText("Not scanned yet.");
  await expect(imageRow(page, "nginx:1.27")).toContainText("Not scanned on this computer yet");
  // Opening the view scans nothing.
  await page.waitForTimeout(300);
  expect(await fake.calls("cmdImageScan")).toHaveLength(0);
  const bar = view(page).getByTestId("image-scan-bar");
  await expect(bar).toContainText("6 images not scanned yet.");
  await bar.getByTestId("image-scan-all").click();
  await expect(imageRow(page, "nginx:1.27")).toContainText("1 critical and 1 high. 1 of 2 has a fix.");
  await expect(imageRow(page, "nginx:1.27")).toContainText("Trivy 0.58.1 on this computer, just now");
  await expect(imageRow(page, "busybox:1.36")).toContainText("No known vulnerabilities.");
  await expect(bar).toContainText("1 image not scanned yet.");
  // The unreachable registry says so plainly.
  const errors = view(page).getByTestId("image-scan-errors");
  await expect(errors).toContainText("ghcr.io/team-a/app:2.1: This computer cannot reach the registry ghcr.io.");
  const scanned = (await fake.calls("cmdImageScan")).map((c) => c.image);
  expect(scanned).toHaveLength(6);
  expect(new Set(scanned).size).toBe(6);
});

test("one image from its panel, then its findings; Cancel stops a scan", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings.image_security = { ...cluster.settings.image_security, enabled: true, source: "local" };
    cluster.imageScan = {
      found: { trivy: { path: "/usr/local/bin/trivy", version: "0.58.1", db: "2026-11-25T06:13:33Z" } },
      approved: { trivy: "/usr/local/bin/trivy" },
      changed: [],
      vulns: {},
      errors: {},
      delayMs: 60_000,
      scanned: {},
      calls: [],
    };
  });
  await goToImageSecurity(page);
  await imageRow(page, "redis:7.2").click();
  const action = panel(page).getByTestId("image-scan-action");
  await expect(action).toContainText("Not scanned yet. Trivy on this computer can scan it by its digest.");
  await action.getByTestId("image-scan-one").click();
  await expect(action).toContainText("Scanning with Trivy");
  await expect(view(page).getByTestId("image-scan-progress")).toContainText("Scanning redis:7.2…");
  // Another scan cannot start meanwhile.
  await expect(view(page).getByTestId("image-scan-all")).toHaveCount(0);
  await action.getByTestId("image-scan-cancel-one").click();
  await expect(panel(page).getByTestId("image-scan-error")).toHaveText("The scan was cancelled.");
  expect(await fake.calls("cmdImageScanCancel")).toHaveLength(1);
  await expect(imageRow(page, "redis:7.2")).toContainText("Not scanned yet.");

  // Fast now: scanned, with what to do in the panel.
  await page.evaluate(() => {
    window.__fake.cluster.imageScan!.delayMs = 50;
  });
  await action.getByTestId("image-scan-one").click();
  await expect(panel(page).getByTestId("findings-fixes")).toContainText("openssl");
  await expect(panel(page).getByTestId("findings-source")).toContainText("Trivy 0.58.1 on this computer");
  await expect(action.getByTestId("image-scan-one")).toHaveText("Scan again");
  await action.getByTestId("image-scan-one").click();
  await expect.poll(async () => (await fake.lastCall("cmdImageScan")).refresh).toBe(true);
});

test("unapproved: a scan says to approve the scanner first", async ({ page }) => {
  await openApp(page, localOn);
  await goToImageSecurity(page);
  await imageRow(page, "nginx:1.27").click();
  await panel(page).getByTestId("image-scan-one").click();
  await expect(panel(page).getByTestId("image-scan-error")).toHaveText(
    "Approve /usr/local/bin/trivy in Settings → Image security first.",
  );
});

test("cluster first, then this computer: reports stay, the rest can be scanned", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.settings.image_security = { ...cluster.settings.image_security, enabled: true, source: "cluster_then_local" };
    cluster.imageScan = {
      found: { trivy: { path: "/usr/local/bin/trivy", version: "0.58.1", db: "" } },
      approved: { trivy: "/usr/local/bin/trivy" },
      changed: [],
      vulns: {},
      errors: {},
      delayMs: 50,
      scanned: {},
      calls: [],
    };
  });
  await goToImageSecurity(page);
  await expect(imageRow(page, "nginx:1.27")).toContainText("through Trivy Operator");
  const bar = view(page).getByTestId("image-scan-bar");
  await expect(bar).toContainText("1 image not scanned yet.");
  await bar.getByTestId("image-scan-all").click();
  await expect(imageRow(page, "ghcr.io/team-a/worker:3")).toContainText("Trivy 0.58.1 on this computer");
  await expect(imageRow(page, "nginx:1.27")).toContainText("through Trivy Operator");
  await expect(bar).toContainText("Every running image here was scanned.");
});

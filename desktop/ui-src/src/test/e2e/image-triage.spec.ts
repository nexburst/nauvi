import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./helpers";

// Ignores and known exploited vulnerabilities (#537, ADR 0011 amendment):
// an ignore needs a reason and is counted, never hidden; an expired one
// counts again; a .trivyignore is read; the KEV download is off by default
// and, once on, marks findings red as "known to be exploited in the wild".

const view = (page: Page) => page.getByTestId("image-security");
const imageRow = (page: Page, image: string) => view(page).locator(`[data-testid="image-row"][data-key^="${image}@"]`);
const panel = (page: Page) => page.getByTestId("image-findings");
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

async function goToImageSecurity(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await palette(page).getByRole("combobox").fill("image security");
  await palette(page).getByRole("option", { name: /Go to Image security/ }).click();
  await expect(view(page)).toBeVisible();
}

async function openTriageSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const section = dialog.getByTestId("image-triage-settings");
  await section.scrollIntoViewIfNeeded();
  return { dialog, section };
}

test("an ignore from the panel needs a reason, is counted on the row and can be undone", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.settings.image_security = { ...cluster.settings.image_security, enabled: true };
  });
  await goToImageSecurity(page);
  await imageRow(page, "nginx:1.27").click();
  await expect(panel(page).getByTestId("findings-verdict")).toHaveText("2 critical and 5 high. 6 of 7 have a fix.");
  await expect(panel(page).getByTestId("findings-ignored")).toHaveCount(0);

  const form = panel(page).getByTestId("ignore-form");
  await form.locator("summary").click();
  await form.getByLabel("Vulnerability to ignore").selectOption("CVE-2026-1001");
  await expect(form.getByLabel("Where to ignore it").locator("option")).toHaveText([
    "Every nginx image",
    "Deployment web only",
    "Namespace demo",
  ]);
  await form.getByLabel("Where to ignore it").selectOption("workload");
  const ignore = form.getByRole("button", { name: "Ignore" });
  await expect(ignore).toBeDisabled();
  await form.getByLabel("Why it is ignored").fill("Not reachable: no TLS in this image");
  await ignore.click();

  await expect(imageRow(page, "nginx:1.27")).toContainText("1 critical and 5 high. 5 of 6 have a fix. 1 ignored.");
  await expect(panel(page).getByTestId("findings-verdict")).toHaveText(
    "1 critical and 5 high. 5 of 6 have a fix. 1 ignored.",
  );
  const ignored = panel(page).getByTestId("findings-ignored");
  await expect(ignored).toContainText("Ignored (1): not counted");
  await ignored.locator("summary").click();
  await expect(ignored).toContainText("CVE-2026-1001");
  await expect(ignored).toContainText("Not reachable: no TLS in this image");
  await expect(ignored).toContainText("Deployment web in demo");
  const saved = await page.evaluate(() => window.__fake.cluster.settings.image_security.ignores);
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ id: "CVE-2026-1001", scope: "workload", context: "kind-dev", name: "web" });
  expect(saved[0].expires).toBeGreaterThan(Date.now() / 1000 + 89 * 86400);

  // Settings lists it, with where and until when.
  const { dialog, section } = await openTriageSettings(page);
  await expect(section.getByTestId("ignore-rule")).toContainText("CVE-2026-1001");
  await expect(section.getByTestId("ignore-rule")).toContainText("in Deployment web in demo, until");
  await dialog.press("Escape");

  await ignored.getByRole("button", { name: "Stop ignoring" }).click();
  await expect(panel(page).getByTestId("findings-verdict")).toHaveText("2 critical and 5 high. 6 of 7 have a fix.");
  await expect(panel(page).getByTestId("findings-ignored")).toHaveCount(0);
});

test("an expired ignore counts again, and an ignore file's ignores are read and named", async ({ page }) => {
  await openApp(page, (cluster) => {
    const past = Math.floor(Date.now() / 1000) - 86400;
    cluster.settings.image_security = {
      ...cluster.settings.image_security,
      enabled: true,
      ignore_file: "/home/me/.trivyignore",
      ignores: [
        {
          id: "CVE-2026-1001",
          scope: "image",
          context: "",
          image: "nginx:1.26",
          namespace: "",
          kind: "",
          name: "",
          reason: "Accepted until the rebuild",
          expires: past,
          added: past - 86400,
          from_file: false,
        },
      ],
    };
  });
  await goToImageSecurity(page);
  // The fixture exists once the view has asked for its listing.
  await expect(imageRow(page, "nginx:1.27")).toBeVisible();
  await page.evaluate(() => {
    const d = window.__fake.cluster.imageSecurity;
    if (d)
      d.fileRules = [
        {
          id: "CVE-2026-1007",
          scope: "everywhere",
          context: "",
          image: "",
          namespace: "",
          kind: "",
          name: "",
          reason: "No fix upstream; tracked in OPS-12",
          expires: 0,
          added: 0,
          from_file: true,
        },
      ];
  });
  await page.getByRole("button", { name: "Refresh" }).first().click();
  await imageRow(page, "nginx:1.27").click();
  // The expired ignore of CVE-2026-1001 no longer applies; the file's of CVE-2026-1007 does.
  await expect(panel(page).getByTestId("findings-verdict")).toHaveText(
    "2 critical and 4 high. All 6 have a fix. 1 ignored.",
  );
  const ignored = panel(page).getByTestId("findings-ignored");
  await ignored.locator("summary").click();
  await expect(ignored).toContainText("No fix upstream; tracked in OPS-12 (ignore file)");
  await expect(ignored.getByRole("button", { name: "Stop ignoring" })).toHaveCount(0);

  const { section } = await openTriageSettings(page);
  await expect(section.getByTestId("ignore-file-status")).toHaveText("1 ignore read.");
  await expect(section.getByTestId("ignore-rule")).toContainText("expired on");
  await expect(section.getByTestId("ignore-rule")).toHaveClass(/expired/);
});

test("the KEV download is off by default; turned on, known exploited findings are red", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings.image_security = { ...cluster.settings.image_security, enabled: true };
  });
  await goToImageSecurity(page);
  await expect(imageRow(page, "nginx:1.27")).not.toContainText("known to be exploited");
  const { dialog, section } = await openTriageSettings(page);
  const box = section.getByLabel("Download the list of known exploited vulnerabilities");
  await expect(box).not.toBeChecked();
  await expect(section).toContainText("Off unless you turn it on");
  await expect(section).toContainText("Nothing about your clusters or images is sent");
  await expect(section.getByTestId("kev-status")).toHaveCount(0);
  expect(await fake.calls("cmdImageKevUpdate")).toHaveLength(0);

  await box.check();
  await expect(section.getByTestId("kev-status")).toContainText("Catalogue 2026.11.25, 1 vulnerabilities, downloaded");
  expect(await fake.calls("cmdImageKevUpdate")).toHaveLength(1);
  await dialog.press("Escape");

  await expect(imageRow(page, "nginx:1.27")).toContainText(
    "1 known to be exploited in the wild. 2 critical and 5 high.",
  );
  await imageRow(page, "nginx:1.27").click();
  const kev = panel(page).getByTestId("findings-kev");
  await expect(kev).toContainText("Known to be exploited in the wild (1)");
  await expect(kev).toContainText("CVE-2026-1002");
  await expect(kev).toContainText("openssl 3.0.11-1, fixed in 3.0.14-1");
  await expect(panel(page).getByTestId("findings-verdict")).toHaveClass(/critical/);
});

test("a failed KEV download says why and keeps the rest working", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.settings.image_security = { ...cluster.settings.image_security, enabled: true, kev_download: true };
  });
  await goToImageSecurity(page);
  await expect(imageRow(page, "nginx:1.27")).toBeVisible();
  await page.evaluate(() => {
    const d = window.__fake.cluster.imageSecurity;
    if (d) d.kevFail = "Could not download https://www.cisa.gov/...: the server answered 503 Service Unavailable.";
  });
  const { section } = await openTriageSettings(page);
  await expect(section.getByTestId("kev-status")).toHaveText("Not downloaded yet.");
  await section.getByRole("button", { name: "Download now" }).click();
  await expect(section.getByTestId("kev-error")).toContainText("the server answered 503");
});

test("EPSS and risk show only where the scanner gives them", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.settings.image_security = { ...cluster.settings.image_security, enabled: true };
  });
  await goToImageSecurity(page);
  await imageRow(page, "nginx:1.27").click();
  await expect(panel(page).getByTestId("findings-fixes")).toBeVisible();
  // The Trivy Operator gives none: no EPSS section.
  await expect(panel(page).getByTestId("findings-epss")).toHaveCount(0);
  await page.evaluate(() => {
    const d = window.__fake.cluster.imageSecurity;
    const v = d?.details["nginx:1.27@sha256:1111111111111111"]?.vulnerabilities.find((x) => x.id === "CVE-2026-1005");
    if (v) v.exploit = { kev: false, epss: 0.42, epss_percentile: 0.97, risk: 31.5 };
  });
  await imageRow(page, "redis:7.2").click();
  await imageRow(page, "nginx:1.27").click();
  const epss = panel(page).getByTestId("findings-epss");
  await expect(epss).toContainText("Most likely to be exploited (EPSS, from the scanner)");
  await expect(epss).toContainText("CVE-2026-1005");
  await expect(epss).toContainText("curl: EPSS 42% (top 3%), risk 31.5");
});

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, toggleNamespaces } from "./helpers";
import type { FakeCluster } from "../fixtures/cluster";

// Misconfigurations and Kubescape (#538): the Configuration tab of Image
// security lists the workloads with the checks they fail, the side panel
// says what to change; nothing is read while off or before the tab opens;
// Kubescape's counts never claim a fix.

const view = (page: Page) => page.getByTestId("image-security");
const tab = (page: Page, id: "images" | "config") =>
  page.getByTestId(`image-security-tab-${id}`);
const configRows = (page: Page) => view(page).getByTestId("config-row");
const configRow = (page: Page, key: string) =>
  view(page).locator(`[data-testid="config-row"][data-key="${key}"]`);
const panel = (page: Page) => page.getByTestId("config-findings");
const palette = (page: Page) =>
  page.getByRole("dialog", { name: "Command palette" });

const turnOn = (cluster: FakeCluster) => {
  cluster.settings.image_security = {
    ...cluster.settings.image_security,
    enabled: true,
  };
};

async function goToImageSecurity(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await palette(page).getByRole("combobox").fill("image security");
  await palette(page)
    .getByRole("option", { name: /Go to Image security/ })
    .click();
  await expect(view(page)).toBeVisible();
}

test("off: no tabs and no configuration read", async ({ page }) => {
  const fake = await openApp(page);
  await goToImageSecurity(page);
  await expect(view(page)).toContainText(
    "Image security is off for this cluster",
  );
  await expect(tab(page, "config")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect((await fake.calls("cmdImageConfigSummary")).length).toBe(0);
});

test("the Configuration tab lists workloads with what they fail; the panel says what to change", async ({
  page,
}) => {
  const fake = await openApp(page, turnOn);
  await goToImageSecurity(page);
  await expect(view(page).getByTestId("image-row").first()).toBeVisible();
  // Not read until the tab opens.
  expect((await fake.calls("cmdImageConfigSummary")).length).toBe(0);

  await tab(page, "config").click();
  await expect(tab(page, "config")).toHaveAttribute("aria-selected", "true");
  await expect(configRows(page)).toHaveCount(5);
  await expect(view(page).getByTestId("image-config-headline")).toHaveText(
    "2 workloads have settings to change",
  );
  const web = configRow(page, "Deployment/demo/web");
  await expect(web.getByTestId("config-verdict")).toHaveText(
    "Fails 3 checks: 1 critical and 2 high.",
  );
  await expect(web).toHaveAttribute("data-tone", "critical");
  await expect(
    configRow(page, "Service/demo/web").getByTestId("config-verdict"),
  ).toHaveText("Passes every check.");
  // The old report is marked.
  await expect(configRow(page, "Deployment/team-a/app")).toContainText(
    "old check",
  );

  await web.click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId("config-findings-verdict")).toHaveText(
    "Fails 3 checks: 1 critical and 2 high.",
  );
  const checks = panel(page).getByTestId("config-findings-checks");
  await expect(checks.locator("li")).toHaveCount(3);
  await expect(checks.locator("li").first()).toContainText(
    "Privileged container",
  );
  await expect(checks.locator("li").first()).toContainText(
    "Change 'containers[].securityContext.privileged' to 'false'.",
  );
  await expect(panel(page).getByTestId("config-findings-lower")).toContainText(
    "Lower severity (3)",
  );
  await expect(panel(page)).toContainText("18 checks");
  await expect(panel(page).getByTestId("config-findings-source")).toHaveText(
    /Trivy 0\.69\.3 through Trivy Operator, 1 day ago/,
  );
  const detail = await fake.calls("cmdImageConfigDetail");
  expect(detail.at(-1)).toEqual({ namespaces: [], kind: "Deployment", namespace: "demo", name: "web" });

  // The search filters the rows; the images tab comes back without the panel.
  await page.getByLabel("Filter").fill("cache");
  await expect(configRows(page)).toHaveCount(1);
  await page.getByLabel("Filter").fill("");
  await tab(page, "images").click();
  await expect(panel(page)).toHaveCount(0);
  await expect(view(page).getByTestId("image-row").first()).toBeVisible();
});

test("the configuration empty states are told apart", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.settings.image_security = {
      ...cluster.settings.image_security,
      enabled: true,
    };
    cluster.imageConfig = {
      state: "no_operator",
      workloads: [],
      details: {},
      forbidden: [],
      notes: [],
    };
  });
  await goToImageSecurity(page);
  await tab(page, "config").click();
  const state = view(page).getByTestId("image-config-state");
  await expect(state).toHaveAttribute("data-state", "no_operator");
  await expect(state).toContainText("This cluster has no configuration audits");
});

test("a namespace where the reports may not be listed says so", async ({
  page,
}) => {
  await openApp(page, (cluster) => {
    cluster.settings.image_security = {
      ...cluster.settings.image_security,
      enabled: true,
    };
    cluster.imageConfig = {
      state: "ok",
      workloads: [],
      details: {},
      forbidden: ["demo"],
      notes: [],
    };
  });
  await goToImageSecurity(page);
  await tab(page, "config").click();
  await toggleNamespaces(page, "demo");
  const state = view(page).getByTestId("image-config-state");
  await expect(state).toHaveAttribute("data-state", "forbidden");
  await expect(state).toContainText(
    "You are not allowed to list configauditreports in namespace demo",
  );
});

test("Kubescape's counts never claim a fix; the panel's full report does", async ({
  page,
}) => {
  await openApp(page, (cluster) => {
    cluster.settings.image_security = {
      ...cluster.settings.image_security,
      enabled: true,
    };
    const zero = { critical: 0, high: 0, medium: 0, low: 0, unknown: 0 };
    const row = {
      source: "kubescape" as const,
      image: "nginx:1.27",
      digest: "sha256:1111111111111111",
      running: true,
      scanned: true,
      counts: { ...zero, critical: 1, high: 2 },
      fixable: zero,
      fixes_known: false,
      workloads: [
        {
          kind: "Deployment",
          namespace: "demo",
          name: "web",
          container: "nginx",
          cron_job: "",
        },
      ],
      report_namespace: "kubescape",
      report_name: "docker.io-library-nginx-1.27-abcdef",
      reports: 1,
      scanner: "Kubescape",
      scanned_at: Math.floor(Date.now() / 1000) - 3600,
      ignored: zero,
      kev: 0,
    };
    const vuln = (
      id: string,
      severity: "critical" | "high",
      fixed: string,
    ) => ({
      id,
      package: "openssl",
      installed_version: "3.0.11-1",
      fixed_version: fixed,
      severity,
      score: 0,
      title: "openssl issue",
      link: "",
      exploit: { kev: false, epss: 0, epss_percentile: 0, risk: 0 },
    });
    cluster.imageSecurity = {
      state: "ok",
      images: [row],
      details: {
        [`${row.image}@${row.digest}`]: {
          image: {
            ...row,
            fixable: { ...zero, critical: 1 },
            fixes_known: true,
          },
          vulnerabilities: [
            vuln("CVE-1", "critical", "3.0.15-1"),
            vuln("CVE-2", "high", ""),
            vuln("CVE-3", "high", ""),
          ],
          fix_groups: [
            {
              package: "openssl",
              installed_version: "3.0.11-1",
              fixed_in: ["3.0.15-1"],
              counts: { ...zero, critical: 1, high: 2 },
              fixable: 1,
              ids: ["CVE-1", "CVE-2", "CVE-3"],
            },
          ],
          ignored: [],
        },
      },
      forbidden: [],
      notes: [],
    };
  });
  await goToImageSecurity(page);
  const row = view(page).getByTestId("image-row").first();
  await expect(row.getByTestId("image-verdict")).toHaveText(
    "1 critical and 2 high. Open it to see which have a fix.",
  );
  await expect(row).toHaveAttribute("data-tone", "high");
  await expect(row).toContainText("Kubescape scan, 1 hour ago");
  await expect(view(page).getByTestId("image-security-headline")).toHaveText(
    "1 image has known vulnerabilities",
  );
  await row.click();
  const findings = page.getByTestId("image-findings");
  await expect(findings.getByTestId("findings-verdict")).toHaveText(
    "1 critical and 2 high. 1 of 3 has a fix.",
  );
  await expect(findings.getByTestId("findings-fixes")).toContainText(
    "Updating openssl to 3.0.15-1",
  );
});

test("a scanner on this computer only: the Configuration tab reads nothing from the cluster", async ({
  page,
}) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings.image_security = {
      ...cluster.settings.image_security,
      enabled: true,
      source: "local",
    };
  });
  await goToImageSecurity(page);
  await tab(page, "config").click();
  const state = view(page).getByTestId("image-config-local");
  await expect(state).toContainText("Configuration checks come from the cluster");
  await expect(state).toContainText("a scanner on this computer only");
  await expect(configRows(page)).toHaveCount(0);
  // Refresh reads nothing either.
  await page.getByRole("button", { name: "Refresh" }).first().click();
  await page.waitForTimeout(300);
  expect((await fake.calls("cmdImageConfigSummary")).length).toBe(0);
  expect((await fake.calls("cmdImageConfigDetail")).length).toBe(0);
  await state.getByRole("button", { name: "Settings…" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
});

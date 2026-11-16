import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { column, openApp, openKind, row } from "./helpers";

// One-click metrics (#225): the overview offers metrics-server and Settings
// a small Prometheus when there is none; both go through a dry run and an
// explicit confirm that names the chart, its pinned version and repository.
// RBAC greys the offer with the reason. A Disk column on Nodes follows once
// Prometheus reports node-exporter disks.

const dialog = (page: Page) => page.getByRole("dialog", { name: /^Install / });

async function setText(page: Page, editor: Locator, text: string) {
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}

test("without metrics-server, the overview offers to install it after a dry run and a confirm", async ({ page }) => {
  const fake = await openApp(page, (c) => {
    c.overview.capacity!.metrics = false;
  });
  const capacity = page.getByRole("region", { name: "Capacity" });
  await expect(capacity).toContainText("No usage: the metrics API (metrics-server) is not available.");
  await capacity.getByRole("button", { name: "Install metrics-server…" }).click();

  const dlg = dialog(page);
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId("addon-chart")).toContainText("metrics-server 3.14.0");
  await expect(dlg.getByTestId("addon-chart")).toContainText("https://kubernetes-sigs.github.io/metrics-server/");
  await expect(dlg.getByLabel("Namespace", { exact: true })).toHaveValue("kube-system");
  await expect(dlg.getByLabel("Release name")).toHaveValue("metrics-server");
  // The kind option is visible and off; the context looks like kind, so a hint says why it matters.
  const insecure = dlg.getByTestId("addon-option-kubelet-insecure-tls");
  await expect(insecure).not.toBeChecked();
  await expect(dlg.getByTestId("addon-local-hint")).toContainText("kind-dev looks like a local cluster");
  const values = dlg.getByRole("textbox", { name: "Values" });
  await expect(values).toContainText("replicas: 1");
  await insecure.check();
  await setText(page, values, "replicas: 2\n");

  await dlg.getByTestId("addon-preview").click();
  await expect(dlg.getByTestId("addon-summary")).toHaveText(
    "Dry run of kube-system/metrics-server: 2 objects, nothing changed.",
  );
  const facts = dlg.getByTestId("addon-confirm-facts");
  await expect(facts).toContainText("https://kubernetes-sigs.github.io/metrics-server/");
  await expect(facts).toContainText("kube-system/metrics-server on kind-dev");
  await expect(facts).toContainText("--kubelet-insecure-tls");
  await expect(dlg.getByRole("textbox", { name: "Rendered manifest" })).toContainText("--kubelet-insecure-tls");
  expect(await fake.calls("cmdMetricsAddonInstall")).toEqual([
    {
      request: {
        addon: "metrics-server",
        name: "metrics-server",
        namespace: "kube-system",
        values: "replicas: 2\n",
        options: ["kubelet-insecure-tls"],
        create_namespace: true,
        dry_run: true,
        reveal: false,
      },
    },
  ]);
  // Nothing was installed by the dry run.
  expect(await page.evaluate(() => window.__fake.cluster.metricsAddons.installed)).toEqual([]);

  await dlg.getByTestId("addon-confirm").click();
  await expect(dlg.getByTestId("addon-result")).toHaveText("Installed kube-system/metrics-server (revision 1).");
  const installed = await page.evaluate(() => window.__fake.cluster.metricsAddons.installed);
  expect(installed.map((r) => [r.addon, r.dry_run, r.values, r.options])).toEqual([
    ["metrics-server", false, "replicas: 2\n", ["kubelet-insecure-tls"]],
  ]);
  await dlg.getByRole("button", { name: "Close" }).click();
  await expect(dlg).toBeHidden();
  expect(fake.errors).toEqual([]);
});

test("the offer is greyed with the reason when RBAC refuses cluster-scoped objects", async ({ page }) => {
  await openApp(page, (c) => {
    c.overview.capacity!.metrics = false;
    c.metricsAddons.denied["metrics-server"] = "Not allowed: you can't create clusterroles.rbac.authorization.k8s.io";
  });
  const offer = page.getByTestId("metrics-offer-metrics-server");
  await expect(offer.getByTestId("metrics-offer-denied")).toHaveText(
    "Not allowed: you can't create clusterroles.rbac.authorization.k8s.io",
  );
  await expect(offer.getByRole("button", { name: "Install metrics-server…" })).toBeDisabled();
});

test("a failed dry run is shown, nothing is installed, and Escape cancels", async ({ page }) => {
  await openApp(page, (c) => {
    c.overview.capacity!.metrics = false;
    c.metricsAddons.failure = 'apiservices.apiregistration.k8s.io "v1beta1.metrics.k8s.io" already exists';
  });
  await page.getByRole("button", { name: "Install metrics-server…" }).click();
  const dlg = dialog(page);
  await dlg.getByTestId("addon-preview").click();
  await expect(dlg.getByTestId("addon-error")).toHaveText(
    'Dry run of the install of metrics-server failed: apiservices.apiregistration.k8s.io "v1beta1.metrics.k8s.io" already exists',
  );
  await expect(dlg.getByTestId("addon-confirm")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dlg).toBeHidden();
  expect(await page.evaluate(() => window.__fake.cluster.metricsAddons.installed)).toEqual([]);
});

test("Settings offers a small Prometheus; after the install it is used and Nodes get a Disk column", async ({
  page,
}) => {
  const fake = await openApp(page);
  // No Prometheus: Nodes have no Disk column.
  await openKind(page, "Nodes");
  await expect(row(page, "node-1")).toBeVisible();
  await expect(page.locator(".table .head .th", { hasText: "Disk" })).toHaveCount(0);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const section = page.getByRole("dialog", { name: "Settings" }).getByTestId("prometheus-settings");
  await section.getByRole("button", { name: "Install Prometheus…" }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeHidden();
  const dlg = dialog(page);
  await expect(dlg.getByTestId("addon-chart")).toContainText("prometheus 29.47.2");
  await expect(dlg.getByTestId("addon-chart")).toContainText("kube-state-metrics");
  await expect(dlg.getByLabel("Namespace", { exact: true })).toHaveValue("monitoring");
  await dlg.getByTestId("addon-preview").click();
  await expect(dlg.getByTestId("addon-repo")).toHaveText("https://prometheus-community.github.io/helm-charts");
  await dlg.getByTestId("addon-confirm").click();
  await expect(dlg.getByTestId("addon-result")).toHaveText("Installed monitoring/prometheus (revision 1).");
  await dlg.getByRole("button", { name: "Close" }).click();

  // Detected at once, and the next metrics poll brings the Disk column.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(section.getByTestId("prometheus-status")).toHaveText("Using monitoring/prometheus-server:http (detected).");
  await expect(section.getByRole("button", { name: "Install Prometheus…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await openKind(page, "Pods");
  await openKind(page, "Nodes");
  await expect.poll(() => column(page, "Disk")).toContain("43% · 21.5Gi / 50Gi");
  expect(fake.errors).toEqual([]);
});

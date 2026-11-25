import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./helpers";

// A kubectl matching the cluster for the local terminal (#331): opt in
// from Settings, offered above the terminal, downloaded only on a click.

const dock = (page: Page) => page.getByTestId("dock");
const offer = (page: Page) => page.getByTestId("kubectl-offer");
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

async function newLocalTerminal(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("local term");
  await expect(palette(page).getByRole("option").first()).toContainText("New local terminal");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
}

test("off by default: no offer and no download", async ({ page }) => {
  const fake = await openApp(page);
  await newLocalTerminal(page);
  await expect(dock(page).locator(".xterm")).toContainText("kubectl uses context kind-dev");
  await expect(offer(page)).toHaveCount(0);
  expect(await fake.calls("cmdKubectlMatch")).toHaveLength(0);
  expect(await fake.calls("cmdKubectlDownload")).toHaveLength(0);
  expect(fake.errors).toEqual([]);
});

test("the setting is in Settings and saved", async ({ page }) => {
  const fake = await openApp(page);
  await page.keyboard.press("ControlOrMeta+,");
  const box = page.getByTestId("kubectl-settings").getByRole("checkbox", {
    name: "Offer a kubectl that matches the cluster",
  });
  await expect(box).not.toBeChecked();
  await box.check();
  expect((await fake.lastCall("cmdUpdateSettings")).patch).toEqual({ kubectl_match: true });
  await expect(page.getByTestId("kubectl-settings")).toContainText("dl.k8s.io");
});

test("offers the matching kubectl, downloads it on the click, then new terminals use it", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings = { ...cluster.settings, kubectl_match: true };
  });
  await newLocalTerminal(page);
  await expect(offer(page)).toContainText("Your kubectl v1.28.0 is more than one minor version");
  await expect(offer(page)).toContainText("https://dl.k8s.io/release/v1.31.2/bin/linux/amd64/kubectl");
  // Looking is not downloading.
  expect(await fake.calls("cmdKubectlDownload")).toHaveLength(0);

  await offer(page).getByRole("button", { name: "Download kubectl v1.31.2" }).click();
  await expect(offer(page)).toContainText("SHA-256 checked");
  expect(await fake.calls("cmdKubectlDownload")).toHaveLength(1);

  await offer(page).getByRole("button", { name: "Open a new local terminal" }).click();
  const second = dock(page).locator('[data-testid="dock-pane"][data-tab="local:2"]');
  await expect(second.locator(".xterm")).toContainText("kubectl v1.31.2, downloaded to match the cluster");
  await expect(second.getByTestId("kubectl-offer")).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("a failed download says why and can be tried again; dismiss hides it", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings = { ...cluster.settings, kubectl_match: true };
    cluster.kubectl = {
      server: "v1.31.2",
      installed: "",
      downloaded: false,
      downloadError:
        "The downloaded kubectl's SHA-256 (00) does not match the one dl.k8s.io publishes (ff). It was not saved.",
    };
  });
  await newLocalTerminal(page);
  await expect(offer(page)).toContainText("No kubectl was found on your PATH");
  await offer(page).getByRole("button", { name: "Download kubectl v1.31.2" }).click();
  await expect(offer(page)).toHaveAttribute("role", "alert");
  await expect(offer(page)).toContainText("does not match");
  await expect(offer(page).getByRole("button", { name: "Try again" })).toBeVisible();
  await offer(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(offer(page)).toHaveCount(0);
  expect(await fake.calls("cmdKubectlDownload")).toHaveLength(1);
  expect(fake.errors.filter((e) => !e.includes("does not match"))).toEqual([]);
});

test("no offer when the kubectl is close enough", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings = { ...cluster.settings, kubectl_match: true };
    cluster.kubectl = { server: "v1.31.2", installed: "v1.30.1", downloaded: false, downloadError: "" };
  });
  await newLocalTerminal(page);
  await expect.poll(() => fake.calls("cmdKubectlMatch")).toHaveLength(1);
  await expect(offer(page)).toHaveCount(0);
});

test("a cluster older than 1.27 gets no download, and the bar says why (#444)", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings = { ...cluster.settings, kubectl_match: true };
    cluster.kubectl = { server: "v1.10.0", installed: "v1.31.0", downloaded: false, downloadError: "" };
  });
  await newLocalTerminal(page);
  await expect(offer(page)).toContainText(
    "No matching kubectl to offer: the cluster reports v1.10.0; nauvi only downloads kubectl 1.27 or newer",
  );
  await expect(offer(page)).toContainText("Your own kubectl is used.");
  await expect(offer(page).getByRole("button", { name: /Download/ })).toHaveCount(0);
  await expect(offer(page)).not.toContainText("dl.k8s.io/release");
  expect(await fake.calls("cmdKubectlDownload")).toHaveLength(0);
  await offer(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(offer(page)).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

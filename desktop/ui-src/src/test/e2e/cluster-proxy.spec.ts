import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./helpers";

// The per-cluster proxy (#329) on a cluster's settings page: saved per
// context id through `cmd_set_cluster_proxy`, shown with its credentials
// masked, checked by the backend.

const dialog = (page: Page) =>
  page.getByRole("dialog", { name: "Cluster settings" });
const section = (page: Page) => dialog(page).getByTestId("cluster-proxy");

async function openSettingsFor(
  page: Page,
  id: string,
  { catalogOpen = false } = {},
) {
  if (!catalogOpen)
    await page.getByRole("button", { name: "Cluster catalog" }).click();
  await page
    .getByRole("button", { name: `More actions for ${id}`, exact: true })
    .click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  await expect(dialog(page)).toBeVisible();
}

test("a proxy is saved for its cluster and shown without its password", async ({
  page,
}) => {
  const fake = await openApp(page);
  await openSettingsFor(page, "prod");
  await expect(section(page).getByTestId("proxy-route")).toHaveText(
    /^Connects directly\./,
  );

  const field = section(page).getByRole("textbox", { name: "Proxy URL" });
  await field.fill("http://me:hunter2@proxy.example:3128");
  await section(page).getByRole("button", { name: "Save proxy" }).click();

  await expect(section(page).getByTestId("proxy-current")).toHaveText(
    "http://[redacted]@proxy.example:3128",
  );
  await expect(section(page).getByTestId("proxy-route")).toHaveText(
    "Connects through http://[redacted]@proxy.example:3128.",
  );
  await expect(field).toHaveValue("");
  await expect(section(page).getByTestId("proxy-applies")).toContainText(
    "next time a window connects",
  );
  // prod is not the cluster this window shows: nothing to reconnect.
  await expect(
    section(page).getByRole("button", { name: "Reconnect now" }),
  ).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain("hunter2");
  expect(await fake.calls("cmdSetClusterProxy")).toEqual([
    { id: "prod", url: "http://me:hunter2@proxy.example:3128", local: false },
  ]);

  // Reopened, it is still there; another cluster has none.
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await openSettingsFor(page, "prod", { catalogOpen: true });
  await expect(section(page).getByTestId("proxy-current")).toHaveText(
    "http://[redacted]@proxy.example:3128",
  );
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  await openSettingsFor(page, "kind-dev", { catalogOpen: true });
  await expect(section(page).getByTestId("proxy-current")).toHaveCount(0);
});

test("a bad proxy URL says what is wrong and saves nothing", async ({
  page,
}) => {
  await openApp(page);
  await openSettingsFor(page, "prod");
  const field = section(page).getByRole("textbox", { name: "Proxy URL" });
  await expect(
    section(page).getByRole("button", { name: "Save proxy" }),
  ).toBeDisabled();

  await field.fill("ftp://me:hunter2@proxy.example");
  await field.press("Enter");
  await expect(section(page).getByTestId("proxy-error")).toHaveText(
    "A proxy URL starts with http:// or socks5://, not ftp://.",
  );
  await field.fill("https://proxy.example:3128");
  await field.press("Enter");
  await expect(section(page).getByTestId("proxy-error")).toHaveText(
    "HTTPS proxies aren't supported yet; use http:// or socks5://.",
  );
  await field.fill("socks5://me:pw@proxy.example");
  await section(page).getByRole("button", { name: "Save proxy" }).click();
  await expect(section(page).getByTestId("proxy-error")).toContainText(
    "not supported for SOCKS5",
  );
  await expect(section(page).getByTestId("proxy-current")).toHaveCount(0);
  expect(await page.locator("body").innerText()).not.toContain("hunter2");

  // A good one clears the error.
  await field.fill("socks5://10.0.0.1");
  await field.press("Enter");
  await expect(section(page).getByTestId("proxy-current")).toHaveText(
    "socks5://10.0.0.1:1080",
  );
  await expect(section(page).getByTestId("proxy-error")).toHaveCount(0);
});

test("the proxy can be used for a local cluster, changed and removed", async ({
  page,
}) => {
  const fake = await openApp(page, (cluster) => {
    const ctx = cluster.contexts.find((c) => c.name === "kind-dev");
    if (ctx) ctx.server = "https://127.0.0.1:6443";
  });
  await openSettingsFor(page, "kind-dev");
  const field = section(page).getByRole("textbox", { name: "Proxy URL" });
  await field.fill("http://proxy.example:3128");
  await field.press("Enter");
  await expect(section(page).getByTestId("proxy-route")).toContainText(
    "the cluster is on this machine",
  );

  await section(page)
    .getByRole("checkbox", {
      name: "Use the proxy for a cluster on this machine",
    })
    .check();
  await expect(section(page).getByTestId("proxy-route")).toHaveText(
    "Connects through http://proxy.example:3128.",
  );
  expect(await fake.lastCall("cmdSetClusterProxy")).toEqual({
    id: "kind-dev",
    url: null,
    local: true,
  });
  // The cluster this window shows: it can reconnect now.
  await expect(
    section(page).getByRole("button", { name: "Reconnect now" }),
  ).toBeVisible();

  await section(page).getByRole("button", { name: "Remove proxy" }).click();
  await expect(section(page).getByTestId("proxy-current")).toHaveCount(0);
  await expect(section(page).getByTestId("proxy-route")).toHaveText(
    /^Connects directly\./,
  );
});

test("Reconnect now opens a fresh session on the same cluster", async ({
  page,
}) => {
  const fake = await openApp(page);
  await openSettingsFor(page, "kind-dev");
  await section(page)
    .getByRole("textbox", { name: "Proxy URL" })
    .fill("http://proxy.example:3128");
  await section(page).getByRole("button", { name: "Save proxy" }).click();
  await section(page).getByRole("button", { name: "Reconnect now" }).click();
  await expect(dialog(page)).toHaveCount(0);
  expect(await fake.lastCall("cmdSetContext")).toEqual({ name: "kind-dev" });
  // Still on kind-dev, with its contexts loaded again.
  await expect(page.getByTestId("open-in-new-window")).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Cluster context" }),
  ).toHaveValue("kind-dev");
});

test("the kubeconfig's own proxy-url is shown, and which proxy is in effect", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.kubeconfigProxies = { prod: "http://[redacted]@corp.example:8080" };
  });
  await openSettingsFor(page, "prod");
  const kc = section(page).getByTestId("proxy-kubeconfig");
  await expect(kc).toHaveText("http://[redacted]@corp.example:8080");
  await expect(section(page)).toContainText("Kubeconfig proxy (in effect)");
  await expect(section(page).getByTestId("proxy-route")).toHaveText(
    "Connects through the kubeconfig's proxy-url, http://[redacted]@corp.example:8080.",
  );

  const field = section(page).getByRole("textbox", { name: "Proxy URL" });
  await field.fill("http://proxy.example:3128");
  await field.press("Enter");
  await expect(section(page)).toContainText("Proxy (in effect)");
  await expect(section(page)).toContainText("Kubeconfig proxy (replaced)");
  await expect(section(page).getByTestId("proxy-route")).toHaveText("Connects through http://proxy.example:3128.");
});

test("an error from the backend shows in the section", async ({ page }) => {
  await openApp(page);
  await openSettingsFor(page, "prod");
  await page.evaluate(() =>
    window.__fake.failNext(
      "cmdSetClusterProxy",
      "Could not save the proxy in /cfg/proxies.json: disk full",
    ),
  );
  await section(page)
    .getByRole("textbox", { name: "Proxy URL" })
    .fill("http://proxy.example:3128");
  await section(page).getByRole("button", { name: "Save proxy" }).click();
  await expect(section(page).getByTestId("proxy-error")).toHaveText(
    "Could not save the proxy in /cfg/proxies.json: disk full",
  );
});

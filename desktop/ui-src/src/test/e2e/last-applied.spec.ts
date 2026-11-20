import { expect, test } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// kubectl's last-applied-configuration annotation (#409): collapsed by
// default, shown (as the backend masked it) on demand.
const panel = (page: import("@playwright/test").Page) => page.locator("aside");

test("last-applied-configuration is collapsed with its size, and shows masked JSON", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    const d = cluster.details["v1/pods|demo/web-1"];
    // What the backend sends: already masked, compact JSON.
    const applied = JSON.stringify({
      apiVersion: "v1",
      kind: "Pod",
      metadata: { name: "web-1", namespace: "demo" },
      spec: { containers: [{ name: "app", image: "nginx:1.27", args: ["--token=••••", "--port", "8080"] }] },
      pad: "x".repeat(2000),
    });
    d.annotations = { ...d.annotations, "kubectl.kubernetes.io/last-applied-configuration": applied };
  });
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  const p = panel(page);
  await p.getByText("Annotations (2)").click();

  const la = p.getByTestId("last-applied");
  await expect(la).toHaveText(/last-applied-configuration · 2\.\d KB · Show/);
  await expect(p.getByTestId("last-applied-text")).toHaveCount(0);
  // The other annotation still shows in full.
  await expect(p.getByText("2024-05-01T10:00:00Z")).toBeVisible();

  await p.getByTestId("last-applied-toggle").click();
  const text = p.getByTestId("last-applied-text");
  await expect(text).toBeVisible();
  await expect(text).toContainText('"--token=••••"');
  // Indented, not one long line.
  await expect(text).toContainText('\n  "kind": "Pod"');
  await expect(p.getByTestId("last-applied-masked")).toBeVisible();
  await expect(p.getByTestId("last-applied-toggle")).toHaveText("Hide");

  await p.getByTestId("last-applied-toggle").click();
  await expect(text).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("a last-applied with nothing hidden has no mask note", async ({ page }) => {
  await openApp(page, (cluster) => {
    const d = cluster.details["v1/pods|demo/web-1"];
    d.annotations = { "kubectl.kubernetes.io/last-applied-configuration": '{"kind":"Pod"}' };
  });
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  const p = panel(page);
  await p.getByText("Annotations (1)").click();
  await expect(p.getByTestId("last-applied")).toHaveText(/· 14 B · Show/);
  await p.getByTestId("last-applied-toggle").click();
  await expect(p.getByTestId("last-applied-text")).toBeVisible();
  await expect(p.getByTestId("last-applied-masked")).toHaveCount(0);
});

// Available tags (#539): off by default; with the setting on, a button by
// each image in the pod and workload panels asks the registry (only on the
// click) and lists the newer tags by step, with a repushed tag and errors
// said plainly.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

const panel = (page: Page) => page.locator("aside");
const card = (page: Page, name: string) => panel(page).getByRole("region", { name: `Container ${name}` });
const tagsButton = (page: Page, name: string) => panel(page).getByRole("button", { name: `Available tags of ${name}` });
const tagsBox = (page: Page, name: string) => panel(page).getByRole("region", { name: `Available tags of ${name}` });

async function openWeb1(page: Page) {
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panel(page).locator(".title")).toHaveText("demo/web-1");
  await expect(card(page, "app")).toBeVisible();
}

test("off by default: no button and no request", async ({ page }) => {
  const fake = await openApp(page);
  await openWeb1(page);
  await expect(panel(page).getByTestId("available-tags")).toHaveCount(0);
  expect(await fake.calls("cmdRegistryTags")).toHaveLength(0);
});

test("the setting is in Settings, Clusters, and saved", async ({ page }) => {
  const fake = await openApp(page);
  await page.keyboard.press("ControlOrMeta+,");
  await page.getByRole("tab", { name: "Clusters" }).click();
  const box = page.getByTestId("registry-tags-settings").getByRole("checkbox", { name: "Show available tags" });
  await expect(box).not.toBeChecked();
  await box.check();
  expect((await fake.lastCall("cmdUpdateSettings")).patch).toEqual({ registry_tags: true });
  await expect(page.getByTestId("registry-tags-settings")).toContainText("never the cluster's pull secrets");
});

test("a click lists newer tags by step, with the repushed tag", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings = { ...cluster.settings, registry_tags: true };
    const none = { tags: [], more: 0 };
    cluster.registryTags = {
      "busybox:1.36": {
        image: "busybox:1.36",
        registry: "docker.io",
        repository: "library/busybox",
        tag: "1.36",
        version: "1.36",
        variant: "",
        patch: none,
        minor: { tags: [{ tag: "1.37", updated: "2026-09-01T00:00:00Z" }], more: 0 },
        major: { tags: [{ tag: "2.0", updated: "" }], more: 4 },
        other: { tags: [{ tag: "latest", updated: "" }], more: 0 },
        tag_count: 42,
        truncated: false,
        state: "updated",
        registry_digest: `sha256:${"a".repeat(64)}`,
        running_digest: `sha256:${"b".repeat(64)}`,
        fetched_at: 0,
      },
    };
  });
  await openWeb1(page);
  // Nothing is asked before the click.
  expect(await fake.calls("cmdRegistryTags")).toHaveLength(0);
  await tagsButton(page, "init-db").click();
  const box = tagsBox(page, "init-db");
  await expect(box.getByTestId("tags-state")).toHaveText(
    "This tag was updated in the registry: 1.36 now points to sha256:aaaaaaaaaaaa, the container runs sha256:bbbbbbbbbbbb.",
  );
  await expect(box.getByTestId("tags-minor")).toContainText("Newer minor · new features");
  await expect(box.getByTestId("tags-minor")).toContainText("1.37 2026-09-01");
  await expect(box.getByTestId("tags-major")).toContainText("may break things");
  await expect(box.getByTestId("tags-major")).toContainText("+4 more");
  await expect(box.getByTestId("tags-patch")).toHaveCount(0);
  await expect(box.getByTestId("tags-count")).toHaveText("42 tags on Docker Hub");
  expect(await fake.lastCall("cmdRegistryTags")).toEqual(
    expect.objectContaining({ image: "busybox:1.36", imageId: "docker.io/library/busybox:1.36@sha256:0123", refresh: false }),
  );

  // Refresh skips the cache; Hide folds it back to the button.
  await box.getByRole("button", { name: "Refresh" }).click();
  await expect.poll(async () => (await fake.lastCall("cmdRegistryTags")).refresh).toBe(true);
  await box.getByRole("button", { name: "Hide" }).click();
  await expect(tagsButton(page, "init-db")).toBeVisible();
  expect(fake.errors).toEqual([]);
});

test("a registry that refuses says so, and Try again asks again", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings = { ...cluster.settings, registry_tags: true };
    cluster.registryTags = {
      "nginx:1.27": "Docker Hub limits how often it answers (429 Too Many Requests). Try again later.",
    };
  });
  await openWeb1(page);
  await tagsButton(page, "app").click();
  const box = tagsBox(page, "app");
  await expect(box.getByTestId("tags-error")).toHaveText(
    "Docker Hub limits how often it answers (429 Too Many Requests). Try again later.",
  );
  await box.getByRole("button", { name: "Try again" }).click();
  await expect.poll(async () => (await fake.calls("cmdRegistryTags")).length).toBe(2);
});

test("the workload panel lists its template's images with the button", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.settings = { ...cluster.settings, registry_tags: true };
  });
  await openKind(page, "Deployments");
  await row(page, "web").click();
  const images = panel(page).getByTestId("workload-images");
  await expect(images).toContainText("nginx:1.27");
  await tagsButton(page, "web").click();
  const box = tagsBox(page, "web");
  await expect(box.getByTestId("tags-minor")).toContainText("1.29");
  await expect(box.getByTestId("tags-other")).toContainText("latest");
  // No running image here, so nothing is said about the tag itself.
  await expect(box.getByTestId("tags-state")).toHaveCount(0);
  expect(await fake.lastCall("cmdRegistryTags")).toEqual(expect.objectContaining({ image: "nginx:1.27", imageId: "" }));
});

test("the workload panel asks nothing with the setting off", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Deployments");
  await row(page, "web").click();
  await expect(panel(page).locator(".title")).toContainText("web");
  await expect(panel(page).getByTestId("workload-images")).toHaveCount(0);
  expect(await fake.calls("cmdWorkloadImages")).toHaveLength(0);
});

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// Sessions per (window, cluster) (ADR 0007, #333): every cluster-scoped
// command names the cluster the window shows, and a switch makes the next
// commands name the new one. `fake.calls` leaves `cluster` out, so these
// tests record it from the IPC calls themselves.

const contextSelect = (page: Page) => page.getByRole("combobox", { name: "Cluster context" });

type Internals = { __TAURI_INTERNALS__: { invoke: (...a: unknown[]) => Promise<unknown> } };

/** Record `[command, cluster]` of every IPC call from now on. */
async function recordClusters(page: Page) {
  await page.evaluate(() => {
    const internals = (window as unknown as Internals).__TAURI_INTERNALS__;
    const invoke = internals.invoke;
    const seen: [string, unknown][] = [];
    (window as unknown as { __clusters: typeof seen }).__clusters = seen;
    internals.invoke = (cmd: unknown, args: unknown, ...rest: unknown[]) => {
      seen.push([String(cmd), (args as { cluster?: unknown } | undefined)?.cluster]);
      return invoke(cmd, args, ...rest);
    };
  });
}

/** The clusters named by `cmd` since `recordClusters`. */
function clustersOf(page: Page, cmd: string): Promise<unknown[]> {
  return page.evaluate(
    (c) =>
      (window as unknown as { __clusters: [string, unknown][] }).__clusters
        .filter(([name]) => name === c)
        .map(([, cluster]) => cluster),
    cmd,
  );
}

test("commands name the cluster the window shows, before and after a switch", async ({ page }) => {
  const fake = await openApp(page);
  await recordClusters(page);
  await contextSelect(page).selectOption("prod");
  await expect.poll(async () => (await fake.calls("cmdSetContext")).length).toBe(1);
  // The switch is asked of the cluster shown until then.
  expect(await clustersOf(page, "cmd_set_context")).toEqual(["kind-dev"]);
  // Everything after it goes to prod, the contexts reload included.
  await expect.poll(() => clustersOf(page, "cmd_list_namespaces")).toContain("prod");
  await openKind(page, "Pods");
  await expect(row(page, "web-1")).toBeVisible();
  expect(await clustersOf(page, "cmd_list_contexts")).toEqual(["prod"]);
  const watched = await clustersOf(page, "cmd_watch_start");
  expect(watched.length).toBeGreaterThan(0);
  expect(new Set(watched)).toEqual(new Set(["prod"]));
  expect(fake.errors).toEqual([]);
});

test("switching A -> B -> A starts the first cluster over", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await expect(row(page, "web-1")).toBeVisible();
  await recordClusters(page);

  await contextSelect(page).selectOption("prod");
  await expect(contextSelect(page)).toHaveValue("prod");
  await expect.poll(() => clustersOf(page, "cmd_list_namespaces")).toContain("prod");
  await contextSelect(page).selectOption("kind-dev");
  await expect(contextSelect(page)).toHaveValue("kind-dev");
  await expect.poll(async () => (await fake.calls("cmdSetContext")).map((c) => c.name)).toEqual(["prod", "kind-dev"]);
  expect(await clustersOf(page, "cmd_set_context")).toEqual(["kind-dev", "prod"]);

  // Back on kind-dev, its commands name it again and its view works.
  await openKind(page, "Pods");
  await expect(row(page, "web-1")).toBeVisible();
  expect((await clustersOf(page, "cmd_watch_start")).at(-1)).toBe("kind-dev");
  expect(fake.errors).toEqual([]);
});

test("the cluster commands have fake handlers", async ({ page }) => {
  const fake = await openApp(page);
  await page.evaluate(async () => {
    const invoke = (window as unknown as Internals).__TAURI_INTERNALS__.invoke;
    await invoke("cmd_cluster_connect", { cluster: "prod" });
    await invoke("cmd_cluster_disconnect", { cluster: "prod" });
  });
  expect(await fake.calls("cmdClusterConnect")).toEqual([{}]);
  expect(await fake.calls("cmdClusterDisconnect")).toEqual([{}]);
});

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { column, openApp, openKind, row, toggleNamespaces } from "./helpers";

/** The number on the overview card labelled `label`. */
function card(page: Page, label: string) {
  return page.locator(".card", { has: page.getByText(label, { exact: true }) }).locator(".num");
}

test("the overview counts a crash-looping pod as an error, not as running", async ({ page }) => {
  await openApp(page);
  await expect(card(page, "Pods")).toHaveText("5");
  await expect(card(page, "Running")).toHaveText("3");
  await expect(card(page, "Pending")).toHaveText("1");
  await expect(card(page, "Errors")).toHaveText("1");
  await expect(page.locator(".card.alert")).toHaveCount(1);
  await expect(card(page, "Nodes ready")).toHaveText("2/2");

  const problems = page.getByRole("region", { name: "Problem pods" });
  await expect(problems.getByRole("button")).toHaveText(["demo/crashed", "demo/db-0"]);
  await expect(problems).toContainText("CrashLoopBackOff");
  await expect(problems).toContainText("12 restarts");
  await expect(problems).toContainText("Pending for 60m");
});

test("a running pod whose container failed reads Error in the overview, as in the Pods table (#263)", async ({ page }) => {
  const fake = await openApp(page);
  const created = Math.floor(Date.now() / 1000) - 600;
  // What the backend sends for it: STATUS "Error" as the problem, not "Not ready".
  await fake.emitOverview({
    pods: {
      namespace: null,
      total: 6,
      running: 4,
      pending: 1,
      succeeded: 0,
      failed: 0,
      waiting_errors: 1,
      by_namespace: [
        ["demo", 5],
        ["kube-system", 1],
      ],
      problems: [
        {
          namespace: "demo",
          name: "crashed",
          status: "CrashLoopBackOff",
          reason: "CrashLoopBackOff",
          restarts: 12,
          created,
        },
        { namespace: "demo", name: "db-0", status: "Pending", reason: "Pending for 60m", restarts: 0, created },
        { namespace: "demo", name: "half-failed", status: "Error", reason: "Error", restarts: 0, created },
      ],
      problems_total: 3,
    },
  });
  const problems = page.getByRole("region", { name: "Problem pods" });
  const entry = problems.locator(".problem", { has: page.getByRole("button", { name: "demo/half-failed" }) });
  await expect(entry.locator(".reason")).toHaveText("Error");
  await expect(entry.locator(".reason")).toHaveClass(/error/);
  await expect(problems).not.toContainText("Not ready");

  await entry.getByRole("button", { name: "demo/half-failed" }).click();
  await expect(row(page, "crashed")).toBeVisible();
  await fake.emitWatchBatch({ applied: [fake.podRow("demo", "half-failed", "Error", "0", "Error")] });
  await expect(row(page, "half-failed")).toHaveAttribute("data-problem", "Error");
  const names = await column(page, "Name");
  expect((await column(page, "Status"))[names.indexOf("half-failed")]).toBe("Error");
});

test("the overview is pushed by the backend, not polled", async ({ page }) => {
  const fake = await openApp(page);
  await expect(page.locator("header")).toContainText("Live");
  await expect(card(page, "Pods")).toHaveText("5");
  expect(await fake.calls("cmdOverviewStart")).toHaveLength(1);
  expect((await fake.lastCall("cmdOverviewStart")).namespace).toBeNull();

  // A change arrives as an event and shows up without a new request.
  await fake.emitOverview({ namespaces: 4 });
  await expect(card(page, "Namespaces")).toHaveText("4");
  await page.waitForTimeout(1500);
  expect(await fake.calls("cmdOverviewStart")).toHaveLength(1);

  // Updates of a stopped feed are ignored.
  await fake.emitOverview({ namespaces: 9 }, 12345);
  await expect(card(page, "Namespaces")).toHaveText("4");

  // A failing watch says so; the next live state clears it.
  await fake.emitOverviewState({ state: "reconnecting", error: "Lost the connection to the cluster; retrying." });
  await expect(page.locator("header")).toContainText("Reconnecting");
  await expect(page.getByRole("alert")).toContainText("Lost the connection to the cluster; retrying.");
  await fake.emitOverviewState({ state: "live" });
  await expect(page.locator("header")).toContainText("Live");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("coming back to the overview starts one new feed in the current namespace", async ({ page }) => {
  const fake = await openApp(page);
  await expect(card(page, "Pods")).toHaveText("5");
  // The namespace control is in the toolbar of the table views.
  await openKind(page, "Pods");
  await toggleNamespaces(page, "demo");
  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  await expect(card(page, "Pods")).toHaveText("5");
  // One start per visit, each stopped when leaving.
  expect(await fake.calls("cmdOverviewStart")).toHaveLength(2);
  expect((await fake.lastCall("cmdOverviewStart")).namespace).toBe("demo");
  expect(await fake.overviewFeeds()).toEqual([await fake.lastOverviewId()]);
});

test("leaving the overview stops its feed", async ({ page }) => {
  const fake = await openApp(page);
  await expect(card(page, "Pods")).toHaveText("5");
  const id = await fake.lastOverviewId();
  await openKind(page, "Deployments");
  await expect.poll(async () => (await fake.calls("cmdOverviewStop")).map((c) => c.id)).toEqual([id]);
  expect(await fake.overviewFeeds()).toEqual([]);
});

test("capacity shows requests and usage against allocatable", async ({ page }) => {
  await openApp(page);
  const capacity = page.getByRole("region", { name: "Capacity" });
  await expect(capacity).toContainText("1.2 / 8 requested (15%)");
  await expect(capacity).toContainText("900m used (11%)");
  await expect(capacity).toContainText("3Gi / 16Gi requested (19%)");
  await expect(capacity).toContainText("4 / 220 (2%)");
  await expect(capacity.getByRole("meter", { name: "CPU" })).toHaveAttribute("aria-valuenow", "15");
});

test("a problem pod opens in the Pods view", async ({ page }) => {
  const fake = await openApp(page);
  await page.getByRole("region", { name: "Problem pods" }).getByRole("button", { name: "demo/crashed" }).click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toHaveClass(/active/);
  await expect
    .poll(async () => (await fake.calls("cmdGetResourceDetail")).at(-1))
    .toEqual({ resource: expect.objectContaining({ kind: "Pod" }), namespace: "demo", name: "crashed" });
});

test("warnings come first and link to their objects", async ({ page }) => {
  const fake = await openApp(page);
  const warnings = page.getByRole("region", { name: "Warnings" });
  await expect(warnings.locator(".event")).toHaveCount(2);
  await expect(warnings.locator(".event").first()).toContainText("FailedCreate");
  await expect(warnings.locator(".event").first()).toContainText("2m");
  await expect(warnings).toContainText("exceeded quota (x4)");
  // A kind discovery does not know is not a link.
  await expect(warnings.getByText("Gadget/thing")).toBeVisible();
  await expect(warnings.getByRole("button", { name: "Gadget/thing" })).toHaveCount(0);

  await warnings.getByRole("button", { name: "Deployment/api" }).click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Deployments", exact: true })).toHaveClass(
    /active/,
  );
  await expect.poll(async () => (await fake.calls("cmdGetResourceDetail")).at(-1)?.name).toBe("api");
});

test("metrics are fetched only for what the table shows", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await expect.poll(async () => (await fake.calls("cmdGetMetrics")).at(-1)).toEqual({ namespace: null, what: "pods" });
  await toggleNamespaces(page, "demo");
  await expect.poll(async () => (await fake.calls("cmdGetMetrics")).at(-1)).toEqual({ namespace: "demo", what: "pods" });
  await openKind(page, "Nodes");
  await expect.poll(async () => (await fake.calls("cmdGetMetrics")).at(-1)).toEqual({ namespace: null, what: "nodes" });
});

test("a failed start is reported and retried", async ({ page }) => {
  const fake = await openApp(page, (_cluster, f) => f.failNext("cmdOverviewStart", "Cannot reach the cluster at x"));
  await expect(page.getByRole("alert")).toContainText("Cannot reach the cluster at x");
  await expect(page.locator("header")).toContainText("Cluster unreachable");
  await expect.poll(async () => (await fake.calls("cmdOverviewStart")).length, { timeout: 10_000 }).toBe(2);
  await expect(card(page, "Pods")).toHaveText("5");
  await expect(page.locator("header")).toContainText("Live");
});

test("no kubeconfig at all says so and what to do, not that the cluster is unreachable", async ({ page }) => {
  await openApp(page, (_cluster, f) =>
    f.failNext("cmdOverviewStart", "No kubeconfig found (looked at /home/me/.kube/config; KUBECONFIG is not set)."),
  );
  const alert = page.getByRole("alert");
  await expect(alert).toContainText("No kubeconfig found (looked at /home/me/.kube/config; KUBECONFIG is not set).");
  await expect(alert).toContainText("Open the cluster catalog");
  await expect(alert).not.toContainText("Could not reach the cluster");
  await expect(page.locator("header")).toContainText("No kubeconfig");
});

test("a scoped Pods card keeps its label on one line, with the full text as its title", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.overview.pods!.namespace = "team-a-with-a-much-longer-namespace-name-than-fits-on-one-card";
  });
  const pods = page.locator(".card", { hasText: "Pods in team-a" });
  await expect(pods).toHaveAttribute("title", "Pods in team-a-with-a-much-longer-namespace-name-than-fits-on-one-card");
  const label = await pods.locator(".label").evaluate((el) => ({
    height: el.getBoundingClientRect().height,
    clipped: el.scrollWidth > el.clientWidth,
  }));
  expect(label.height).toBeLessThan(20);
  expect(label.clipped).toBe(true);
});

test("a scoped Pods card is wide enough for a short namespace", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.overview.pods!.namespace = "team-a";
  });
  const label = page.locator(".card .label", { hasText: "Pods in team-a" });
  await expect(label).toBeVisible();
  expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(false);
});

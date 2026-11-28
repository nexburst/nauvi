import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { column, openApp, openKind, row, rows, toggleNamespaces } from "./helpers";

// Workloads → Overview (#79): live status counts per kind from the fake
// cluster's rows (fixtures/workloads.ts), clickable to filtered tables, and
// the aggregated usage charts of workload panels.

const view = (page: Page) => page.getByTestId("workloads-overview");
const card = (page: Page, kind: string) => view(page).locator(`.card[data-kind="${kind}"]`);
const count = (page: Page, kind: string, status: string) =>
  card(page, kind).locator(`button[data-status="${status}"] .count`);

async function openWorkloads(page: Page) {
  await page.getByRole("navigation").getByRole("button", { name: "Workloads overview" }).click();
  await expect(view(page).locator(".card").first()).toBeVisible();
}

test("the workloads overview counts every kind by status", async ({ page }) => {
  const fake = await openApp(page);
  await openWorkloads(page);
  await expect(page.locator("header")).toContainText("Live");
  // Pods: web-1, web-2, coredns-1 running; db-0 pending; crashed errors.
  await expect(card(page, "Pod").locator(".total")).toHaveText("5");
  await expect(count(page, "Pod", "Running")).toHaveText("3");
  await expect(count(page, "Pod", "Pending")).toHaveText("1");
  await expect(count(page, "Pod", "Error")).toHaveText("1");
  await expect(card(page, "Pod")).toHaveClass(/alert/);
  // Deployments: web 2/2, api 1/3.
  await expect(count(page, "Deployment", "Running")).toHaveText("1");
  await expect(count(page, "Deployment", "Pending")).toHaveText("1");
  await expect(count(page, "Job", "Failed")).toHaveText("1");
  await expect(count(page, "Job", "Succeeded")).toHaveText("1");
  await expect(count(page, "CronJob", "Suspended")).toHaveText("1");
  // Every workload kind, in sidebar order.
  await expect(view(page).locator(".card .name")).toHaveText([
    "Pods",
    "Deployments",
    "DaemonSets",
    "StatefulSets",
    "ReplicaSets",
    "Jobs",
    "CronJobs",
  ]);
  // A zero count opens nothing.
  await expect(card(page, "StatefulSet").locator('button[data-status="Running"]')).toBeDisabled();

  const problems = view(page).getByRole("region", { name: "Problem workloads" });
  await expect(problems.locator(".problem")).toHaveCount(3);
  await expect(problems.locator(".problem").first()).toContainText("demo/migrate");
  await expect(problems).toContainText("1 of 3 ready");
  await expect(problems).toContainText("Suspended");
  const warnings = view(page).getByRole("region", { name: "Warning groups" });
  // The Deployment's warning, not the one about an unknown kind.
  await expect(warnings.locator(".event")).toHaveCount(1);
  await expect(warnings).toContainText("Failed to create");
  // The Overview's deck (#606): how many need a look, all listed.
  await expect(view(page).getByTestId("deck-headline")).toHaveText("3 workloads need a look");
  await expect(view(page).getByTestId("deck-kicker")).toHaveText("kind-dev · all namespaces");
  await expect(view(page).getByTestId("problem-workloads-count")).toHaveText("3");
  await expect(view(page).getByTestId("see-all-workloads")).toHaveCount(0);

  expect(await fake.workloadsFeeds()).toEqual([{ id: expect.any(Number), namespaces: [] }]);
});

test("counts update live, pushed by the backend", async ({ page }) => {
  const fake = await openApp(page);
  await openWorkloads(page);
  await expect(count(page, "Deployment", "Running")).toHaveText("1");
  // api becomes ready.
  await fake.setCluster((cluster) => {
    const api = cluster.rows["apps/v1/deployments"].find((r) => r.name === "api")!;
    api.status = "Running";
  }, null);
  await fake.emitWorkloads();
  await expect(count(page, "Deployment", "Running")).toHaveText("2");
  await expect(count(page, "Deployment", "Pending")).toHaveText("0");
  expect(await fake.calls("cmdWorkloadsStart")).toHaveLength(1);
});

test("the overview follows the namespace selection, one feed at a time", async ({ page }) => {
  const fake = await openApp(page);
  await openWorkloads(page);
  await expect(card(page, "Pod").locator(".total")).toHaveText("5");
  await toggleNamespaces(page, "kube-system");
  await expect(card(page, "Pod").locator(".total")).toHaveText("1");
  await expect(card(page, "Deployment").locator(".total")).toHaveText("0");
  await expect(view(page).getByTestId("deck-kicker")).toHaveText("kind-dev · namespace kube-system");
  // Nothing to look at: calm, and the empty states.
  await expect(view(page).getByTestId("deck-headline")).toHaveText("No workload problems in kind-dev");
  await expect(view(page).getByRole("region", { name: "Problem workloads" })).toContainText("None.");
  await expect(view(page).getByRole("region", { name: "Warning groups" })).toContainText("No warnings.");
  expect((await fake.lastCall("cmdWorkloadsStart")).namespaces).toEqual(["kube-system"]);
  // The previous feed was stopped.
  const feeds = await fake.workloadsFeeds();
  expect(feeds).toHaveLength(1);
  expect(feeds[0].namespaces).toEqual(["kube-system"]);

  // Leaving the view stops its feed.
  await openKind(page, "Pods");
  await expect.poll(() => fake.workloadsFeeds()).toEqual([]);
});

test("each feed has its own channel: a stopped feed's messages are ignored (#115)", async ({ page }) => {
  const fake = await openWorkloads2(page);
  const [first] = await fake.workloadsFeeds();
  expect((await fake.lastCall("cmdWorkloadsStart")).onEvent).toBeDefined();
  await toggleNamespaces(page, "kube-system");
  await expect(card(page, "Pod").locator(".total")).toHaveText("1");
  // The old feed (all namespaces: 5 pods) still sends: nothing changes.
  await fake.emitWorkloads(first.id);
  await fake.emitFeedState("workloads", { id: first.id, state: "reconnecting", error: "old feed" });
  await expect(card(page, "Pod").locator(".total")).toHaveText("1");
  await expect(page.locator("header")).toContainText("Live");
  // The running feed's state does show.
  await fake.emitFeedState("workloads", { state: "reconnecting", error: "Lost the connection to the cluster; retrying." });
  await expect(page.locator("header")).toContainText("Reconnecting");
  await fake.emitFeedState("workloads", { state: "live" });
  await expect(page.locator("header")).toContainText("Live");
});

async function openWorkloads2(page: Page) {
  const fake = await openApp(page);
  await openWorkloads(page);
  await expect(card(page, "Pod").locator(".total")).toHaveText("5");
  return fake;
}

test("a status count opens the kind's table filtered by that status", async ({ page }) => {
  await openApp(page);
  await openWorkloads(page);
  await card(page, "Pod").locator('button[data-status="Running"]').click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toHaveClass(/active/);
  await expect(page.getByTestId("status-filter")).toContainText("Status: Running");
  await expect(rows(page)).toHaveCount(3);
  expect(await column(page, "Name")).toEqual(["web-1", "web-2", "coredns-1"]);

  // Clearing the filter shows every pod.
  await page.getByRole("button", { name: "Show every status" }).click();
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByTestId("status-filter")).toHaveCount(0);

  // Another view drops the filter too.
  await openWorkloads(page);
  await card(page, "Deployment").locator('button[data-status="Pending"]').click();
  await expect(rows(page)).toHaveCount(1);
  await expect(row(page, "api")).toBeVisible();
  await openKind(page, "Deployments");
  await expect(page.getByTestId("status-filter")).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2);
});

test("with 41 failing Deployments the Workloads overview fits one screen; See all opens the rest (#606)", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const fake = await openApp(page, (cluster) => {
    // Only the failing Deployments: no failed Job or suspended CronJob.
    cluster.rows["batch/v1/jobs"] = cluster.rows["batch/v1/jobs"].filter((r) => r.status !== "Failed");
    cluster.rows["batch/v1/cronjobs"] = cluster.rows["batch/v1/cronjobs"].filter((r) => r.status !== "Suspended");
    const deployments = cluster.rows["apps/v1/deployments"];
    const api = deployments.find((r) => r.name === "api")!;
    const ready = cluster.kinds.find((k) => k.id === "apps/v1/deployments")!.columns.findIndex((c) => c.key === "ready");
    const uid = "3f2a9c1e-0b4d-4e5f-8a6b-7c8d9e0f1a2b";
    const events = cluster.overview.events!.items;
    for (let i = 0; i < 40; i++) {
      const name = `payments-worker-${i}`;
      const cells = [...api.cells];
      cells[ready] = `0/${(i % 7) + 2}`;
      deployments.push({ ...api, name, namespace: "payments", cells, status: "Pending", problem: "not ready" });
      // Two crash-looping pods each, with the kubelet's pod UIDs.
      for (const pod of ["a", "b"]) {
        events.push({
          key: `payments/${name}-${pod}`,
          kind: "Warning",
          reason: "BackOff",
          message: `Back-off restarting failed container app in pod ${name}-${pod}_payments(${uid})`,
          object: `Pod/${name}-${pod}`,
          object_api_version: "v1",
          object_kind: "Pod",
          object_namespace: "payments",
          object_name: `${name}-${pod}`,
          time: Math.floor(Date.now() / 1000) - 60 * i,
          count: 212 - i,
          owner_kind: "Deployment",
          owner_name: name,
        });
      }
    }
  });
  await openWorkloads(page);
  const problems = view(page).getByRole("region", { name: "Problem workloads" });
  const warnings = view(page).getByRole("region", { name: "Warning groups" });
  await expect(view(page).getByTestId("deck-headline")).toHaveText("41 workloads need a look");
  await expect(problems.getByTestId("problem-workload")).toHaveCount(5);
  await expect(view(page).getByTestId("problem-workloads-count")).toHaveText("41");
  await expect(warnings.getByTestId("warning-group")).toHaveCount(5);
  // The most pods affected first: five of the 40 want 8 replicas.
  for (const row of await problems.getByTestId("problem-workload").all()) await expect(row).toContainText("0 of 8 ready");
  // One line per Deployment's pods, the Overview's words, no pod UIDs, and
  // none about a listed problem's pods.
  const first = warnings.getByTestId("warning-group").first();
  await expect(first).toContainText("Back-off restarting");
  await expect(first).toContainText(/2 pods of Deployment payments-worker-\d+/);
  await expect(first).toContainText(/\d+×/);
  await expect(warnings).not.toContainText("3f2a9c1e");
  const listed = await problems.getByTestId("problem-workload").locator(".name").allTextContents();
  const warned = (await warnings.locator(".object").allTextContents()).map((t) => t.split(" ").at(-1));
  for (const name of listed) expect(warned).not.toContain(name.split("/")[1]);
  await expect(view(page).getByTestId("see-all-warnings")).toBeVisible();

  const sizes = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="workloads-overview"]')!;
    const h = (s: string) => Array.from(el.querySelectorAll(s), (e) => Math.round(e.getBoundingClientRect().height));
    const css = (s: string) => getComputedStyle(el.querySelector(s)!);
    return {
      scroll: el.scrollHeight,
      client: el.clientHeight,
      problems: h('[data-testid="problem-workload"]'),
      warnings: h('[data-testid="warning-group"]'),
      headTransform: css(".sec-head h3").textTransform,
      headSize: css(".sec-head h3").fontSize,
      headline: css('[data-testid="deck-headline"]').fontSize,
      warningBorder: css('[data-testid="warning-group"]').borderLeftWidth,
    };
  });
  console.log(`#606 Workloads overview scrollHeight with 41 failing Deployments at 1280x800: ${sizes.scroll}px`);
  expect(sizes.scroll).toBeLessThanOrEqual(sizes.client);
  for (const r of sizes.problems) expect(r).toBe(32);
  for (const r of sizes.warnings) expect(r).toBeLessThanOrEqual(37);
  expect(sizes.headTransform).toBe("none");
  expect(sizes.headSize).toBe("15px");
  expect(sizes.headline).toBe("26px");
  expect(sizes.warningBorder).toBe("0px");

  // Every problem is one kind: one link, to its table filtered to problems.
  await expect(view(page).getByTestId("see-all-workloads")).toHaveText("See all 41 →");
  await view(page).getByTestId("see-all-workloads").click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Deployments", exact: true })).toHaveClass(
    /active/,
  );
  await expect(page.getByTestId("status-filter")).toContainText("Status: needs attention");
  expect(await fake.calls("cmdWorkloadsStart")).toHaveLength(1);
});

test("problems of several kinds: See all links each kind's table (#606)", async ({ page }) => {
  await openApp(page, (cluster) => {
    const deployments = cluster.rows["apps/v1/deployments"];
    const api = deployments.find((r) => r.name === "api")!;
    for (let i = 0; i < 6; i++) deployments.push({ ...api, name: `api-${i}` });
  });
  await openWorkloads(page);
  // 7 Deployments, the failed Job and the suspended CronJob.
  await expect(view(page).getByTestId("deck-headline")).toHaveText("9 workloads need a look");
  const seeAll = view(page).getByTestId("see-all-workloads");
  await expect(seeAll).toHaveText(/^See all 9:\s*7 Deployments →\s*1 Job →\s*1 CronJob →$/);
  await seeAll.getByRole("button", { name: "1 CronJob →" }).click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "CronJobs", exact: true })).toHaveClass(/active/);
  await expect(page.getByTestId("status-filter")).toContainText("Status: Suspended");
  await expect(rows(page)).toHaveCount(1);
});

test("a feed that cannot start shows the out-of-reach state, not Loading (#606)", async ({ page }) => {
  await openApp(page, (_cluster, f) => f.failNext("cmdWorkloadsStart", "Cannot reach the cluster for `kind-dev`"));
  await page.getByRole("navigation").getByRole("button", { name: "Workloads overview" }).click();
  await expect(view(page).getByTestId("out-of-reach")).toBeVisible();
  await expect(view(page)).not.toContainText("Loading");
});

test("a problem workload opens its detail panel", async ({ page }) => {
  await openApp(page);
  await openWorkloads(page);
  await view(page).getByRole("button", { name: "demo/api" }).click();
  await expect(page.getByTestId("detail-panel")).toContainText("Deployment demo/api");
});

test("a workload panel charts its pods' summed usage, from both sources", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Deployments");
  await row(page, "web").click();
  const charts = page.getByTestId("detail-panel").getByTestId("usage-charts");
  // No Prometheus: the metrics-server history, with why.
  await expect(charts.getByTestId("usage-since")).toHaveText(/^Collecting since/);
  await expect(charts.getByTestId("usage-note")).toContainText("No Prometheus Service found");
  const cpu = charts.getByTestId("usage-chart-cpu");
  await expect(cpu.locator('polyline[data-series="pods"]')).toHaveCount(1);
  await expect(cpu.getByTestId("ref-request")).toHaveText("request 200m");
  const mem = charts.getByTestId("usage-chart-memory");
  await expect(mem.getByTestId("ref-limit")).toHaveText("limit 256 MiB");
  expect(await fake.lastCall("cmdWorkloadUsageHistory")).toEqual({
    kind: "Deployment",
    namespace: "demo",
    name: "web",
    range: "1h",
  });
});

test("with Prometheus, a workload panel charts its 1h range", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => window.__fake.installPrometheus());
  await openKind(page, "Deployments");
  await row(page, "web").click();
  const charts = page.getByTestId("detail-panel").getByTestId("usage-charts");
  await expect(charts.getByTestId("usage-source")).toHaveText(
    "From Prometheus (monitoring/prometheus-k8s:web), last 1h.",
  );
  await expect(charts.getByRole("button", { name: "24h" })).toBeVisible();
  // A workload without Prometheus series falls back to the live history.
  await page.getByTestId("detail-panel").getByRole("button", { name: "Close details" }).click();
  await row(page, "api").click();
  // No samples either way: one line, with why in its tooltip (#513).
  await expect(page.getByTestId("detail-panel").getByTestId("usage-empty")).toHaveAttribute(
    "title",
    /no CPU and memory samples for the pods of this Deployment in the last 1h/,
  );
});

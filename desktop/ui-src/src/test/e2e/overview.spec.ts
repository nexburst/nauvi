import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { column, openApp, openKind, row, toggleNamespaces } from "./helpers";
import { manyProblems, problemGroups, warning } from "../fixtures/overview";

/** The owner fields of a pod without one. */
const lone = { owner_kind: "", owner_name: "" };

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

  const problems = page.getByRole("region", { name: "Problem groups" });
  await expect(problems.locator(".problem .name")).toHaveText(["crashed", "db-0"]);
  await expect(problems).toContainText("CrashLoopBackOff");
  await expect(problems).toContainText("12 restarts");
  await expect(problems).toContainText("Pending for 1h");
});

test("a running pod whose container failed reads Error in the overview, as in the Pods table (#263)", async ({
  page,
}) => {
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
          ...lone,
        },
        {
          namespace: "demo",
          name: "db-0",
          status: "Pending",
          reason: "Pending for 1h",
          restarts: 0,
          created,
          ...lone,
        },
        {
          namespace: "demo",
          name: "half-failed",
          status: "Error",
          reason: "Error",
          restarts: 0,
          created,
          ...lone,
        },
      ],
      problems_total: 3,
      ...problemGroups([
        {
          namespace: "demo",
          name: "half-failed",
          status: "Error",
          reason: "Error",
          restarts: 0,
          created,
          ...lone,
        },
      ]),
    },
  });
  const problems = page.getByRole("region", { name: "Problem groups" });
  const entry = problems.locator(".problem", {
    has: page.getByRole("button", { name: "demo/half-failed", exact: true }),
  });
  await expect(entry.locator(".reason")).toHaveText("Error");
  await expect(entry).toHaveClass(/error/);
  await expect(problems).not.toContainText("Not ready");

  await entry.getByRole("button", { name: "demo/half-failed", exact: true }).click();
  await expect(row(page, "crashed")).toBeVisible();
  await fake.emitWatchBatch({
    applied: [fake.podRow("demo", "half-failed", "Error", "0", "Error")],
  });
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
  await fake.emitOverviewState({
    state: "reconnecting",
    error: "Lost the connection to the cluster; retrying.",
  });
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
  await expect(capacity).toContainText("3 GiB / 16 GiB requested (19%)");
  await expect(capacity).toContainText("4 / 220 (2%)");
  await expect(capacity.getByRole("meter", { name: "CPU" })).toHaveAttribute("aria-valuenow", "15");
});

test("a problem pod opens in the Pods view", async ({ page }) => {
  const fake = await openApp(page);
  await page
    .getByRole("region", { name: "Problem groups" })
    .getByRole("button", { name: "demo/crashed", exact: true })
    .click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toHaveClass(/active/);
  await expect
    .poll(async () => (await fake.calls("cmdGetResourceDetail")).at(-1))
    .toEqual({
      resource: expect.objectContaining({ kind: "Pod" }),
      namespace: "demo",
      name: "crashed",
    });
});

test("warnings come first and link to their objects", async ({ page }) => {
  const fake = await openApp(page);
  const warnings = page.getByRole("region", { name: "Warning groups" });
  await expect(warnings.locator(".event")).toHaveCount(2);
  // The reason in words, the raw one on hover; how often and when (#484).
  const first = warnings.locator(".event").first();
  await expect(first).toContainText("Failed to create");
  await expect(first.locator(".reason")).toHaveAttribute("title", "FailedCreate");
  await expect(first).toContainText(/4× · 2m( \d+s)? ago/);
  // The message shows only expanded.
  await expect(warnings).not.toContainText("exceeded quota");
  await first.getByRole("button", { name: "Show the message" }).click();
  await expect(first.getByRole("button", { name: "Hide the message" })).toHaveAttribute("aria-expanded", "true");
  await expect(warnings).toContainText("exceeded quota");
  await expect(warnings).not.toContainText("(x4)");
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
  await expect
    .poll(async () => (await fake.calls("cmdGetMetrics")).at(-1))
    .toEqual({ namespace: "demo", what: "pods" });
  await openKind(page, "Nodes");
  await expect.poll(async () => (await fake.calls("cmdGetMetrics")).at(-1)).toEqual({ namespace: null, what: "nodes" });
});

test("a failed start is reported and retried", async ({ page }) => {
  const fake = await openApp(page, (_cluster, f) => f.failNext("cmdOverviewStart", "Cannot reach the cluster at x"));
  await expect(page.getByRole("alert")).toContainText("Cannot reach the cluster at x");
  await expect(page.locator("header")).toContainText("Cluster unreachable");
  await expect
    .poll(async () => (await fake.calls("cmdOverviewStart")).length, {
      timeout: 10_000,
    })
    .toBe(2);
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

test("a problem pod's card has its actions: Logs opens the dock, Describe the pod (#480)", async ({ page }) => {
  const fake = await openApp(page);
  const problems = page.getByRole("region", { name: "Problem groups" });
  const crashed = problems.locator(".problem", {
    has: page.getByRole("button", { name: "demo/crashed", exact: true }),
  });
  const pending = problems.locator(".problem", {
    has: page.getByRole("button", { name: "demo/db-0", exact: true }),
  });
  // A pending pod has no logs yet: only Describe.
  await expect(pending.locator(".actions").getByRole("button")).toHaveText(["Describe"]);
  await expect(crashed.locator(".actions").getByRole("button")).toHaveText(["Logs", "Describe"]);

  await crashed.getByRole("button", { name: "Logs of demo/crashed" }).click();
  await expect(page.getByTestId("dock").getByRole("tab")).toHaveText(["Logs: crashed"]);
  await expect.poll(async () => (await fake.calls("cmdStreamPodLogs")).at(-1)?.name).toBe("crashed");
  // Still on the Overview.
  await expect(page.getByTestId("deck-headline")).toBeVisible();

  await crashed.getByRole("button", { name: "Describe demo/crashed" }).click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toHaveClass(/active/);
  await expect
    .poll(async () => (await fake.calls("cmdGetResourceDetail")).at(-1))
    .toEqual({
      resource: expect.objectContaining({ kind: "Pod" }),
      namespace: "demo",
      name: "crashed",
    });
});

test("the stat cards carry an icon each; text is in the UI font, not mono (#480)", async ({ page }) => {
  await openApp(page);
  const cards = page.locator(".overview .card");
  // Failed 0 and Succeeded 0 are a muted line, not cards.
  await expect(cards).toHaveCount(6);
  await expect(page.getByTestId("quiet-counts")).toHaveText("Failed 0 · Succeeded 0");
  for (const card of await cards.all()) await expect(card.locator("svg.icon")).toHaveCount(1);
  const fonts = await page.evaluate(() =>
    [".overview .headline", ".overview .card .label", ".overview .card .num", ".overview h3"].map(
      (s) => getComputedStyle(document.querySelector(s)!).fontFamily,
    ),
  );
  for (const f of fonts) expect(f).not.toMatch(/Plex Mono|monospace/);
});

test("a calm cluster shows the calm headline and the empty states (#480)", async ({ page }) => {
  const fake = await openApp(page);
  await fake.emitOverview({
    pods: {
      namespace: null,
      total: 3,
      running: 3,
      pending: 0,
      succeeded: 0,
      failed: 0,
      waiting_errors: 0,
      by_namespace: [["demo", 3]],
      problems: [],
      problems_total: 0,
      groups: [],
      groups_total: 0,
    },
    events: { namespace: null, items: [] },
  });
  await expect(page.getByTestId("deck-headline")).toHaveText("No problems in kind-dev");
  await expect(page.getByTestId("deck-kicker")).toHaveText("kind-dev · all namespaces");
  await expect(page.locator(".overview .status-mark.calm")).toBeVisible();
  await expect(page.getByRole("region", { name: "Problem groups" })).toContainText("None.");
  await expect(page.getByRole("region", { name: "Warning groups" })).toContainText("No warnings.");
  await expect(page.getByTestId("see-all-problems")).toHaveCount(0);
  await expect(page.getByTestId("see-all-warnings")).toHaveCount(0);
  await expect(page.locator(".card.alert")).toHaveCount(0);
});

// #605: the Overview fits one screen however big the cluster.

/** The demo's pods of Deployment `web`: 18 crash-looping, 2 pending, of 20. */
function webProblems(created: number) {
  const pod = (i: number, status: string, reason: string, restarts: number) => ({
    namespace: "demo",
    name: `web-5d8f-${i}`,
    status,
    reason,
    restarts,
    created,
    owner_kind: "Deployment",
    owner_name: "web",
  });
  return [
    // The first restarted once: "1 restart".
    ...Array.from({ length: 18 }, (_, i) => pod(i, "CrashLoopBackOff", "CrashLoopBackOff", i === 0 ? 1 : 10)),
    pod(18, "Pending", "Pending for 1h", 0),
    pod(19, "Pending", "Pending for 2h", 0),
  ];
}

test("the crash-looping pods of one Deployment are one row, with their events inside (#605)", async ({ page }) => {
  const fake = await openApp(page);
  const created = Math.floor(Date.now() / 1000) - 3600;
  const problems = webProblems(created);
  const backOff = warning({
    key: "demo/web-5d8f-0.1",
    reason: "BackOff",
    message: "Back-off restarting failed container app in pod web-5d8f-0_demo(3f2a9c1e-0b4d-4e5f-8a6b-7c8d9e0f1a2b)",
    object_name: "web-5d8f-0",
    time: created + 3000,
    count: 40,
  });
  const base = (await page.evaluate(() => window.__fake.cluster.overview.pods))!;
  await fake.emitOverview({
    pods: {
      ...base,
      problems,
      problems_total: 20,
      ...problemGroups(problems, { "demo/Deployment/web": 20 }, [backOff]),
    },
    // The backend leaves the group's events out of the Warnings.
    events: { namespace: null, items: [] },
  });
  const region = page.getByRole("region", { name: "Problem groups" });
  const rows = region.locator(".problem");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("web");
  await expect(rows.nth(0)).toContainText("Deployment · demo");
  await expect(rows.nth(0)).toContainText("CrashLoopBackOff");
  await expect(rows.nth(0)).toContainText("18 of 20 pods · 171 restarts");
  await expect(rows.nth(1)).toContainText("Pending for 1h");
  await expect(rows.nth(1)).toContainText("2 of 20 pods");
  // One count: the groups. No "(x of y)".
  await expect(page.getByTestId("problem-groups-count")).toHaveText("2");
  await expect(region.locator("h3")).toHaveText("Problem groups");
  await expect(page.getByRole("region", { name: "Warning groups" })).toContainText("No warnings.");

  // The actions are always there, not only on hover.
  await expect(rows.nth(0).locator(".actions").getByRole("button")).toHaveText(["Logs", "Describe"]);
  await expect(rows.nth(0).getByRole("button", { name: "Describe demo/web" })).toBeVisible();
  // A pending group has no logs yet.
  await expect(rows.nth(1).locator(".actions").getByRole("button")).toHaveText(["Describe"]);

  // Expanded: its pods and the events left out of the Warnings, without the uid.
  const chevron = rows.nth(0).getByRole("button", { name: "Show the pods of demo/web" });
  await expect(chevron).toHaveAttribute("aria-expanded", "false");
  await chevron.click();
  const more = rows.nth(0).getByTestId("problem-group-pods");
  // The first ten; the rest are one link away.
  await expect(more.getByRole("button", { name: /^demo\/web-5d8f-\d+$/ })).toHaveCount(10);
  await expect(more).toContainText("And 8 more.");
  await expect(more).toContainText("CrashLoopBackOff · 1 restart");
  await expect(more).not.toContainText("1 restarts");
  await expect(more).toContainText("Back-off restarting");
  await expect(more).toContainText("in pod web-5d8f-0");
  await expect(more).not.toContainText("3f2a9c1e");

  // Logs of the workload: one merged tab.
  await rows.nth(0).locator(".actions").getByRole("button", { name: "Logs of demo/web" }).click();
  await expect(page.getByTestId("dock").getByRole("tab")).toHaveText(["Logs: deployment/web"]);
  // Describe opens the Deployment.
  await rows.nth(0).getByRole("button", { name: "Describe demo/web" }).click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Deployments", exact: true })).toHaveClass(
    /active/,
  );
  await expect.poll(async () => (await fake.calls("cmdGetResourceDetail")).at(-1)?.name).toBe("web");
});

test("with 166 problem pods the Overview fits one screen, and See all opens the rest (#605)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  // With a Prometheus, so the usage chart is drawn as on a real cluster.
  const fake = await openApp(page, (_cluster, f) => f.installPrometheus());
  const many = manyProblems();
  await fake.emitOverview({
    pods: many.pods,
    events: { namespace: null, items: many.events },
  });
  const region = page.getByRole("region", { name: "Problem groups" });
  await expect(region.locator(".problem")).toHaveCount(5);
  await expect(page.getByRole("region", { name: "Warning groups" }).locator(".event")).toHaveCount(5);
  await expect(page.getByTestId("problem-groups-count")).toHaveText("11");
  await expect(page.getByTestId("see-all-problems")).toHaveText("See all 166 problem pods →");
  await expect(page.locator(".namespaces tbody tr")).toHaveCount(5);
  await expect(page.getByTestId("namespaces-more")).toHaveText("35 more namespaces, 3920 pods");
  // One usage chart at a time; the switch shows the other.
  await expect(page.getByTestId("usage-chart-cpu")).toBeVisible();
  await expect(page.getByTestId("usage-chart-memory")).toBeHidden();
  await page.getByTestId("usage-show-memory").click();
  await expect(page.getByTestId("usage-chart-memory")).toBeVisible();
  await expect(page.getByTestId("usage-chart-cpu")).toBeHidden();
  await page.getByTestId("usage-show-cpu").click();

  const sizes = await page.evaluate(() => {
    const h = (s: string) =>
      Array.from(document.querySelectorAll(s), (e) => Math.round(e.getBoundingClientRect().height));
    const top = (s: string) => Math.round(document.querySelector(s)!.getBoundingClientRect().top);
    return {
      scroll: document.querySelector(".overview")!.scrollHeight,
      problems: h('[data-testid="problem-group"]'),
      warnings: h('[data-testid="warning-group"]'),
      cards: h(".overview .card"),
      capacity: top('section[aria-label="Capacity"]'),
    };
  });
  console.log(`#605 Overview scrollHeight with 166 problem pods at 1280x800: ${sizes.scroll}px`);
  expect(sizes.scroll).toBeLessThanOrEqual(1000);
  for (const r of sizes.problems) expect(r).toBeLessThanOrEqual(41);
  for (const r of sizes.warnings) expect(r).toBeLessThanOrEqual(37);
  for (const c of sizes.cards) expect(c).toBe(60);
  // Capacity is in the right column, on the first screen.
  expect(sizes.capacity).toBeLessThan(400);

  await page.getByTestId("see-all-problems").click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toHaveClass(/active/);
  await expect(page.getByTestId("status-filter")).toContainText("Status: needs attention");
});

test("a warning group is one line; See all warnings opens Events filtered to warnings (#605)", async ({ page }) => {
  const fake = await openApp(page);
  const now = Math.floor(Date.now() / 1000);
  const uid = "3f2a9c1e-0b4d-4e5f-8a6b-7c8d9e0f1a2b";
  const backOff = (i: number) =>
    warning({
      key: `payments/w${i}`,
      reason: "BackOff",
      message: `Back-off restarting failed container worker in pod payments-worker-${i}_payments(${uid})`,
      object: `Pod/payments-worker-${i}`,
      object_namespace: "payments",
      object_name: `payments-worker-${i}`,
      time: now - 1200 - i,
      count: 100 + i,
    });
  await fake.emitOverview({ events: { namespace: null, items: [backOff(0)] } });
  const warnings = page.getByRole("region", { name: "Warning groups" });
  const row = warnings.locator(".event");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveText(
    /^\s*Back-off restarting\s*·\s*Pod\/payments-worker-0\s*100× · (19|20)m( \d+s)? ago\s*$/,
  );
  await expect(row).toHaveAttribute("title", "Container worker keeps failing; restarting it after a delay");
  expect(await row.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThanOrEqual(37);
  await row.getByRole("button", { name: "Show the message" }).click();
  const message = row.getByTestId("warning-message");
  await expect(message).toContainText("Container worker keeps failing");
  await expect(message).toContainText("in pod payments-worker-0");
  await expect(message).not.toContainText(uid);

  // Three pods of one Deployment with one reason: one group.
  const owned = (i: number) => ({
    ...backOff(i),
    owner_kind: "Deployment",
    owner_name: "payments-worker",
  });
  await fake.emitOverview({
    events: { namespace: null, items: [owned(1), owned(2), owned(3)] },
  });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("3 pods of Deployment payments-worker");
  await expect(row).toContainText("306×");

  await page.getByTestId("see-all-warnings").click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Events", exact: true })).toHaveClass(/active/);
  await expect(page.getByTestId("status-filter")).toContainText("Status: Warning");
});

test("the alert cards open what they count (#605)", async ({ page }) => {
  const fake = await openApp(page);
  await fake.emitOverview({ nodes: { total: 2, ready: 1 } });
  await expect(page.locator(".card.alert", { hasText: "Nodes ready" })).toBeVisible();
  await page.locator(".card", { hasText: "Nodes ready" }).click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Nodes", exact: true })).toHaveClass(/active/);
  await expect(page.getByTestId("status-filter")).toContainText("Status: needs attention");

  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  await page.locator(".card", { hasText: "Errors" }).click();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toHaveClass(/active/);
  await expect(page.getByTestId("status-filter")).toContainText("Status: needs attention");
  await expect(row(page, "crashed")).toBeVisible();
  await expect(row(page, "web-1")).toHaveCount(0);

  await page.getByRole("navigation").getByRole("button", { name: "Overview", exact: true }).click();
  await page.locator(".card", { hasText: "Pending" }).click();
  await expect(page.getByTestId("status-filter")).toContainText("Status: Pending");
});

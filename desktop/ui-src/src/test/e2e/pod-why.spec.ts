import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// "Why it's failing" (#496): a failing pod's panel leads with the reason,
// and a link that selects a row scrolls it into view.

const panel = (page: Page) => page.getByTestId("detail-panel");
const why = (page: Page) => panel(page).getByTestId("pod-why");

test("a crash-looping pod's panel leads with why, with its logs a click away", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "crashed").click();
  await expect(why(page)).toBeInViewport();
  await expect(why(page).getByTestId("pod-why-headline")).toHaveText("Container app keeps running out of memory");
  await expect(why(page)).toContainText("Container app · CrashLoopBackOff");
  await expect(why(page).getByTestId("pod-why-last")).toHaveText("Last run exited with code 137 (OOMKilled), 3m ago");
  // The newest warning in words.
  await expect(why(page).getByTestId("pod-why-warning")).toContainText("Back-off restarting");
  await expect(why(page).getByTestId("pod-why-warning")).toContainText("Container app keeps failing");
  await expect(why(page).getByTestId("pod-why-warning")).toContainText("168 times");
  // It comes before the identity list.
  const whyBox = (await why(page).boundingBox())!;
  const metaBox = (await panel(page).locator("dl.meta").boundingBox())!;
  expect(whyBox.y).toBeLessThan(metaBox.y);
  await page.screenshot({ path: test.info().outputPath("crashed.png") });

  // A crash loop's log is the run that crashed: Logs, on that container.
  await expect(why(page).getByRole("button", { name: "Previous logs" })).toHaveCount(0);
  await why(page).getByRole("button", { name: "Logs", exact: true }).click();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(1);
  expect(await fake.lastCall("cmdStreamPodLogs")).toMatchObject({ container: "app", previous: false });
});

test("running again after a crash: Previous logs opens the run that crashed", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    const d = cluster.details["v1/pods|demo/crashed"];
    const c = d.pod.containers[0];
    c.state = { state: "running", reason: "", message: "", exit_code: 0, since: "5s" };
    c.ready = false;
  });
  await openKind(page, "Pods");
  await row(page, "crashed").click();
  await expect(why(page).getByTestId("pod-why-headline")).toHaveText("Container app ran out of memory and restarted");
  await why(page).getByRole("button", { name: "Previous logs" }).click();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(1);
  expect(await fake.lastCall("cmdStreamPodLogs")).toMatchObject({ container: "app", previous: true });
  await expect(page.getByTestId("dock").getByRole("checkbox", { name: "Previous" })).toBeChecked();
  // The ask is used up: a later tab of the pod (the row's Logs) starts as usual.
  await page.getByRole("button", { name: "Close Logs: crashed" }).click();
  await row(page, "crashed").hover();
  await row(page, "crashed").getByTestId("row-logs").click();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(2);
  expect(await fake.lastCall("cmdStreamPodLogs")).toMatchObject({ previous: false });
  await expect(page.getByTestId("dock").getByRole("checkbox", { name: "Previous" })).not.toBeChecked();
  await expect(page.getByTestId("dock").getByTestId("log-follow")).toHaveText("Following");
  // Previous logs again, then Logs, with the tab open.
  await why(page).getByRole("button", { name: "Previous logs" }).click();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(3);
  expect(await fake.lastCall("cmdStreamPodLogs")).toMatchObject({ previous: true });
  // Logs, with the tab open: back to the current run.
  await why(page).getByRole("button", { name: "Logs", exact: true }).click();
  await expect.poll(() => fake.calls("cmdStreamPodLogs")).toHaveLength(4);
  expect(await fake.lastCall("cmdStreamPodLogs")).toMatchObject({ container: "app", previous: false });
  await expect(page.getByTestId("dock").getByRole("checkbox", { name: "Previous" })).not.toBeChecked();
});

test("Events ↓ goes to the events, which follow the containers", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "crashed").click();
  await why(page).getByRole("button", { name: "Events (1) ↓" }).click();
  await expect(panel(page).locator("table.events")).toBeInViewport();
  // Before the conditions, in the panel's order (the smooth scroll may
  // still move both while they are measured).
  const before = await panel(page).evaluate((p) => {
    const e = p.querySelector("table.events")!;
    const c = p.querySelector("table.conditions")!;
    return !!(e.compareDocumentPosition(c) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(before).toBe(true);
});

test("a healthy pod has no why", async ({ page }) => {
  await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panel(page).locator("dl.meta")).toBeVisible();
  await expect(why(page)).toHaveCount(0);
});

test("an image that cannot be pulled: the image and the cause", async ({ page }) => {
  await openApp(page, (cluster) => {
    const d = cluster.details["v1/pods|demo/crashed"];
    d.pod.phase = "Pending";
    const c = d.pod.containers[0];
    c.image = "registry.invalid/inventory-api:1.2.3";
    c.restarts = 0;
    c.last_state = { state: "", reason: "", message: "", exit_code: 0, since: "" };
    c.state = {
      state: "waiting",
      reason: "ImagePullBackOff",
      message:
        'Back-off pulling image "registry.invalid/inventory-api:1.2.3": ErrImagePull: failed to pull and unpack image ' +
        '"registry.invalid/inventory-api:1.2.3": failed to resolve reference "registry.invalid/inventory-api:1.2.3": ' +
        "dial tcp: lookup registry.invalid on 10.96.0.10:53: no such host",
      exit_code: 0,
      since: "",
    };
    d.events = [
      {
        type: "Warning",
        reason: "BackOff",
        message: 'Back-off pulling image "registry.invalid/inventory-api:1.2.3"',
        count: 5,
        age: "20s",
        time: 0,
      },
    ];
  });
  await openKind(page, "Pods");
  await row(page, "crashed").click();
  await expect(why(page).getByTestId("pod-why-headline")).toHaveText(
    "Image registry.invalid/inventory-api:1.2.3 cannot be pulled: host registry.invalid not found",
  );
  await expect(why(page).getByTestId("pod-why-warning")).toContainText("Back-off pulling image");
  await expect(why(page).getByRole("button", { name: "Previous logs" })).toHaveCount(0);
});

test("a problem pod from the Overview is scrolled into view in a long table", async ({ page }) => {
  await openApp(page, (cluster) => {
    const pods = cluster.rows["v1/pods"];
    const crashed = pods.find((r) => r.name === "crashed")!;
    // 80 pods in a namespace that sorts first, so crashed is far down.
    for (let i = 0; i < 80; i++) {
      const name = `filler-${String(i).padStart(2, "0")}`;
      pods.push({
        ...crashed,
        key: `a-load/${name}`,
        name,
        namespace: "a-load",
        status: "Running",
        problem: "",
        cells: [name, "a-load", "1/1", "Running", "0", ...crashed.cells.slice(5)],
      });
    }
  });
  await page.getByRole("region", { name: "Problem groups" }).getByRole("button", { name: "demo/crashed", exact: true }).click();
  await expect(panel(page).locator(".title")).toHaveText("demo/crashed");
  // Wholly inside the table's scroller, not under its edge.
  const scroller = page.getByRole("grid").locator(".scroller");
  await expect(async () => {
    const r = (await row(page, "crashed").boundingBox())!;
    const s = (await scroller.boundingBox())!;
    expect(r.y).toBeGreaterThanOrEqual(s.y);
    expect(r.y + r.height).toBeLessThanOrEqual(s.y + s.height);
  }).toPass();
  await page.screenshot({ path: test.info().outputPath("scrolled.png") });
});

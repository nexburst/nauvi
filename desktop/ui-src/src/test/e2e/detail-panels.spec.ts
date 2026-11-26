import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { ResourceDetail } from "../../lib/bindings";
import { openApp, openKind, row } from "./helpers";
import type { Fake } from "./helpers";

const panel = (page: Page) => page.locator("aside");
const card = (page: Page, name: string) => panel(page).getByRole("region", { name: `Container ${name}` });
const actions = (page: Page) => panel(page).getByRole("toolbar", { name: "Actions" }).getByRole("button");

async function openPod(page: Page, name: string): Promise<Fake> {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, name).click();
  await expect(panel(page).locator(".title")).toHaveText(`demo/${name}`);
  // The panel subscribes to live updates once it has the first detail.
  await expect.poll(() => fake.activeDetailWatches()).toHaveLength(1);
  return fake;
}

/** The pod's current detail in the fake cluster, for building updates. */
function podDetail(fake: Fake, name: string): Promise<ResourceDetail> {
  return fake.page.evaluate((n) => window.__fake.cluster.details[`v1/pods|demo/${n}`], name);
}

test("the pod panel has the generic overview: owner, labels, annotations, conditions, events", async ({ page }) => {
  const fake = await openPod(page, "web-1");
  const p = panel(page);
  await expect(p.locator("dl.meta")).toContainText("Phase");
  await expect(p.locator("dd.phase-Running")).toHaveText("Running");
  for (const text of ["node-1", "10.244.0.12", "Burstable", "default", "uid-demo-web-1"]) {
    await expect(p.locator("dl.meta")).toContainText(text);
  }
  await expect(p.getByText("app=web")).toBeVisible();
  await expect(p.getByText("Annotations (1)")).toBeVisible();
  await expect(p.locator("table.conditions tbody tr")).toHaveCount(2);
  await expect(p.locator("table.events")).toContainText("Pulled");

  // The owner link opens the ReplicaSet in the generic panel.
  await p.getByRole("button", { name: "ReplicaSet/web-5d8f" }).click();
  await expect(panel(page).locator(".title")).toHaveText("ReplicaSet demo/web-5d8f");
  // Leaving the pod panel stopped its detail watch; the new panel has its own.
  await expect.poll(() => fake.activeDetailWatches()).toEqual(["detail-2"]);
  expect(fake.errors).toEqual([]);
});

test("container cards show state, resources, ports, probes, mounts and env names", async ({ page }) => {
  await openPod(page, "web-1");
  const kinds = panel(page).locator(".card .head");
  await expect(kinds).toHaveCount(3);
  await expect(card(page, "init-db")).toContainText("init");
  await expect(card(page, "init-db").getByTestId("container-state")).toContainText("Terminated: Completed (exit 0)");

  const app = card(page, "app");
  await expect(app.getByTestId("container-state")).toHaveText(/Running · started 1h ago/);
  await expect(app.getByTestId("container-state")).toHaveClass(/tone-ok/);
  await expect(app).toContainText(/Requests\s*cpu 100m · memory 64Mi/);
  await expect(app).toContainText(/Limits\s*memory 128Mi/);
  await expect(app).toContainText("8080/TCP");
  await expect(app).toContainText("53/UDP");
  await expect(app).toContainText("liveness http-get :8080/healthz delay=5s timeout=1s period=10s");
  // Only TCP ports can be forwarded.
  await expect(app.getByRole("button", { name: /^Forward port/ })).toHaveCount(1);

  await app.getByText("Mounts (2)").click();
  await expect(app).toContainText("/etc/nginx/conf.d");
  await expect(app).toContainText("from config · configmap nginx-conf (ro)");
  await app.getByText("Environment (2)").click();
  // The values are loaded when the list opens (#447, more in pod-env.spec.ts).
  await expect(app.locator('[data-testid="env-row"][data-name="DB_PASSWORD"]')).toContainText(
    "from Secret db-creds/password",
  );
  await expect(app.locator('[data-testid="env-row"][data-name="MODE"]')).toContainText("production");
});

test("the container summary shows command, args, env count and mount sources (#385)", async ({ page }) => {
  await openPod(page, "web-1");
  const app = card(page, "app");
  const summary = app.getByTestId("container-summary");
  await expect(summary).toContainText(/Image\s*nginx:1\.27/);
  await expect(app.getByTestId("container-command")).toHaveText("/docker-entrypoint.sh");
  // The env count, with how many come from Secrets: a reference, never a value.
  await expect(app.getByTestId("container-env")).toHaveText("2 variables (1 from a Secret)");
  await expect(app.getByTestId("container-mounts")).toContainText(
    "/var/run/secrets/kubernetes.io/serviceaccount ← projected (service account token) (ro)",
  );
  await expect(app.getByTestId("container-mounts")).toContainText("/etc/nginx/conf.d ← configmap nginx-conf (ro)");

  // Long args start folded to one line, with the whole text one click away.
  const args = app.getByTestId("container-args");
  const value = args.locator(".value");
  await expect(value).toHaveClass(/folded/);
  const folded = await value.boundingBox();
  await args.getByRole("button", { name: "Show all of args" }).click();
  await expect(value).not.toHaveClass(/folded/);
  await expect(args.getByRole("button", { name: "Fold args" })).toHaveAttribute("aria-expanded", "true");
  expect((await value.boundingBox())!.height).toBeGreaterThan(folded!.height);
  await expect(value).toHaveText(
    "nginx -g 'daemon off; worker_processes 2; error_log /dev/stderr info; pid /tmp/nginx.pid;' --token=••••",
  );
  await expect(app.getByTestId("secrets-hidden")).toBeVisible();

  // A container without command or args shows only the image's own.
  const sidecar = card(page, "sidecar");
  await expect(sidecar.getByTestId("container-command")).toHaveCount(0);
  await expect(sidecar.getByTestId("container-args")).toHaveCount(0);
  await expect(sidecar.getByTestId("secrets-hidden")).toHaveCount(0);
});

test("a port's Forward button starts a port-forward", async ({ page }) => {
  const fake = await openPod(page, "web-1");
  await card(page, "app").getByRole("button", { name: "Forward port 8080" }).click();
  await expect.poll(() => fake.calls("cmdPortforwardStart")).toHaveLength(1);
  expect(await fake.lastCall("cmdPortforwardStart")).toEqual({
    target: { kind: "pod", namespace: "demo", name: "web-1" },
    remotePort: "8080",
    localPort: null,
  });
  await expect(panel(page).getByText("Forwarding http://127.0.0.1:8080 → web-1:8080")).toBeVisible();
  await expect(panel(page).getByLabel("Pod port")).toHaveValue("8080");
});

test("a crash-looping container shows its reason in red and its last termination", async ({ page }) => {
  await openPod(page, "crashed");
  const app = card(page, "app");
  await expect(app.getByTestId("container-state")).toHaveText("Waiting: CrashLoopBackOff");
  await expect(app.getByTestId("container-state")).toHaveClass(/tone-bad/);
  await expect(app).toContainText("back-off 5m0s restarting failed container");
  await expect(app.getByTestId("last-state")).toHaveText(/Terminated: OOMKilled \(exit 137\) · 3m ago/);
  await expect(app.getByTestId("last-state")).toHaveClass(/tone-bad/);
  await expect(app).toContainText(/Restarts\s*12/);
  await expect(app).toContainText("not ready");
  // Events in words (#484): the reason, a summary without the pod UID, how
  // often and when.
  const events = panel(page).locator("table.events");
  await expect(events).toContainText("Back-off restarting");
  await expect(events.locator("td.reason [title='BackOff']")).toBeVisible();
  await expect(events).toContainText("Container app keeps failing; restarting it after a delay");
  await expect(events).toContainText("Back-off restarting failed container app");
  await expect(events).toContainText("168 times, last 2m ago");
});

test("scheduler events say what no node has, how often and how long ago (#484)", async ({ page }) => {
  const fake = await openPod(page, "crashed");
  const before = await podDetail(fake, "crashed");
  const message =
    "0/3 nodes are available: 3 Insufficient cpu, 3 Insufficient memory. preemption: 0/3 nodes are available: 3 No preemption victims found for incoming pod.";
  const time = Math.floor(Date.now() / 1000) - 3 * 3600 - 5 * 60 - 10;
  await fake.emitDetail({
    state: "detail",
    detail: { ...before, events: [{ type: "Warning", reason: "FailedScheduling", message, count: 821, age: "185m", time }] },
  });
  const events = panel(page).locator("table.events");
  await expect(events).toContainText("Failed scheduling");
  await expect(events.locator(".summary")).toHaveText("No node has enough CPU and memory");
  await expect(events.locator(".full")).toHaveText(message);
  await expect(events).toContainText("821 times, last 3h 5m ago");
});

test("the pod panel updates in place from the detail watch", async ({ page }) => {
  const fake = await openPod(page, "crashed");
  const before = await podDetail(fake, "crashed");
  const updated: ResourceDetail = {
    ...before,
    labels: { app: "crashed", tier: "db" },
    events: [{ type: "Warning", reason: "BackOff", message: "Back-off restarting failed container app", count: 169, age: "1s", time: 0 }],
    pod: {
      ...before.pod,
      containers: [{ ...before.pod.containers[0], restarts: 13 }],
    },
  };
  await fake.emitDetail({ state: "detail", detail: updated });
  await expect(panel(page).getByText("tier=db")).toBeVisible();
  await expect(card(page, "app")).toContainText(/Restarts\s*13/);
  await expect(panel(page).locator("table.events")).toContainText("169 times, last 1s ago");
  // Not reloaded: one fetch, then only the watch.
  expect(await fake.calls("cmdGetResourceDetail")).toHaveLength(1);
});

test("a deleted pod says so and disables its actions", async ({ page }) => {
  const fake = await openPod(page, "web-1");
  await expect(actions(page).first()).toBeEnabled();

  await fake.emitDetail({ state: "deleted" });
  await expect(panel(page).getByRole("status")).toHaveText("This Pod was deleted. Showing its last known state.");
  for (const b of await actions(page).all()) await expect(b).toBeDisabled();
  await expect(card(page, "app").getByRole("button", { name: "Forward port 8080" })).toBeDisabled();
  await expect(panel(page).getByRole("button", { name: "Shell", exact: true })).toBeDisabled();
  // The last known state stays.
  await expect(card(page, "app")).toBeVisible();

  // Recreated under the same name: live again.
  await fake.emitDetail({ state: "detail", detail: await podDetail(fake, "web-1") });
  await expect(panel(page).getByRole("status")).toHaveCount(0);
  await expect(actions(page).first()).toBeEnabled();
});

test("closing the panel stops the detail watch", async ({ page }) => {
  const fake = await openPod(page, "web-1");
  const id = await fake.lastDetailWatchId();
  await panel(page).getByRole("button", { name: "Close details" }).click();
  await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => fake.activeDetailWatches()).toEqual([]);
  expect((await fake.calls("cmdWatchStop")).map((c) => c.id)).toContain(id);
});

test("events of another detail watch are ignored", async ({ page }) => {
  const fake = await openPod(page, "web-1");
  await fake.emitDetail({ id: "detail-999", state: "deleted" });
  const lost = "Lost the connection to the cluster (https://127.0.0.1:6443); retrying.";
  await fake.emitDetail({ state: "error", error: lost });
  await expect(panel(page).getByRole("status")).toHaveText(lost);
  await expect(panel(page).getByText("This Pod was deleted")).toHaveCount(0);
});

test("the generic panel updates live and shows deletion too", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Deployments");
  await row(page, "web").click();
  await expect(panel(page).locator(".title")).toHaveText("Deployment demo/web");
  await expect.poll(() => fake.activeDetailWatches()).toHaveLength(1);
  await expect(panel(page).getByText("No events.")).toBeVisible();

  const first = await page.evaluate(() => window.__fake.calls("cmdDetailWatch")[0]);
  expect(first).toEqual({
    resource: expect.objectContaining({ kind: "Deployment", group: "apps" }),
    namespace: "demo",
    name: "web",
    // Its own channel (#115).
    onEvent: expect.stringMatching(/^__CHANNEL__:\d+$/),
  });

  const detail: ResourceDetail = await page.evaluate(() => {
    const kind = window.__fake.cluster.kinds.find((k) => k.id === "apps/v1/deployments")!;
    return {
      name: "web",
      namespace: "demo",
      uid: "uid-demo/web",
      api_version: "apps/v1",
      kind: kind.resource.kind,
      created: 0,
      age: "1h",
      labels: {},
      annotations: {},
      finalizers: [],
      owners: [],
      conditions: [{ type: "Available", status: "False", reason: "MinimumReplicasUnavailable", message: "", age: "5s" }],
      secret_keys: [],
      events: [{ type: "Normal", reason: "ScalingReplicaSet", message: "Scaled up to 3", count: 1, age: "5s", time: 0 }],
      pod: {
        phase: "",
        reason: "",
        message: "",
        node: "",
        pod_ips: [],
        host_ip: "",
        qos_class: "",
        priority_class: "",
        service_account: "",
        containers: [],
        log_containers: [],
      },
    };
  });
  await fake.emitDetail({ state: "detail", detail });
  await expect(panel(page).locator("table.conditions")).toContainText("MinimumReplicasUnavailable");
  await expect(panel(page).locator("table.events")).toContainText("Scaling replica set");

  // Deleted elsewhere (here: by the fake, as another client would).
  await page.evaluate(() => {
    const c = window.__fake.cluster;
    c.rows["apps/v1/deployments"] = c.rows["apps/v1/deployments"].filter((r) => r.key !== "demo/web");
  });
  await fake.emitDetail({ state: "deleted" });
  await expect(panel(page).getByRole("status")).toHaveText("This Deployment was deleted. Showing its last known state.");
  for (const b of await actions(page).all()) await expect(b).toBeDisabled();
});

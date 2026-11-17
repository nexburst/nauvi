// Uses helm (qa.sh puts one on PATH, from the cache if needed).
// Checks (#226): Workloads > Applications groups labelled workloads and a
// Helm release in a temp namespace, with their rolled-up status:
// - `shop` (instance label: a ready Deployment and one that never pulls)
//   is Progressing, `cache` (name label) Healthy, the release `qa-rel` a
//   Helm release; an unlabelled Deployment is not listed;
// - a row opens the side panel, whose workload opens its own detail;
// - live: deleting the broken workload makes `shop` Healthy;
// - an empty namespace explains what the view groups;
// - as the limited user (if NAUVI_LIMITED_KUBECONFIG is set), only its
//   namespace's applications, with the notes saying why.
// Screenshots at 1280x800 in light and dark theme.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, REPO, byTestId } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const CHART = `${REPO}/scripts/test-cluster/charts/demo-chart`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let helm = true;
try {
  execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
} catch {
  helm = false;
}

/** A one-replica Deployment with `labels` on the object (JSON is YAML too). */
function deployment(name, labels, image = "busybox:1.36") {
  return JSON.stringify({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name, labels },
    spec: {
      replicas: 1,
      selector: { matchLabels: { "qa-app": name } },
      template: {
        metadata: { labels: { "qa-app": name } },
        spec: {
          terminationGracePeriodSeconds: 0,
          containers: [{ name: "c", image, command: ["sleep", "3600"] }],
        },
      },
    },
  });
}

const rowsData = (app) =>
  app.js(`return Array.from(document.querySelectorAll('[data-testid="application-row"]'), (r) => ({
    key: r.dataset.key,
    cells: Array.from(r.querySelectorAll('[role="gridcell"]'), (c) => c.textContent.trim()),
  }));`);

/** Light, then dark, then back to the system theme. */
async function shots(app, label) {
  for (const theme of ["light", "dark"]) {
    await setTheme(app, theme);
    await sleep(500); // let WebKitGTK repaint before the shot
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

async function openApplications(app) {
  await app.nav("Applications");
  await app.find(byTestId("applications"));
}

let ns;
let empty;

describe("applications", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace(
      "qa-apps",
      [
        deployment("shop-web", { "app.kubernetes.io/instance": "shop", "app.kubernetes.io/name": "web", "app.kubernetes.io/version": "1.0" }),
        deployment(
          "shop-api",
          { "app.kubernetes.io/instance": "shop", "app.kubernetes.io/name": "api", "app.kubernetes.io/version": "1.0" },
          "nauvi.invalid/nope:1",
        ),
        deployment("cache", { "app.kubernetes.io/name": "redis" }),
        deployment("loner", {}),
      ].join("\n---\n"),
    );
    if (helm) {
      execFileSync("helm", ["--kube-context", CONTEXT, "-n", ns, "install", "qa-rel", CHART], { stdio: "pipe" });
    }
    empty = tempNamespace("qa-apps-empty");
  });
  after(() => {
    deleteNamespace(ns);
    deleteNamespace(empty);
  });
  const s = appSession("applications");

  it("groups labelled workloads and the Helm release, with their status", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    await openApplications(app);
    await pickNamespaces(app, [ns]);
    const want = helm ? 3 : 2;
    const rows = await app.waitFor(
      async () => {
        const r = await rowsData(app);
        const shop = r.find((x) => x.key === `${ns}/shop`);
        return r.length === want && shop?.cells[2] === "Progressing" ? r : null;
      },
      { timeout: 90_000, message: `${want} applications, shop Progressing` },
    );
    console.log(JSON.stringify(rows, null, 1));
    const by = Object.fromEntries(rows.map((r) => [r.key.split("/")[1], r.cells]));
    assert.deepEqual(Object.keys(by).sort(), helm ? ["qa-rel", "redis", "shop"] : ["redis", "shop"]);
    assert.equal(by.shop[3], "2 Deployments");
    assert.equal(by.shop[4], "api, web");
    assert.equal(by.shop[5], "1.0");
    assert.equal(by.shop[6], "instance label");
    assert.equal(by.redis[6], "name label");
    if (helm) assert.equal(by["qa-rel"][6], "Helm release");
    await waitLive(app);
    await shots(app, "list");
  });

  it("a row opens its workloads, and a workload its detail", T, async () => {
    const { app } = s;
    await (await app.find(By.css(`[data-testid="application-row"][data-key="${ns}/shop"]`))).click();
    const panel = await app.find(byTestId("application-detail"));
    const text = await app.waitFor(
      async () => {
        const t = await app.js("return arguments[0].innerText", panel);
        return t.includes("shop-api") && t.includes("shop-web") ? t : null;
      },
      { message: "the two workloads in the panel" },
    );
    assert.match(text, /Deployment shop-api: 0 of 1 ready/);
    await shots(app, "panel");
    const api = await app.find(
      By.xpath(`//*[@data-testid='application-workload'][.//*[normalize-space()='shop-api']]`),
    );
    await api.click();
    const detail = await app.find(byTestId("detail-panel"));
    await app.waitFor(async () => (await app.js("return arguments[0].innerText", detail)).includes("shop-api"), {
      message: "the Deployment's detail",
    });
  });

  it("a Helm application opens its release", { ...T, skip: helm ? false : "helm is not on PATH" }, async () => {
    const { app } = s;
    await openApplications(app);
    await (await app.find(By.css(`[data-testid="application-row"][data-key="${ns}/qa-rel"]`))).click();
    const panel = await app.find(byTestId("application-detail"));
    await (await panel.findElement(By.xpath(".//button[normalize-space()='Open Helm release']"))).click();
    const detail = await app.find(byTestId("helm-detail"));
    await app.waitFor(async () => (await detail.getText()).includes(`${ns}/qa-rel`), { message: "the release's detail" });
  });

  it("live: without the broken workload the application is Healthy", T, async () => {
    const { app } = s;
    await openApplications(app);
    kubectl(["-n", ns, "delete", "deployment", "shop-api", "--wait=false"]);
    await app.waitFor(
      async () => {
        const shop = (await rowsData(app)).find((x) => x.key === `${ns}/shop`);
        return shop?.cells[2] === "Healthy" && shop.cells[3] === "1 Deployment";
      },
      { timeout: 90_000, message: "shop Healthy with one Deployment" },
    );
  });

  it("an empty namespace says what the view groups", T, async () => {
    const { app } = s;
    await pickNamespaces(app, [empty]);
    const e = await app.find(byTestId("applications-empty"));
    await app.waitFor(async () => (await e.getText()).includes("No applications found."), { message: "the empty state" });
    assert.match(await e.getText(), /app\.kubernetes\.io\/instance/);
    await shots(app, "empty");
  });
});

const kubeconfig = process.env.NAUVI_LIMITED_KUBECONFIG;
const limitedSkip = kubeconfig && existsSync(kubeconfig) ? false : "set NAUVI_LIMITED_KUBECONFIG (limited-user.sh)";
const TEAM_APP = `qa-apps-${Date.now().toString(36)}`;

describe("applications as the limited user", { timeout: 10 * 60_000, skip: limitedSkip }, () => {
  before(() => {
    kubectl(["-n", "team-a", "apply", "-f", "-"], deployment(TEAM_APP, { "app.kubernetes.io/instance": TEAM_APP }));
  });
  after(() => {
    try {
      kubectl(["-n", "team-a", "delete", "deployment", TEAM_APP, "--wait=false"]);
    } catch (e) {
      console.error(`could not delete team-a/${TEAM_APP}: ${e.message}`);
    }
  });
  const s = appSession("applications-limited", { kubeconfig });

  it("shows only team-a's applications", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await openApplications(app);
    await waitLive(app);
    const rows = await app.waitFor(
      async () => {
        const r = await rowsData(app);
        return r.some((x) => x.key === `team-a/${TEAM_APP}`) ? r : null;
      },
      { timeout: 90_000, message: `team-a/${TEAM_APP} listed` },
    );
    assert.ok(
      rows.every((r) => r.key.startsWith("team-a/")),
      `only team-a: ${rows.map((r) => r.key)}`,
    );
    const banner = await app.js(`return document.querySelector('[role="alert"]')?.textContent ?? ""`);
    assert.equal(banner, "", "no error banner");
    await shots(app, "limited");
  });
});

// One-click metrics (#225): the overview offers metrics-server when the
// metrics API is missing, Settings offers a small Prometheus stack when none
// is found; both go through a helm dry run and a confirm that names the
// pinned chart and its repository. Nodes get a Disk column once Prometheus
// (node-exporter) is there. RBAC greys the offer for the limited user.
//
// Runs against kind-kubeloupe-staging when it exists (qa.yml creates it,
// empty: no metrics-server, no Prometheus), else the test context. Real
// installs happen only in qa.yml (GITHUB_ACTIONS and QA_PROMETHEUS set) and
// only on the staging cluster, and are uninstalled afterwards. Elsewhere the
// scenario stops at the dry run, into a temporary namespace with a unique
// release name: the shared cluster's metrics-server and Prometheus are never
// touched. The dry run downloads the charts from their repositories.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { CONTEXT, byTestId, xq } from "../lib/app.mjs";
import { contexts } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "../lib/theme.mjs";
import { tableData } from "../lib/table.mjs";

const T = { timeout: 300_000 };
const STAGING = process.env.QA_STAGING_CONTEXT || "kind-kubeloupe-staging";
const hasStaging = contexts().includes(STAGING);
const TARGET = hasStaging ? STAGING : CONTEXT;
const REAL = !!(process.env.GITHUB_ACTIONS && process.env.QA_PROMETHEUS && hasStaging);
const NOT_REAL = REAL ? false : "real installs only in qa.yml, on its own staging cluster";

let skip = false;
try {
  execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
} catch {
  skip = "helm is not on PATH";
}

/** kubectl against the cluster this scenario uses. */
function kc(args, input) {
  return execFileSync("kubectl", ["--context", TARGET, ...args], {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function ok(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

const hasMetricsApi = () => ok(() => kc(["get", "apiservice", "v1beta1.metrics.k8s.io"]));

/** The button with this text inside the element with `testid`. */
const button = (testid, text) => By.xpath(`//*[@data-testid=${xq(testid)}]//button[normalize-space()=${xq(text)}]`);

async function textOf(app, testid) {
  return app.js(`return document.querySelector('[data-testid="${testid}"]')?.innerText ?? ""`);
}

async function openSettings(app) {
  await app.js("document.activeElement?.blur()");
  await app.driver.actions().keyDown(Key.CONTROL).sendKeys(",").keyUp(Key.CONTROL).perform();
  await app.find(byTestId("settings"));
  // Wait for the Prometheus check.
  await app.waitFor(async () => !(await textOf(app, "prometheus-status")).includes("Checking"), {
    timeout: 60_000,
    message: "the Prometheus check",
  });
}

async function closeSettings(app) {
  await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
}

/** Set an input of the install dialog by its aria-label. */
async function setField(app, label, value) {
  const el = await app.find(By.css(`[data-testid="metrics-install"] input[aria-label="${label}"]`));
  await app.setValue(el, value);
}

async function dryRun(app) {
  await (await app.find(byTestId("addon-preview"))).click();
  await app.waitFor(
    async () => (await textOf(app, "addon-summary")) || (await textOf(app, "addon-error")),
    { timeout: 240_000, message: "the dry run" },
  );
  const err = await textOf(app, "addon-error");
  assert.equal(err, "", `dry run failed: ${err}`);
}

async function install(app) {
  await (await app.find(byTestId("addon-confirm"))).click();
  await app.waitFor(async () => (await textOf(app, "addon-result")) || (await textOf(app, "addon-error")), {
    timeout: 280_000,
    message: "the install",
  });
  const err = await textOf(app, "addon-error");
  assert.equal(err, "", `install failed: ${err}`);
}

async function closeDialog(app) {
  await (await app.find(button("metrics-install", "Close"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("metrics-install"))).length === 0, {
    message: "the install dialog to close",
  });
}

describe("one-click metrics", { timeout: 30 * 60_000, skip }, () => {
  let ns = "";
  const release = `qa-prom-${Date.now().toString(36)}`;
  before(() => {
    console.log(`cluster: ${TARGET}, real installs: ${REAL}`);
    if (!REAL) {
      // A dry run only, into a namespace of its own.
      ns = `qa-metrics-${Date.now().toString(36)}`;
      kc(["create", "namespace", ns]);
    }
  });
  after(() => {
    if (ns) ok(() => kc(["delete", "namespace", ns, "--wait=false"]));
    if (REAL) {
      // Only on qa.yml's staging cluster.
      for (const [name, namespace] of [
        ["metrics-server", "kube-system"],
        ["prometheus", "monitoring"],
      ]) {
        ok(() => execFileSync("helm", ["uninstall", name, "-n", namespace, "--kube-context", STAGING], { stdio: "pipe" }));
      }
      ok(() => kc(["delete", "namespace", "monitoring", "--wait=false"]));
    }
  });
  const s = appSession("metrics-install", { contexts: [TARGET] });

  it("the overview offers metrics-server when the metrics API is missing", T, async (t) => {
    const { app } = s;
    await waitLive(app);
    if (hasMetricsApi()) {
      t.skip(`${TARGET} has metrics-server`);
      return;
    }
    await app.nav("Overview");
    const offer = await app.find(byTestId("metrics-offer-metrics-server"), { timeout: 60_000 });
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", offer);
    console.log(`offer: ${await offer.getText()}`);
    assert.match(await offer.getText(), /Install metrics-server/);
  });

  it("metrics-server: the kind option, the dry run and the confirm (installs in qa.yml)", T, async (t) => {
    const { app } = s;
    if (hasMetricsApi()) {
      t.skip(`${TARGET} has metrics-server`);
      return;
    }
    await (await app.find(button("metrics-offer-metrics-server", "Install metrics-server…"))).click();
    await app.find(byTestId("metrics-install"));
    const chart = await textOf(app, "addon-chart");
    console.log(`chart: ${chart}`);
    assert.match(chart, /metrics-server 3\.14\.0/);
    assert.match(chart, /https:\/\/kubernetes-sigs\.github\.io\/metrics-server\//);
    const opt = await app.find(byTestId("addon-option-kubelet-insecure-tls"));
    assert.equal(await opt.isSelected(), false, "the kind option starts off");
    await opt.click();
    await app.shot("metrics-server form");
    await dryRun(app);
    const facts = await textOf(app, "addon-confirm-facts");
    console.log(`confirm: ${facts}`);
    assert.match(facts, /--kubelet-insecure-tls/);
    assert.match(facts, /kube-system\/metrics-server/);
    await app.shot("metrics-server confirm");
    if (!REAL) {
      await (await app.find(button("metrics-install", "Cancel"))).click();
      return;
    }
    await install(app);
    console.log(`result: ${await textOf(app, "addon-result")}`);
    await app.shot("metrics-server installed");
    await closeDialog(app);
  });

  it("after the install, node usage arrives from metrics-server", { ...T, skip: NOT_REAL }, async () => {
    const { app } = s;
    await app.nav("Nodes");
    const data = await app.waitFor(
      async () => {
        const d = await tableData(app);
        return d?.rows.some((r) => /\d/.test(r.CPU ?? "")) ? d : null;
      },
      { timeout: 280_000, interval: 2000, message: "node CPU from the new metrics-server" },
    );
    console.log(`nodes: ${JSON.stringify(data.rows.map((r) => [r.Name, r.CPU, r.Memory]))}`);
  });

  it("Settings offers a small Prometheus; the confirm names chart, version and repository", T, async (t) => {
    const { app } = s;
    await openSettings(app);
    const status = await textOf(app, "prometheus-status");
    console.log(`prometheus status: ${status}`);
    if (status.startsWith("Using")) {
      await closeSettings(app);
      t.skip(`${TARGET} has a Prometheus`);
      return;
    }
    const offer = await app.find(byTestId("metrics-offer-prometheus"));
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", offer);
    await app.shot("settings offer");
    await (await app.find(button("metrics-offer-prometheus", "Install Prometheus…"))).click();
    await app.find(byTestId("metrics-install"));
    const chart = await textOf(app, "addon-chart");
    console.log(`chart: ${chart}`);
    assert.match(chart, /prometheus 29\.47\.2/);
    assert.match(chart, /https:\/\/prometheus-community\.github\.io\/helm-charts/);
    if (!REAL) {
      await setField(app, "Namespace", ns);
      await setField(app, "Release name", release);
    }
    await setTheme(app, "light");
    await app.shot("prometheus form light");
    await dryRun(app);
    const facts = await textOf(app, "addon-confirm-facts");
    console.log(`confirm: ${facts}`);
    assert.match(facts, /https:\/\/prometheus-community\.github\.io\/helm-charts/);
    console.log(`summary: ${await textOf(app, "addon-summary")}`);
    await app.shot("prometheus confirm light");
    await setTheme(app, "dark");
    await app.shot("prometheus confirm dark");
    if (!REAL) {
      await (await app.find(button("metrics-install", "Cancel"))).click();
      // The dry run installed nothing.
      const list = execFileSync("helm", ["list", "-n", ns, "-q", "--kube-context", TARGET], { encoding: "utf8" });
      assert.equal(list.trim(), "", "no release after a dry run");
      return;
    }
    await install(app);
    console.log(`result: ${await textOf(app, "addon-result")}`);
    await app.shot("prometheus installed");
    await closeDialog(app);
    await openSettings(app);
    await app.waitFor(async () => (await textOf(app, "prometheus-status")).startsWith("Using"), {
      timeout: 60_000,
      message: "the new Prometheus to be detected",
    });
    console.log(`prometheus status: ${await textOf(app, "prometheus-status")}`);
    await app.shot("settings after install");
    await closeSettings(app);
  });

  it("Nodes get a Disk column from the new Prometheus", { ...T, skip: NOT_REAL }, async () => {
    const { app } = s;
    await app.nav("Pods");
    await app.nav("Nodes");
    const data = await app.waitFor(
      async () => {
        const d = await tableData(app);
        return d?.headers.includes("Disk") && d.rows.some((r) => /%\)$/.test(r.Disk ?? "")) ? d : null;
      },
      { timeout: 290_000, interval: 3000, message: "the Disk column" },
    );
    console.log(`disk: ${JSON.stringify(data.rows.map((r) => [r.Name, r.Disk]))}`);
  });
});

const limited = process.env.KUBELOUPE_LIMITED_KUBECONFIG;
const noLimited = limited && existsSync(limited) ? false : "set KUBELOUPE_LIMITED_KUBECONFIG (limited-user.sh)";

describe("one-click metrics as a namespace-scoped user", { timeout: 5 * 60_000, skip: skip || noLimited }, () => {
  const s = appSession("metrics-install-limited", { kubeconfig: limited });

  it("the Prometheus offer is greyed with what RBAC refuses", { timeout: 120_000 }, async (t) => {
    const { app } = s;
    await waitLive(app, 90_000);
    await openSettings(app);
    const status = await textOf(app, "prometheus-status");
    console.log(`prometheus status: ${status}`);
    if (status.startsWith("Using")) {
      t.skip("a Prometheus is visible to this user");
      return;
    }
    const denied = await app.find(byTestId("metrics-offer-denied"), { timeout: 30_000 });
    const reason = await denied.getText();
    console.log(`denied: ${reason}`);
    assert.match(reason, /^Not allowed: you can't create clusterroles/);
    const btn = await app.find(button("metrics-offer-prometheus", "Install Prometheus…"));
    assert.equal(await btn.isEnabled(), false);
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", denied);
  });
});

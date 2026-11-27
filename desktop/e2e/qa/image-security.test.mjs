// Image security (#534, ADR 0011) in the real app against kind, which has
// only the Trivy Operator's VulnerabilityReport CRD (setup.sh applies
// scripts/test-cluster/trivy-vulnerabilityreports-crd.yaml): fixture
// reports in temp namespaces, pods that never schedule (no image pulls).
// - off by default: the view says how to turn it on, nothing in the sidebar
// - turned on for the cluster: one row per image with its verdict, red only
//   for critical with a fix, amber for high, an old scan marked; the panel
//   says what to update, with "No fix yet" collapsed
// - where people already look (#535): the Vulns column (pods joined to
//   their Deployment), a Deployment's and a CronJob's (#557) Security tab, the line on a container
//   card and the Overview card; none of it while the feature is off
// - the empty states: not scanned (no reports in the namespace), no known
//   vulnerabilities (a clean report), no Trivy Operator (the second cluster,
//   which has no CRD) and not allowed (the limited user)
// Light and dark theme at 1280x800.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { CONTEXT, byTestId, xq } from "../lib/app.mjs";
import { contexts, deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces, tableData } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const STAGING = "kind-nauvi-staging";

/** A pod that never schedules, so its image is never pulled. */
function podYaml(name, image) {
  return `---
apiVersion: v1
kind: Pod
metadata:
  name: ${name}
spec:
  nodeSelector:
    nauvi.test/no-such-node: "true"
  containers:
    - name: app
      image: ${image}
`;
}

/** A Deployment whose pods never schedule (#535: its Security tab). */
function deploymentYaml(name, image) {
  return `---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: 1
  selector:
    matchLabels: { app: ${name} }
  template:
    metadata:
      labels: { app: ${name} }
    spec:
      nodeSelector:
        nauvi.test/no-such-node: "true"
      containers:
        - name: app
          image: ${image}
`;
}

const COLUMNS = "//*[@role='dialog'][@aria-label='Columns']";

/** Turn the Vulns column on (or check it is not offered) in the table on screen. */
async function vulnsChoice(app) {
  const button = await app.find(By.xpath("//button[starts-with(normalize-space(), 'Columns')]"));
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", button);
  await button.click();
  await app.find(By.xpath(COLUMNS));
  return app.driver.findElements(By.xpath(`${COLUMNS}//label[normalize-space()=${xq("Vulns")}]//input`));
}
async function closeColumns(app) {
  await app.driver.actions().sendKeys(Key.ESCAPE).perform();
  await app.waitFor(async () => (await app.driver.findElements(By.xpath(COLUMNS))).length === 0, {
    message: "the chooser closed",
  });
}

const count = (app, testId) => app.js(`return document.querySelectorAll('[data-testid="${testId}"]').length`);
const textOf = (app, testId) =>
  app.js(`return [...document.querySelectorAll('[data-testid="${testId}"]')].map((e) => e.innerText).join(" | ")`);

const vuln = (id, pkg, severity, fixed, installed = "1.0") => ({
  vulnerabilityID: id,
  resource: pkg,
  installedVersion: installed,
  fixedVersion: fixed,
  severity,
  score: 7.5,
  title: `${pkg}: ${id}`,
  primaryLink: `https://avd.aquasec.com/nvd/${id.toLowerCase()}`,
  lastModifiedDate: "2026-01-01T00:00:00Z",
  publishedDate: "2026-01-01T00:00:00Z",
});

/** A suspended CronJob (#557: its Security tab): it never runs a pod. */
function cronJobYaml(name, image) {
  return `---
apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${name}
spec:
  schedule: "0 3 * * *"
  suspend: true
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: app
              image: ${image}
`;
}

/** A report as the operator writes it for the `kind` `name` (container `app`). */
function reportJson(ns, name, repository, tag, vulns, daysAgo = 1, kind = "Pod") {
  const summary = { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, unknownCount: 0, noneCount: 0 };
  for (const v of vulns) summary[`${v.severity.toLowerCase()}Count`] += 1;
  return {
    apiVersion: "aquasecurity.github.io/v1alpha1",
    kind: "VulnerabilityReport",
    metadata: {
      name: `${kind.toLowerCase()}-${name}-app`,
      namespace: ns,
      labels: {
        "trivy-operator.resource.kind": kind,
        "trivy-operator.resource.name": name,
        "trivy-operator.resource.namespace": ns,
        "trivy-operator.container.name": "app",
      },
    },
    report: {
      artifact: { repository, tag },
      os: { family: "debian", name: "12" },
      registry: { server: "index.docker.io" },
      scanner: { name: "Trivy", vendor: "Aqua Security", version: "0.69.3" },
      summary,
      updateTimestamp: new Date(Date.now() - daysAgo * 86400_000).toISOString(),
      vulnerabilities: vulns,
    },
  };
}

function applyReports(ns, reports) {
  kubectl(["-n", ns, "apply", "-f", "-"], JSON.stringify({ apiVersion: "v1", kind: "List", items: reports }));
}

/** Rows of the view: image, verdict, tone. */
const viewRows = (app) =>
  app.js(`return Array.from(document.querySelectorAll('[data-testid="image-row"]'), (r) => ({
    image: r.querySelector('.image')?.textContent.trim() ?? "",
    verdict: r.querySelector('[data-testid="image-verdict"]')?.textContent.trim() ?? "",
    tone: r.dataset.tone,
    text: r.innerText,
  }))`);

const viewText = (app) =>
  app.js(`return document.querySelector('[data-testid="image-security"]')?.innerText ?? ""`);

const stateOf = (app) =>
  app.js(`return document.querySelector('[data-testid="image-security-state"]')?.dataset.state ?? ""`);

async function openView(app) {
  await app.palette("image security", "Go to Image security");
  await app.find(byTestId("image-security"));
}

/** Settings with image security on for every cluster. */
function enabledProfile() {
  const profile = createProfile();
  profile.writeSettings({
    version: 1,
    image_security: { enabled: true, min_severity: "high", only_fixable: false, excluded_namespaces: [], cache_ttl_hours: 24 },
  });
  return profile;
}

describe("image security", { timeout: 15 * 60_000 }, () => {
  let found = "";
  let unscanned = "";
  let clean = "";
  before(() => {
    // Findings: nginx with a critical and a high that have a fix and a low
    // without; redis with two high and no fix; postgres scanned 10 days ago.
    found = tempNamespace(
      "qa-vulns",
      podYaml("web", "nginx:1.27") +
        podYaml("cache", "redis:7.2") +
        podYaml("db", "postgres:15") +
        podYaml("tool", "busybox:1.36") +
        // The same image as web (no digest: never pulled), so web's report covers it.
        deploymentYaml("shop", "nginx:1.27") +
        // #557: the operator scans a CronJob as itself (no pod needed).
        cronJobYaml("nightly", "redis:7.2"),
    );
    applyReports(found, [
      // Older than cache's, with the same findings: the row stays cache's.
      reportJson(found, "nightly", "library/redis", "7.2", [
        vuln("CVE-2026-2001", "redis", "HIGH", ""),
        vuln("CVE-2026-2002", "redis", "HIGH", ""),
      ], 2, "CronJob"),
      reportJson(found, "web", "library/nginx", "1.27", [
        vuln("CVE-2026-1001", "openssl", "CRITICAL", "3.0.15-1", "3.0.11-1"),
        vuln("CVE-2026-1002", "openssl", "HIGH", "3.0.14-1", "3.0.11-1"),
        vuln("CVE-2026-1003", "curl", "HIGH", "7.88.1-10+deb12u8", "7.88.1-10"),
        vuln("CVE-2026-1004", "libc6", "HIGH", "", "2.36-9"),
        vuln("CVE-2026-1005", "zlib1g", "LOW", ""),
      ]),
      reportJson(found, "cache", "library/redis", "7.2", [
        vuln("CVE-2026-2001", "redis", "HIGH", ""),
        vuln("CVE-2026-2002", "redis", "HIGH", ""),
      ]),
      reportJson(found, "db", "library/postgres", "15", [vuln("CVE-2026-3001", "postgresql", "CRITICAL", "15.8")], 10),
      reportJson(found, "tool", "library/busybox", "1.36", []),
    ]);
    unscanned = tempNamespace("qa-vulns-none", podYaml("app", "nginx:1.27"));
    clean = tempNamespace("qa-vulns-clean", podYaml("app", "busybox:1.36"));
    applyReports(clean, [reportJson(clean, "app", "library/busybox", "1.36", [])]);
  });
  after(() => {
    deleteNamespace(found);
    deleteNamespace(unscanned);
    deleteNamespace(clean);
  });

  const s = appSession("image-security");

  it("off by default: the view says how to turn it on, nothing in the sidebar (light)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "light");
    await waitLive(app);
    assert.equal((await app.driver.findElements(app.navButton("Image security"))).length, 0);
    // Nowhere else either (#535): no Overview card, no Vulns column.
    await app.nav("Overview");
    await app.find(byTestId("deck-headline"));
    assert.equal(await count(app, "overview-image-findings"), 0);
    await app.nav("Pods");
    assert.equal((await vulnsChoice(app)).length, 0, "no Vulns column while off");
    await closeColumns(app);
    await openView(app);
    const text = await viewText(app);
    assert.match(text, /Image security is off for this cluster/);
    assert.match(text, /Turn on for this cluster/);
  });

  it("turned on for this cluster: one row per image with its verdict (light)", T, async () => {
    const { app } = s;
    await (await app.find(byTestId("image-security-turn-on"))).click();
    await pickNamespaces(app, [found]);
    const rows = await app.waitFor(
      async () => {
        const r = await viewRows(app);
        return r.length === 4 ? r : null;
      },
      { timeout: 60_000, message: "four image rows" },
    );
    const by = (img) => rows.find((r) => r.image === img);
    assert.equal(rows[0].image, "nginx:1.27", JSON.stringify(rows));
    assert.equal(by("nginx:1.27").verdict, "1 critical and 3 high. 3 of 4 have a fix.");
    assert.equal(by("nginx:1.27").tone, "critical");
    assert.equal(by("redis:7.2").verdict, "2 high. None has a fix yet.");
    assert.equal(by("redis:7.2").tone, "high");
    assert.match(by("postgres:15").text, /old scan/);
    assert.equal(by("busybox:1.36").verdict, "No known vulnerabilities.");
    assert.match(await viewText(app), /2 images have fixes waiting/);
    assert.match(by("nginx:1.27").text, /Trivy 0\.69\.3 through Trivy Operator/);
    // Nothing to create in this view.
    assert.equal(await app.js(`return document.querySelectorAll(".toolbar .create").length`), 0);
    // On for this context only, after the debounced write.
    await app.waitFor(() => s.app.profile.settings()?.contexts?.[CONTEXT]?.image_security === "on", {
      message: "image_security on in settings.json",
    });
    assert.notEqual(s.app.profile.settings()?.image_security?.enabled, true);
    assert.equal((await app.driver.findElements(app.navButton("Image security"))).length, 1);
  });

  it("the panel says what to update; No fix yet is collapsed (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await (await app.find(By.css('[data-testid="image-row"][data-key^="nginx:1.27@"]'))).click();
    const panel = await app.find(byTestId("image-findings"));
    await app.waitFor(async () => (await panel.getText()).includes("Updating openssl"), {
      message: "the fixes in the panel",
    });
    const text = await app.js(`return document.querySelector('[data-testid="image-findings"]').innerText`);
    assert.match(text, /Updating openssl to 3\.0\.15-1 fixes 2 \(1 critical\)\./);
    assert.match(text, /Updating curl to 7\.88\.1-10\+deb12u8 fixes 1 high\./);
    assert.match(text, /No fix yet \(1\): nothing to do now/);
    // Collapsed: the package without a fix is not shown until opened.
    assert.equal(
      await app.js(`return document.querySelector('[data-testid="findings-nofix"]').open`),
      false,
    );
  });

  it("the Vulns column joins pods to their workload, worst first (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await app.nav("Pods");
    const [choice] = await vulnsChoice(app);
    assert.ok(choice, "the Vulns column is offered while on");
    assert.equal(await choice.isSelected(), false, "off by default");
    await app.js("arguments[0].click()", choice);
    await closeColumns(app);
    const rows = await app.waitFor(
      async () => {
        const t = await tableData(app);
        const by = Object.fromEntries((t?.rows ?? []).map((r) => [r.Name, r.Vulns]));
        return by.web === "1C 3H" && by.cache === "2H" ? t.rows : null;
      },
      { timeout: 60_000, message: "the Vulns cells" },
    );
    const by = Object.fromEntries(rows.map((r) => [r.Name, r.Vulns]));
    assert.equal(by.db, "1C", JSON.stringify(by));
    assert.equal(by.tool, "None", JSON.stringify(by));
    // The Deployment's pod, through its ReplicaSet.
    const shopPod = rows.find((r) => r.Name.startsWith("shop-"));
    assert.equal(shopPod?.Vulns, "1C 3H", JSON.stringify(rows));
    // Never a problem: the pods are pending (no node), not vulnerable.
    assert.ok(rows.every((r) => !/vuln/i.test(r._problem)), JSON.stringify(rows));
  });

  it("the Vulns column in dark", T, async () => {
    await setTheme(s.app, "dark");
  });

  it("a Deployment's Security tab and a container card's line (dark)", T, async () => {
    const { app } = s;
    await app.openDetail("Deployments", found, "shop");
    const tab = await app.find(By.xpath("//*[@data-testid='detail-panel']//button[@role='tab'][normalize-space()='Security']"));
    await tab.click();
    await app.find(byTestId("workload-security"));
    const text = await textOf(app, "workload-security");
    assert.match(text, /nginx:1\.27/);
    assert.match(text, /1 critical and 3 high\. 3 of 4 have a fix\./);
    assert.match(text, /Trivy 0\.69\.3 through Trivy Operator/);
  });

  it("the Security tab in light", T, async () => {
    await setTheme(s.app, "light");
  });

  it("a CronJob's Security tab, like any workload's (#557, light)", T, async () => {
    const { app } = s;
    await app.openDetail("CronJobs", found, "nightly");
    const tab = await app.find(By.xpath("//*[@data-testid='detail-panel']//button[@role='tab'][normalize-space()='Security']"));
    await tab.click();
    await app.find(byTestId("workload-security"));
    const text = await textOf(app, "workload-security");
    assert.match(text, /redis:7\.2/);
    assert.match(text, /2 high\. None has a fix yet\./);
    assert.match(text, /Container app/);
  });

  it("the CronJob's Security tab in dark", T, async () => {
    await setTheme(s.app, "dark");
  });

  it("a container card says what the report says about its image (light)", T, async () => {
    const { app } = s;
    await app.openDetail("Pods", found, "web");
    await app.waitFor(async () => (await count(app, "container-vulns")) === 1, { message: "the container's Vulns line" });
    assert.match(await textOf(app, "container-vulns"), /1 critical and 3 high\. 3 of 4 have a fix\./);
  });

  it("the container card in dark", T, async () => {
    await setTheme(s.app, "dark");
  });

  it("the Overview card counts images with a fix waiting, not as a problem (dark)", T, async () => {
    const { app } = s;
    await app.nav("Overview");
    await app.waitFor(async () => (await count(app, "overview-image-findings")) === 1, { message: "the Overview card" });
    const text = await textOf(app, "overview-image-findings");
    assert.match(text, /Image fixes/);
    // nginx (web and shop) and postgres have a critical with a fix.
    assert.match(text, /\b2\b/);
    assert.equal(await app.js(`return document.querySelector('[data-testid="overview-image-findings"]').classList.contains("alert")`), false);
  });

  it("the Overview card in light", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    // Still on the Overview: the screenshot is of the card in light.
    await app.nav("Overview");
    await app.waitFor(async () => (await count(app, "overview-image-findings")) === 1, { message: "the Overview card" });
  });

  it("not scanned yet: a namespace without reports (light)", T, async () => {
    const { app } = s;
    await openView(app);
    // openDetail filtered the tables to one name: the view shares the filter.
    await app.filter("");
    await setTheme(app, "light");
    await pickNamespaces(app, [unscanned]);
    await app.waitFor(async () => (await stateOf(app)) === "no_reports", { timeout: 60_000, message: "no_reports" });
    assert.match(await viewText(app), /Not scanned yet/);
    assert.match(await viewText(app), /1 running image not scanned yet/);
  });

  it("no known vulnerabilities: a clean report (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await pickNamespaces(app, [clean]);
    await app.waitFor(async () => /No known vulnerabilities/.test(await viewText(app)), {
      timeout: 60_000,
      message: "No known vulnerabilities",
    });
    const rows = await viewRows(app);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tone, "neutral");
  });

  it("the findings list in dark", T, async () => {
    const { app } = s;
    await pickNamespaces(app, [found]);
    await app.waitFor(async () => (await viewRows(app)).length === 4, { timeout: 60_000, message: "four rows" });
  });
});

const staging = contexts().includes(STAGING);
describe("image security without the Trivy Operator", { timeout: 10 * 60_000, skip: staging ? false : `no ${STAGING} context (setup.sh --staging)` }, () => {
  const s = appSession("image-security-no-crd", () => ({ contexts: [STAGING], profile: enabledProfile() }));

  it("the second cluster has no CRD: no Trivy Operator reports (light and dark)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "light");
    await waitLive(app);
    await openView(app);
    await app.waitFor(async () => (await stateOf(app)) === "no_operator", { timeout: 60_000, message: "no_operator" });
    assert.match(await viewText(app), /This cluster has no Trivy Operator reports/);
    await app.shot("no-crd-light");
    await setTheme(app, "dark");
  });
});

const limited = process.env.NAUVI_LIMITED_KUBECONFIG;
const limitedSkip = limited && existsSync(limited) ? false : "set NAUVI_LIMITED_KUBECONFIG (limited-user.sh)";
describe("image security as the limited user", { timeout: 10 * 60_000, skip: limitedSkip }, () => {
  const s = appSession("image-security-limited", () => ({ kubeconfig: limited, profile: enabledProfile() }));

  it("not allowed to list the reports in team-a (dark)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "dark");
    await openView(app);
    // It opens in its own namespace (or all it may see): forbidden either way.
    await app.waitFor(async () => (await stateOf(app)) === "forbidden", { timeout: 60_000, message: "forbidden" });
    assert.match(await viewText(app), /You are not allowed to list vulnerabilityreports in (namespace team-a|any namespace)/);
    // It may not list them across all namespaces either: not offered.
    assert.equal(
      await app.js(`return [...document.querySelectorAll('[data-testid="image-security-state"] button')].length`),
      0,
    );
  });
});

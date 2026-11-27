// Image security (#534, ADR 0011) in the real app against kind, which has
// only the Trivy Operator's VulnerabilityReport CRD (setup.sh applies
// scripts/test-cluster/trivy-vulnerabilityreports-crd.yaml): fixture
// reports in temp namespaces, pods that never schedule (no image pulls).
// - off by default: the view says how to turn it on, nothing in the sidebar
// - turned on for the cluster: one row per image with its verdict, red only
//   for critical with a fix, amber for high, an old scan marked; the panel
//   says what to update, with "No fix yet" collapsed
// - the empty states: not scanned (no reports in the namespace), no known
//   vulnerabilities (a clean report), no Trivy Operator (the second cluster,
//   which has no CRD) and not allowed (the limited user)
// Light and dark theme at 1280x800.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, byTestId } from "../lib/app.mjs";
import { contexts, deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
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

const vuln = (id, pkg, severity, fixed, installed = "1.0") => ({
  vulnerabilityID: id,
  resource: pkg,
  installedVersion: installed,
  fixedVersion: fixed,
  severity,
  score: 7.5,
  title: `${pkg}: ${id}`,
  primaryLink: `https://avd.aquasec.com/nvd/${id.toLowerCase()}`,
});

/** A report as the operator writes it for the pod `name` (container `app`). */
function reportJson(ns, name, repository, tag, vulns, daysAgo = 1) {
  const summary = { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0, unknownCount: 0, noneCount: 0 };
  for (const v of vulns) summary[`${v.severity.toLowerCase()}Count`] += 1;
  return {
    apiVersion: "aquasecurity.github.io/v1alpha1",
    kind: "VulnerabilityReport",
    metadata: {
      name: `pod-${name}-app`,
      namespace: ns,
      labels: {
        "trivy-operator.resource.kind": "Pod",
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
      podYaml("web", "nginx:1.27") + podYaml("cache", "redis:7.2") + podYaml("db", "postgres:15") + podYaml("tool", "busybox:1.36"),
    );
    applyReports(found, [
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

  it("not scanned yet: a namespace without reports (light)", T, async () => {
    const { app } = s;
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
  });
});

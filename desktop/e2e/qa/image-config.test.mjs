// Misconfigurations and Kubescape (#538, ADR 0011) in the real app against
// kind. No operator runs: the main cluster has the Trivy Operator's
// ConfigAuditReport CRD (setup.sh applies
// scripts/test-cluster/trivy-configauditreports-crd.yaml; applied here
// too when missing) and fixture reports in a temp namespace, for a
// Deployment whose pods never schedule (no image pulls).
// - the Configuration tab of Image security: one row per workload (the
//   Deployment, not its ReplicaSet) with what it fails, red only for a
//   critical check; the panel says what to change, lower ones collapsed
// - not checked yet: a namespace without reports
// - Kubescape: on the second cluster (no Trivy Operator CRDs), stand-in
//   Kubescape CRDs (scripts/test-cluster/kubescape-storage-crds.yaml) and a
//   fixture summary and manifest: the Vulnerabilities tab reads them, never
//   claims a fix from the counts, the panel lists the fixes; the
//   Configuration tab there says the cluster has no configuration audits.
//   The CRDs are removed afterwards.
// - a scanner on this computer only (#563): the Configuration tab reads
//   nothing from the cluster and says where the checks come from.
// Light and dark theme at 1280x800.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { contexts, deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const STAGING = "kind-nauvi-staging";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONFIG_CRD = join(ROOT, "scripts/test-cluster/trivy-configauditreports-crd.yaml");
const KUBESCAPE_CRDS = join(ROOT, "scripts/test-cluster/kubescape-storage-crds.yaml");

const deploymentYaml = (name) => `---
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
          image: nginx:1.27
`;

const check = (id, severity, title, remediation, success = false) => ({
  checkID: id,
  title,
  severity,
  category: "Kubernetes Security Check",
  description: `${title}: why it matters.`,
  remediation,
  messages: [`Container 'app' should change this (${id})`],
  scope: { type: "Container", value: "app" },
  success,
});

function configReport(ns, kind, name, checks, daysAgo = 1) {
  const summary = { criticalCount: 0, highCount: 0, mediumCount: 0, lowCount: 0 };
  for (const c of checks) if (!c.success) summary[`${c.severity.toLowerCase()}Count`] += 1;
  return {
    apiVersion: "aquasecurity.github.io/v1alpha1",
    kind: "ConfigAuditReport",
    metadata: {
      name: `${kind.toLowerCase()}-${name}`,
      namespace: ns,
      labels: {
        "trivy-operator.resource.kind": kind,
        "trivy-operator.resource.name": name,
        "trivy-operator.resource.namespace": ns,
      },
    },
    report: {
      scanner: { name: "Trivy", vendor: "Aqua Security", version: "0.69.3" },
      summary,
      updateTimestamp: new Date(Date.now() - daysAgo * 86400_000).toISOString(),
      checks,
    },
  };
}

const list = (items) => JSON.stringify({ apiVersion: "v1", kind: "List", items });

const rowsOf = (app) =>
  app.js(`return Array.from(document.querySelectorAll('[data-testid="config-row"]'), (r) => ({
    key: r.dataset.key,
    verdict: r.querySelector('[data-testid="config-verdict"]')?.textContent.trim() ?? "",
    tone: r.dataset.tone,
    text: r.innerText,
  }))`);

const viewText = (app) => app.js(`return document.querySelector('[data-testid="image-security"]')?.innerText ?? ""`);

const configState = (app) =>
  app.js(`return document.querySelector('[data-testid="image-config-state"]')?.dataset.state ?? ""`);

async function openView(app) {
  await app.palette("image security", "Go to Image security");
  await app.find(byTestId("image-security"));
}

async function openTab(app, id) {
  await (await app.find(byTestId(`image-security-tab-${id}`))).click();
}

function enabledProfile() {
  const profile = createProfile();
  profile.writeSettings({
    version: 1,
    image_security: { enabled: true, min_severity: "high", only_fixable: false, excluded_namespaces: [], cache_ttl_hours: 24 },
  });
  return profile;
}

/** The ReplicaSet the Deployment made. */
function replicaSetOf(ns, deploy) {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const out = kubectl(["-n", ns, "get", "rs", "-l", `app=${deploy}`, "-o", "jsonpath={.items[0].metadata.name}"]);
    if (out) return out;
    if (Date.now() > deadline) throw new Error(`no ReplicaSet for deploy/${deploy}`);
    execFileSync("sleep", ["1"]);
  }
}

describe("misconfigurations", { timeout: 15 * 60_000 }, () => {
  let found = "";
  let none = "";
  before(() => {
    kubectl(["apply", "-f", CONFIG_CRD]);
    kubectl(["wait", "--for=condition=Established", "crd/configauditreports.aquasecurity.github.io", "--timeout=60s"]);
    found = tempNamespace("qa-config", deploymentYaml("web") + deploymentYaml("worker"));
    const web = replicaSetOf(found, "web");
    const worker = replicaSetOf(found, "worker");
    kubectl(
      ["-n", found, "apply", "-f", "-"],
      list([
        configReport(found, "ReplicaSet", web, [
          check("KSV017", "CRITICAL", "Privileged container", "Change 'containers[].securityContext.privileged' to 'false'."),
          check("KSV014", "HIGH", "Root file system is not read-only", "Change 'containers[].securityContext.readOnlyRootFilesystem' to 'true'."),
          check("KSV001", "MEDIUM", "Can elevate its own privileges", "Set 'containers[].securityContext.allowPrivilegeEscalation' to 'false'."),
          check("KSV011", "LOW", "CPU not limited", "Set a limit value under 'containers[].resources.limits.cpu'."),
          check("KSV012", "MEDIUM", "Runs as root user", "Set 'containers[].securityContext.runAsNonRoot' to 'true'.", true),
        ]),
        configReport(found, "ReplicaSet", worker, [
          check("KSV014", "HIGH", "Root file system is not read-only", "Change 'containers[].securityContext.readOnlyRootFilesystem' to 'true'."),
          check("KSV011", "LOW", "CPU not limited", "Set a limit value under 'containers[].resources.limits.cpu'."),
        ], 10),
        configReport(found, "Service", "api", [check("KSV100", "LOW", "Fine", "Nothing.", true)]),
      ]),
    );
    none = tempNamespace("qa-config-none", deploymentYaml("idle"));
  });
  after(() => {
    deleteNamespace(found);
    deleteNamespace(none);
  });

  const s = appSession("image-config", () => ({ profile: enabledProfile() }));

  it("the Configuration tab: one row per workload with what it fails (light)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "light");
    await waitLive(app);
    await openView(app);
    await pickNamespaces(app, [found]);
    await openTab(app, "config");
    const rows = await app.waitFor(
      async () => {
        const r = await rowsOf(app);
        return r.length === 3 ? r : null;
      },
      { timeout: 60_000, message: "three workload rows" },
    );
    const by = (key) => rows.find((r) => r.key === key);
    assert.equal(rows[0].key, `Deployment/${found}/web`, JSON.stringify(rows));
    assert.equal(by(`Deployment/${found}/web`).verdict, "Fails 2 checks: 1 critical and 1 high.");
    assert.equal(by(`Deployment/${found}/web`).tone, "critical");
    assert.equal(by(`Deployment/${found}/worker`).verdict, "Fails 1 high check.");
    assert.equal(by(`Deployment/${found}/worker`).tone, "high");
    assert.match(by(`Deployment/${found}/worker`).text, /old check/);
    assert.equal(by(`Service/${found}/api`).verdict, "Passes every check.");
    assert.match(await viewText(app), /2 workloads have settings to change/);
  });

  it("the panel says what to change; lower ones collapsed (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await (await app.find(By.css(`[data-testid="config-row"][data-key="Deployment/${found}/web"]`))).click();
    const panel = await app.find(byTestId("config-findings"));
    await app.waitFor(async () => (await panel.getText()).includes("What to change"), { message: "the checks in the panel" });
    const text = await app.js(`return document.querySelector('[data-testid="config-findings"]').innerText`);
    assert.match(text, /Privileged container/);
    assert.match(text, /Change 'containers\[\]\.securityContext\.privileged' to 'false'\./);
    assert.match(text, /Lower severity \(2\)/);
    assert.match(text, /1 check/);
    assert.equal(await app.js(`return document.querySelector('[data-testid="config-findings-lower"]').open`), false);
  });

  it("not checked yet: a namespace without reports (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await pickNamespaces(app, [none]);
    await app.waitFor(async () => (await configState(app)) === "no_reports", { timeout: 60_000, message: "no_reports" });
    assert.match(await viewText(app), /Not checked yet/);
  });

  it("the list in dark", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await pickNamespaces(app, [found]);
    await app.waitFor(async () => (await rowsOf(app)).length === 3, { timeout: 60_000, message: "three rows" });
  });
});

describe("a scanner on this computer only", { timeout: 10 * 60_000 }, () => {
  let found = "";
  before(() => {
    kubectl(["apply", "-f", CONFIG_CRD]);
    kubectl(["wait", "--for=condition=Established", "crd/configauditreports.aquasecurity.github.io", "--timeout=60s"]);
    found = tempNamespace("qa-config-local", deploymentYaml("web"));
    const web = replicaSetOf(found, "web");
    kubectl(
      ["-n", found, "apply", "-f", "-"],
      list([
        configReport(found, "ReplicaSet", web, [
          check("KSV017", "CRITICAL", "Privileged container", "Change 'containers[].securityContext.privileged' to 'false'."),
        ]),
      ]),
    );
  });
  after(() => deleteNamespace(found));

  const s = appSession("image-config-local", () => {
    const profile = createProfile();
    profile.writeSettings({
      version: 1,
      image_security: {
        enabled: true,
        min_severity: "high",
        only_fixable: false,
        excluded_namespaces: [],
        cache_ttl_hours: 24,
        source: "local",
        scanner: "trivy",
      },
    });
    return { profile };
  });

  it("the Configuration tab reads no reports and says why (light)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "light");
    await waitLive(app);
    await openView(app);
    await pickNamespaces(app, [found]);
    await openTab(app, "config");
    await app.find(byTestId("image-config-local"));
    const text = await viewText(app);
    assert.match(text, /Configuration checks come from the cluster/);
    assert.match(text, /scanner on this computer only/);
    // The report in the namespace is not listed: nothing was read.
    assert.equal((await rowsOf(app)).length, 0);
    assert.doesNotMatch(text, /Privileged container|Fails 1 check/);
  });

  it("the same state in dark, and after Refresh", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await app.js(`document.querySelector('button[aria-label="Refresh"]').click()`);
    await new Promise((r) => setTimeout(r, 1000));
    await app.find(byTestId("image-config-local"));
    assert.equal((await rowsOf(app)).length, 0);
  });
});

const staging = contexts().includes(STAGING);
const ks = (args, input) =>
  execFileSync("kubectl", ["--context", STAGING, ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] }).trim();

describe(
  "Kubescape on a cluster without the Trivy Operator",
  { timeout: 10 * 60_000, skip: staging ? false : `no ${STAGING} context (setup.sh --staging)` },
  () => {
    const ns = `qa-kubescape-${Date.now().toString(36)}`;
    before(() => {
      ks(["apply", "-f", KUBESCAPE_CRDS]);
      for (const crd of ["vulnerabilitymanifestsummaries", "vulnerabilitymanifests"])
        ks(["wait", "--for=condition=Established", `crd/${crd}.spdx.softwarecomposition.kubescape.io`, "--timeout=60s"]);
      ks(["create", "namespace", ns]);
      for (let i = 0; ; i++) {
        try {
          ks(["-n", ns, "get", "serviceaccount", "default"]);
          break;
        } catch (e) {
          if (i > 240) throw e;
          execFileSync("sleep", ["0.5"]);
        }
      }
      ks(["-n", ns, "apply", "-f", "-"], deploymentYaml("web"));
      const group = "spdx.softwarecomposition.kubescape.io/v1beta1";
      const match = (id, severity, pkg, version, fix) => ({
        vulnerability: {
          id,
          severity,
          dataSource: `https://security-tracker.debian.org/tracker/${id}`,
          description: `${pkg}: ${id}`,
          fix: fix ? { versions: [fix], state: "fixed" } : { versions: [], state: "not-fixed" },
        },
        artifact: { name: pkg, version },
      });
      ks(
        ["-n", ns, "apply", "-f", "-"],
        list([
          {
            apiVersion: group,
            kind: "VulnerabilityManifest",
            metadata: { name: "docker.io-library-nginx-1.27-qa", namespace: ns },
            spec: {
              payload: {
                matches: [
                  match("CVE-2026-5001", "Critical", "openssl", "3.0.11-1", "3.0.15-1"),
                  match("CVE-2026-5002", "High", "openssl", "3.0.11-1", "3.0.15-1"),
                  match("CVE-2026-5003", "High", "libc6", "2.36-9", ""),
                  match("CVE-2026-5004", "Negligible", "tar", "1.34", ""),
                ],
              },
            },
          },
          {
            apiVersion: group,
            kind: "VulnerabilityManifestSummary",
            metadata: {
              name: "deployment-web-app",
              namespace: ns,
              labels: {
                "kubescape.io/workload-kind": "deployment",
                "kubescape.io/workload-name": "web",
                "kubescape.io/workload-namespace": ns,
                "kubescape.io/workload-container-name": "app",
              },
              annotations: {
                "kubescape.io/image-tag": "nginx:1.27",
                "kubescape.io/timestamp": String(Math.floor(Date.now() / 1000) - 7200),
              },
            },
            spec: {
              severities: { critical: { all: 1 }, high: { all: 2 }, negligible: { all: 1 } },
              vulnerabilitiesRef: { all: { kind: "VulnerabilityManifest", name: "docker.io-library-nginx-1.27-qa", namespace: ns } },
            },
          },
        ]),
      );
    });
    after(() => {
      try {
        ks(["delete", "namespace", ns, "--wait=false"]);
      } catch {}
      try {
        ks(["delete", "-f", KUBESCAPE_CRDS, "--wait=false"]);
      } catch {}
    });

    const s = appSession("image-config-kubescape", () => ({ contexts: [STAGING], profile: enabledProfile() }));

    it("the Vulnerabilities tab reads Kubescape's summaries without claiming a fix (light)", T, async () => {
      const { app } = s;
      await resizeWindow(app, 1280, 800);
      await setTheme(app, "light");
      await waitLive(app);
      await openView(app);
      await pickNamespaces(app, [ns]);
      const row = await app.waitFor(
        async () =>
          app.js(`const r = document.querySelector('[data-testid="image-row"]');
            return r && r.dataset.kind !== "unscanned" ? { verdict: r.querySelector('[data-testid="image-verdict"]').textContent.trim(), tone: r.dataset.tone, text: r.innerText } : null`),
        { timeout: 60_000, message: "the Kubescape row" },
      );
      assert.equal(row.verdict, "1 critical and 2 high. Open it to see which have a fix.");
      assert.equal(row.tone, "high");
      assert.match(row.text, /Kubescape scan, 2 hours ago/);
      assert.match(await viewText(app), /1 image has known vulnerabilities/);
    });

    it("the panel reads the manifest and lists the fixes (dark)", T, async () => {
      const { app } = s;
      await setTheme(app, "dark");
      await (await app.find(byTestId("image-row"))).click();
      const panel = await app.find(byTestId("image-findings"));
      await app.waitFor(async () => (await panel.getText()).includes("Updating openssl"), { message: "the fixes" });
      const text = await app.js(`return document.querySelector('[data-testid="image-findings"]').innerText`);
      assert.match(text, /1 critical and 2 high\. 2 of 3 have a fix\./);
      assert.match(text, /Updating openssl to 3\.0\.15-1 fixes 2 \(1 critical\)\./);
      assert.match(text, /Kubescape scan/);
    });

    it("the Configuration tab: no configuration audits here (light)", T, async () => {
      const { app } = s;
      await setTheme(app, "light");
      await openTab(app, "config");
      await app.waitFor(async () => (await configState(app)) === "no_operator", { timeout: 60_000, message: "no_operator" });
      assert.match(await viewText(app), /This cluster has no configuration audits/);
    });
  },
);

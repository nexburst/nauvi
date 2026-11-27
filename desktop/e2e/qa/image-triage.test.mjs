// Ignores and known exploited vulnerabilities (#537, ADR 0011 amendment)
// in the real app against kind, with fixture VulnerabilityReports (no
// operator runs) and the KEV catalogue from a local HTTPS server with its
// own test CA (the debug-only NAUVI_KEV_URL and NAUVI_KEV_CA): nothing
// reaches www.cisa.gov.
// - a .trivyignore in the profile's home: its id is ignored and counted
//   ("1 ignored."), with its comment as the reason
// - an ignore from the panel needs a reason; it is counted on the row and
//   listed in the panel and in Settings
// - the KEV download is off by default and makes no request; turned on, one
//   request, the finding is marked "known to be exploited in the wild" and
//   the row is red
// - an ignore file that cannot be read says so
// Light and dark theme at 1280x800. Needs openssl for the test
// certificates; the KEV part is skipped without it.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const HAVE_OPENSSL = spawnSync("openssl", ["version"]).status === 0;

const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-537-"));
const served = { requests: [] };
let server;
let kevUrl = "";

const KEV = {
  title: "CISA Catalog of Known Exploited Vulnerabilities",
  catalogVersion: "2026.11.25",
  dateReleased: "2026-11-25T19:48:12.4344Z",
  count: 3,
  vulnerabilities: [
    { cveID: "CVE-2026-1002", dateAdded: "2026-11-20", knownRansomwareCampaignUse: "Known" },
    { cveID: "CVE-2026-1005", dateAdded: "2026-11-21", knownRansomwareCampaignUse: "Unknown" },
    { cveID: "CVE-2021-44228", dateAdded: "2021-12-10", knownRansomwareCampaignUse: "Known" },
  ],
};

function makeCerts() {
  const ossl = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2",
    "-subj", "/CN=nauvi QA 537 CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
  ossl("req", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-subj", "/CN=127.0.0.1");
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
  ossl("x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.pem",
    "-days", "2", "-extfile", "ext.cnf");
}

async function startServer() {
  makeCerts();
  server = createServer(
    { key: readFileSync(join(dir, "server.key")), cert: readFileSync(join(dir, "server.pem")) },
    (req, res) => {
      served.requests.push({ url: req.url, method: req.method, headers: req.headers });
      if (req.url !== "/feeds/known_exploited_vulnerabilities.json") {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(KEV));
    },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  kevUrl = `https://127.0.0.1:${server.address().port}/feeds/known_exploited_vulnerabilities.json`;
}

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
  lastModifiedDate: "2026-01-01T00:00:00Z",
  publishedDate: "2026-01-01T00:00:00Z",
});

function reportJson(ns, name, repository, tag, vulns) {
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
      updateTimestamp: new Date(Date.now() - 3600_000).toISOString(),
      vulnerabilities: vulns,
    },
  };
}

const profile = createProfile();
const ignoreFile = join(profile.home, "project", ".trivyignore");

const viewRows = (app) =>
  app.js(`return Array.from(document.querySelectorAll('[data-testid="image-row"]'), (r) => ({
    image: r.querySelector('.image')?.textContent.trim() ?? "",
    verdict: r.querySelector('[data-testid="image-verdict"]')?.textContent.trim() ?? "",
    tone: r.dataset.tone,
  }))`);
const textOf = (app, testId) =>
  app.js(`return [...document.querySelectorAll('[data-testid="${testId}"]')].map((e) => e.innerText).join(" | ")`);

/** Set an input's or select's value as a person would (input, then change). */
const setValue = (app, css, value) =>
  app.js(
    `const el = document.querySelector(arguments[0]);
     el.value = arguments[1];
     el.dispatchEvent(new Event("input", { bubbles: true }));
     el.dispatchEvent(new Event("change", { bubbles: true }));`,
    css,
    value,
  );

async function openSettings(app) {
  await app.js("document.activeElement?.blur()");
  await app.driver.actions().keyDown(Key.CONTROL).sendKeys(",").keyUp(Key.CONTROL).perform();
  await app.find(byTestId("settings"));
  await app.js(`document.querySelector('[data-testid="image-triage-settings"]')?.scrollIntoView({ block: "center" })`);
}

async function closeSettings(app) {
  await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("settings"))).length === 0, {
    message: "Settings closed",
  });
}

async function nginxRow(app, pred, message) {
  return app.waitFor(
    async () => {
      const r = (await viewRows(app)).find((x) => x.image === "nginx:1.27");
      return r && pred(r) ? r : null;
    },
    { timeout: 60_000, message },
  );
}

describe("image security: ignores and known exploited (#537)", { timeout: 15 * 60_000 }, () => {
  let ns = "";
  before(async () => {
    if (HAVE_OPENSSL) await startServer();
    ns = tempNamespace("qa-triage", podYaml("web", "nginx:1.27") + podYaml("tool", "busybox:1.36"));
    kubectl(
      ["-n", ns, "apply", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "List",
        items: [
          reportJson(ns, "web", "library/nginx", "1.27", [
            vuln("CVE-2026-1001", "openssl", "CRITICAL", "3.0.15-1", "3.0.11-1"),
            vuln("CVE-2026-1002", "openssl", "HIGH", "3.0.14-1", "3.0.11-1"),
            vuln("CVE-2026-1003", "curl", "HIGH", "", "7.88.1-10"),
            vuln("CVE-2026-1004", "libc6", "HIGH", "", "2.36-9"),
            // Below the High counted by default: shows once it is on the KEV list.
            vuln("CVE-2026-1005", "zlib1g", "MEDIUM", "", "1:1.2.13"),
          ]),
          reportJson(ns, "tool", "library/busybox", "1.36", []),
        ],
      }),
    );
    execFileSync("mkdir", ["-p", join(profile.home, "project")]);
    writeFileSync(ignoreFile, "# curl is only used at build time\nCVE-2026-1003\n");
    profile.writeSettings({
      version: 1,
      image_security: {
        enabled: true,
        min_severity: "high",
        only_fixable: false,
        excluded_namespaces: [],
        cache_ttl_hours: 24,
        ignore_file: ignoreFile,
      },
    });
  });

  const s = appSession("image-triage", async () => ({
    profile,
    env: HAVE_OPENSSL ? { NAUVI_KEV_URL: kevUrl, NAUVI_KEV_CA: join(dir, "ca.pem") } : {},
  }));
  after(() => {
    deleteNamespace(ns);
    server?.close();
    rmSync(dir, { recursive: true, force: true });
    profile.remove();
  });

  it("the ignore file's id is ignored and counted, never hidden (light)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "light");
    await waitLive(app);
    await app.palette("image security", "Go to Image security");
    await app.find(byTestId("image-security"));
    await pickNamespaces(app, [ns]);
    const row = await nginxRow(app, (r) => /ignored/.test(r.verdict), "the nginx row with its ignored count");
    assert.equal(row.verdict, "1 critical and 2 high. 2 of 3 have a fix. 1 ignored.");
    assert.equal(row.tone, "critical");
    await (await app.find(By.css('[data-testid="image-row"][data-key^="nginx:1.27@"]'))).click();
    await app.find(byTestId("findings-ignored"));
    await app.js(`document.querySelector('[data-testid="findings-ignored"]').open = true`);
    const ignored = await textOf(app, "findings-ignored");
    assert.match(ignored, /Ignored \(1\): not counted/);
    assert.match(ignored, /CVE-2026-1003/);
    assert.match(ignored, /curl is only used at build time \(ignore file\)/);
    assert.equal(served.requests.length, 0, "no KEV request while it is off");
  });

  it("an ignore from the panel needs a reason and is counted (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await app.js(`document.querySelector('[data-testid="ignore-form"]').open = true`);
    const form = '[data-testid="ignore-form"]';
    await setValue(app, `${form} select[aria-label="Vulnerability to ignore"]`, "CVE-2026-1001");
    await setValue(app, `${form} select[aria-label="Where to ignore it"]`, "workload");
    const disabled = await app.js(
      `return [...document.querySelectorAll('${form} button')].find((b) => b.textContent.trim() === "Ignore").disabled`,
    );
    assert.equal(disabled, true, "no reason: Ignore is off");
    await setValue(app, `${form} input[aria-label="Why it is ignored"]`, "Not reachable: no TLS in this pod");
    await app.js(
      `[...document.querySelectorAll('${form} button')].find((b) => b.textContent.trim() === "Ignore").click()`,
    );
    const row = await nginxRow(app, (r) => /2 ignored/.test(r.verdict), "two ignored on the row");
    assert.equal(row.verdict, "2 high. 1 of 2 has a fix. 2 ignored.");
    await app.waitFor(async () => /Ignored \(2\)/.test(await textOf(app, "findings-ignored")), {
      message: "two ignored in the panel",
    });
    await app.js(`document.querySelector('[data-testid="findings-ignored"]').open = true`);
    assert.match(await textOf(app, "findings-ignored"), /Not reachable: no TLS in this pod/);
    await app.waitFor(() => (s.app.profile.settings()?.image_security?.ignores ?? []).length === 1, {
      message: "the ignore in settings.json",
    });
    const saved = s.app.profile.settings().image_security.ignores[0];
    assert.equal(saved.id, "CVE-2026-1001");
    assert.equal(saved.scope, "workload");
    assert.equal(saved.name, "web");
    assert.ok(saved.expires > Date.now() / 1000 + 80 * 86400, "90 days by default");
  });

  it("Settings: the ignore file, the ignores, KEV off by default (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await openSettings(app);
    await app.waitFor(async () => /1 ignore read/.test(await textOf(app, "ignore-file-status")), {
      message: "the ignore file's status",
    });
    assert.match(await textOf(app, "ignore-rule"), /CVE-2026-1001.*in Deployment|CVE-2026-1001.*in Pod web in/s);
    const box = 'input[aria-label="Download the list of known exploited vulnerabilities"]';
    assert.equal(await app.js(`return document.querySelector('${box}').checked`), false, "off by default");
    const text = await textOf(app, "image-triage-settings");
    assert.match(text, /Off unless you turn it on/);
    assert.match(text, /Nothing about your clusters or images is sent/);
    assert.equal(served.requests.length, 0);
  });

  it("KEV turned on: one download, the finding is known exploited and red (light, then dark)", T, async (t) => {
    if (!HAVE_OPENSSL) {
      t.skip("needs openssl for the test certificates");
      return;
    }
    const { app } = s;
    await app.js(`document.querySelector('input[aria-label="Download the list of known exploited vulnerabilities"]').click()`);
    await app.waitFor(async () => /Catalogue 2026\.11\.25, 3 vulnerabilities/.test(await textOf(app, "kev-status")), {
      message: "the catalogue's status",
    });
    assert.equal(served.requests.length, 1, JSON.stringify(served.requests.map((r) => r.url)));
    assert.equal(served.requests[0].method, "GET");
    assert.equal(served.requests[0].headers.cookie, undefined);
    assert.equal(served.requests[0].headers.authorization, undefined);
    await app.shot("kev settings");
    await closeSettings(app);
    await setTheme(app, "dark");
    const row = await nginxRow(app, (r) => /known to be exploited/.test(r.verdict), "the KEV mark on the row");
    assert.equal(row.verdict, "2 known to be exploited in the wild. 2 high. 1 of 2 has a fix. 2 ignored.");
    assert.equal(row.tone, "critical");
    await app.waitFor(async () => /CVE-2026-1002/.test(await textOf(app, "findings-kev")), {
      message: "the KEV section of the panel",
    });
    // The medium one too, although the panel counts High and worse.
    await app.waitFor(async () => /CVE-2026-1005/.test(await textOf(app, "findings-kev")), {
      message: "the medium KEV finding in the panel",
    });
    assert.match(await textOf(app, "findings-kev"), /Known to be exploited in the wild \(2\)/);
    await app.shot("kev panel with a medium finding");
    // Kept for the user only.
    const kept = join(profile.home, ".cache", "com.nauvi.app", "known-exploited", "known-exploited.json");
    const mode = Number(execFileSync("stat", ["-c", "%a", kept]).toString().trim());
    assert.equal(mode, 600);
    // Shown again: no new download within a day.
    await app.nav("Pods");
    await app.palette("image security", "Go to Image security");
    await nginxRow(app, (r) => /known to be exploited/.test(r.verdict), "the KEV mark again");
    assert.equal(served.requests.length, 1);
  });

  it("an ignore file that cannot be read says so (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await openSettings(app);
    await setValue(app, 'input[aria-label="Ignore file"]', join(profile.home, "missing", ".trivyignore"));
    await app.waitFor(async () => /Cannot read the ignore file/.test(await textOf(app, "ignore-file-error")), {
      message: "the ignore file's error",
    });
  });
});

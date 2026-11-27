// The local scanner (#536, ADR 0011) in the real app against kind, with a
// fake `trivy` first on the app's PATH (a shell script that records its
// arguments and prints fixture JSON; nothing is pulled or downloaded).
// - Settings: found on PATH, not approved, and nothing of it ran yet;
//   approved, its version and database shown
// - local only: the pods' images, not scanned until "Scan N images"; then
//   verdicts, and the reference passed after `--` by digest with
//   --platform from the nodes. Only rows whose pods report a registry
//   digest can be scanned (a `kind load`ed image may have none in CI): the
//   scenario finds them by their key (`image@digest`), and a row without
//   one says why
// - the panel: what to update; Cancel kills a slow scan; an unreachable
//   registry says so plainly
// - a changed binary is asked about again; a malicious Trivy version is
//   refused
// Light and dark theme at 1280x800.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

const sleepPod = (name, image) => `---
apiVersion: v1
kind: Pod
metadata:
  name: ${name}
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: ${image}
      imagePullPolicy: IfNotPresent
      command: ["sleep", "3600"]
`;

const vuln = (id, pkg, installed, fixed, severity) => ({
  VulnerabilityID: id,
  PkgName: pkg,
  InstalledVersion: installed,
  FixedVersion: fixed,
  Severity: severity,
  Title: `${pkg}: ${id}`,
  PrimaryURL: `https://avd.aquasec.com/nvd/${id.toLowerCase()}`,
  CVSS: { nvd: { V3Score: 7.5 } },
});

const report = (vulns) => JSON.stringify({ SchemaVersion: 2, Results: [{ Target: "x", Class: "os-pkgs", Vulnerabilities: vulns }] });

/** The fake trivy: its behaviour comes from files in `dir`. */
function fakeTrivy(dir, version) {
  return `#!/bin/sh
# fake trivy for the nauvi QA scenario (#536)
d='${dir}'
if [ "$1" = version ]; then
  echo version >> "$d/calls"
  echo '{"Version":"${version}","VulnerabilityDB":{"Version":2,"UpdatedAt":"2026-11-25T06:13:33Z"}}'
  exit 0
fi
echo $$ > "$d/pid"
for a in "$@"; do printf '%s\\n' "$a"; done > "$d/argv"
echo scan >> "$d/calls"
if [ -f "$d/slow" ]; then sleep 120; fi
if [ -f "$d/unreachable" ]; then
  printf '%s\\tFATAL\\tFatal error\\timage scan error: unable to find the specified image: Get "https://index.docker.io/v2/": dial tcp: lookup index.docker.io: no such host\\n' "2026-11-26T10:00:00Z" >&2
  exit 1
fi
cat "$d/report.json"
`;
}

const viewText = (app) => app.js(`return document.querySelector('[data-testid="image-security"]')?.innerText ?? ""`);
const rows = (app) =>
  app.js(`return Array.from(document.querySelectorAll('[data-testid="image-row"]'), (r) => ({
    key: r.dataset.key,
    digest: r.dataset.key.slice(r.dataset.key.lastIndexOf("@") + 1),
    image: r.querySelector('.image')?.textContent.trim() ?? "",
    verdict: r.querySelector('[data-testid="image-verdict"]')?.textContent.trim() ?? "",
    text: r.innerText,
  }))`);
const scannerState = (app) =>
  app.js(`return document.querySelector('[data-testid="image-scanner-status"]')?.dataset.state ?? ""`);
const scannerText = (app) =>
  app.js(`return document.querySelector('[data-testid="image-scanner-status"]')?.innerText ?? ""`);

async function openSettings(app) {
  await app.js("document.activeElement?.blur()");
  await app.driver.actions().keyDown(Key.CONTROL).sendKeys(",").keyUp(Key.CONTROL).perform();
  await app.find(byTestId("settings"));
  await app.js(`document.querySelector('[data-testid="image-scanner-settings"]')?.scrollIntoView({ block: "center" })`);
}

async function closeSettings(app) {
  await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("settings"))).length === 0, { message: "Settings closed" });
}

describe("image scan with a local trivy", { timeout: 15 * 60_000 }, () => {
  let ns = "";
  let dir = "";
  let profile = null;
  before(() => {
    ns = tempNamespace("qa-scan", sleepPod("tool", "busybox:1.36") + sleepPod("web", "nginx:1.27"));
    kubectl(["-n", ns, "wait", "--for=condition=Ready", "pod", "--all", "--timeout=120s"]);
    dir = mkdtempSync(join(tmpdir(), "nauvi-qa-trivy-"));
    writeFileSync(
      join(dir, "report.json"),
      report([
        vuln("CVE-2026-1001", "openssl", "3.0.11-1", "3.0.15-1", "CRITICAL"),
        vuln("CVE-2026-1002", "curl", "7.88.1-10", "7.88.1-10+deb12u8", "HIGH"),
        vuln("CVE-2026-1003", "libc6", "2.36-9", "", "HIGH"),
      ]),
    );
    profile = createProfile();
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
    const trivy = join(profile.bin, "trivy");
    writeFileSync(trivy, fakeTrivy(dir, "0.58.1"));
    chmodSync(trivy, 0o755);
  });
  after(() => {
    deleteNamespace(ns);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const s = appSession("image-scan", () => ({ profile }));
  /** The keys of the rows that can be scanned (their pods report a digest). */
  let scannable = [];
  let unscannable = [];
  const plural = (n) => `${n} ${n === 1 ? "image" : "images"}`;
  const trivyPath = () => join(profile.bin, "trivy");
  const calls = () => (existsSync(join(dir, "calls")) ? readFileSync(join(dir, "calls"), "utf8").split("\n").filter(Boolean) : []);

  it("settings: found on PATH, not approved, and it has not run (light)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "light");
    await waitLive(app);
    await openSettings(app);
    await app.waitFor(async () => (await scannerState(app)) === "unapproved", { timeout: 30_000, message: "unapproved" });
    assert.match(await scannerText(app), /Trivy found at .*trivy \(on PATH\)\. nauvi runs it only once you approve it\./);
    assert.deepEqual(calls(), [], "the scanner ran before it was approved");
  });

  it("approved: its version and database (light)", T, async () => {
    const { app } = s;
    await (await app.find(byTestId("image-scanner-approve"))).click();
    await app.waitFor(async () => (await scannerState(app)) === "ready", { timeout: 30_000, message: "ready" });
    assert.match(await scannerText(app), /Trivy 0\.58\.1 at .*trivy\. Its database was built 2026-11-25\./);
    assert.deepEqual(calls(), ["version"]);
    const approval = JSON.parse(readFileSync(join(profile.configDir, "image-scanner.json"), "utf8"));
    assert.equal(approval.approved[0].scanner, "trivy");
    assert.equal(approval.approved[0].binary.sha256.length, 64);
  });

  it("local only: the pods' images, not scanned until the click (light)", T, async () => {
    const { app } = s;
    await closeSettings(app);
    await app.palette("image security", "Go to Image security");
    await app.find(byTestId("image-security"));
    await pickNamespaces(app, [ns]);
    const r = await app.waitFor(
      async () => {
        const got = await rows(app);
        return got.length === 2 ? got : null;
      },
      { timeout: 60_000, message: "two image rows" },
    );
    assert.ok(r.every((x) => x.verdict === "Not scanned yet."), JSON.stringify(r));
    scannable = r.filter((x) => x.digest.startsWith("sha256:")).map((x) => x.key);
    unscannable = r.filter((x) => !x.digest.startsWith("sha256:")).map((x) => x.key);
    assert.ok(scannable.length > 0, `no pod reports a digest: ${JSON.stringify(r)}`);
    assert.match(await viewText(app), new RegExp(`${plural(scannable.length)} not scanned yet\\.`));
    assert.match(await viewText(app), new RegExp(`Scan ${plural(scannable.length)} with Trivy`));
    assert.deepEqual(calls(), ["version"], "opening the view scanned something");
  });

  it("Scan all: verdicts, by digest after -- with the nodes' platform (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await (await app.find(byTestId("image-scan-all"))).click();
    await app.waitFor(
      async () => (await rows(app)).filter((x) => scannable.includes(x.key)).every((x) => x.verdict !== "Not scanned yet."),
      { timeout: 60_000, message: "the scannable rows scanned" },
    );
    const r = await rows(app);
    for (const x of r.filter((x) => scannable.includes(x.key))) {
      assert.equal(x.verdict, "1 critical and 2 high. 2 of 3 have a fix.", x.image);
      assert.match(x.text, /Trivy 0\.58\.1 on this computer/);
    }
    for (const x of r.filter((x) => unscannable.includes(x.key))) assert.equal(x.verdict, "Not scanned yet.");
    assert.equal(calls().filter((c) => c === "scan").length, scannable.length);
    const argv = readFileSync(join(dir, "argv"), "utf8").split("\n").filter(Boolean);
    assert.equal(argv[0], "image");
    assert.ok(argv.includes("--format=json"), argv.join(" "));
    assert.ok(argv.includes("--platform=linux/amd64"), argv.join(" "));
    assert.equal(argv[argv.length - 2], "--");
    assert.match(argv[argv.length - 1], /^docker\.io\/library\/(nginx|busybox)@sha256:[0-9a-f]{64}$/);
    if (unscannable.length === 0) assert.match(await viewText(app), /Every running image here was scanned\./);
    else {
      assert.doesNotMatch(await viewText(app), /Every running image here was scanned/);
      assert.match(await viewText(app), /cannot be scanned: no pod reports which digest/);
    }
  });

  it("a row whose pods report no digest says why it is not scanned (dark)", T, async (t) => {
    const { app } = s;
    if (unscannable.length === 0) return t.skip("every pod reports a registry digest here");
    await (await app.find(By.css(`[data-testid="image-row"][data-key="${unscannable[0]}"]`))).click();
    const action = await app.find(byTestId("image-scan-action"));
    assert.match(await action.getText(), /No pod reports which digest it runs yet/);
  });

  it("the panel says what to update (dark)", T, async () => {
    const { app } = s;
    await (await app.find(By.css(`[data-testid="image-row"][data-key="${scannable[0]}"]`))).click();
    const panel = await app.find(byTestId("image-findings"));
    await app.waitFor(async () => (await panel.getText()).includes("Updating openssl"), { message: "fixes" });
    const text = await panel.getText();
    assert.match(text, /Updating openssl to 3\.0\.15-1 fixes 1 critical\./);
    assert.match(text, /Trivy 0\.58\.1 on this computer/);
    assert.match(text, /Scan again/);
  });

  it("Cancel stops a slow scan and its process (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    writeFileSync(join(dir, "slow"), "");
    rmSync(join(dir, "pid"), { force: true });
    await (await app.find(byTestId("image-scan-one"))).click();
    await app.find(byTestId("image-scan-progress"));
    await app.waitFor(() => existsSync(join(dir, "pid")), { timeout: 30_000, message: "the scan started" });
    const pid = readFileSync(join(dir, "pid"), "utf8").trim();
    await app.shot("scanning");
    await (await app.find(byTestId("image-scan-cancel-one"))).click();
    const err = await app.find(byTestId("image-scan-error"));
    assert.equal(await err.getText(), "The scan was cancelled.");
    await app.waitFor(
      () => {
        const stat = existsSync(`/proc/${pid}/stat`) ? readFileSync(`/proc/${pid}/stat`, "utf8") : "";
        return stat === "" || /\) Z /.test(stat);
      },
      { timeout: 15_000, message: "the scanner process ended" },
    );
    rmSync(join(dir, "slow"), { force: true });
  });

  it("an unreachable registry says so (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    writeFileSync(join(dir, "unreachable"), "");
    await (await app.find(byTestId("image-scan-one"))).click();
    const err = await app.waitFor(
      async () => {
        const els = await app.driver.findElements(byTestId("image-scan-error"));
        const t = els.length ? await els[0].getText() : "";
        return t.startsWith("This computer cannot reach") ? t : null;
      },
      { timeout: 30_000, message: "the unreachable message" },
    );
    assert.match(err, /This computer cannot reach the registry docker\.io\. The scanner runs here, not in the cluster/);
    assert.doesNotMatch(err, /FATAL/);
    rmSync(join(dir, "unreachable"), { force: true });
  });

  it("a changed binary is asked about again (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    // An "update": another file at the same path.
    writeFileSync(trivyPath(), fakeTrivy(dir, "0.58.2") + "# updated\n");
    chmodSync(trivyPath(), 0o755);
    // Opening Settings checks the file again.
    await openSettings(app);
    await app.waitFor(async () => (await scannerState(app)) === "changed", { timeout: 30_000, message: "changed" });
    assert.match(await scannerText(app), /changed since you approved it/);
  });

  it("a malicious Trivy release is refused (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    writeFileSync(trivyPath(), fakeTrivy(dir, "0.69.4"));
    chmodSync(trivyPath(), 0o755);
    await (await app.find(byTestId("image-scanner-approve"))).click();
    await app.waitFor(async () => (await scannerState(app)) === "refused", { timeout: 30_000, message: "refused" });
    assert.match(await scannerText(app), /Trivy 0\.69\.4 is one of the malicious releases .*CVE-2026-33634/);
    const approval = JSON.parse(readFileSync(join(profile.configDir, "image-scanner.json"), "utf8"));
    assert.deepEqual(approval.approved, []);
    // Nothing was scanned with it: the scans of Scan all, the cancelled one
    // and the unreachable one.
    assert.equal(calls().filter((c) => c === "scan").length, scannable.length + 2);
  });
});

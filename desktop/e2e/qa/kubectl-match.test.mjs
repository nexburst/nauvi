// A kubectl matching the cluster for the local terminal (#331).
//
// The app's own kubectl is a stub on PATH that says it is v1.20.0, far from
// the kind cluster, and the download comes from a local HTTPS server (with
// its own test CA) through the debug-only NAUVI_KUBECTL_DOWNLOAD_BASE and
// NAUVI_KUBECTL_DOWNLOAD_CA: nothing reaches dl.k8s.io.
// Checks: off by default (no offer); the setting in Settings; the offer
// above a local terminal makes no request; a tampered binary (its SHA-256
// does not match the published one) is refused and nothing is saved; a good
// one is saved privately (0700) under the app's data dir; a new local
// terminal runs it first on PATH while the user's kubectl stays as it was;
// light and dark theme.
// Needs openssl (for the test certificates); skipped without it.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId, CONTEXT } from "../lib/app.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";
import { setTheme } from "../lib/theme.mjs";

const T = { timeout: 120_000 };
const LINUX = process.platform === "linux";
const HAVE_OPENSSL = spawnSync("openssl", ["version"]).status === 0;
const SKIP = !LINUX
  ? "Linux only (the stub kubectl is a shell script)"
  : !HAVE_OPENSSL
    ? "needs openssl for the test certificates"
    : false;

const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-331-"));
const userBin = join(dir, "user-bin");
const userKubectl = join(userBin, "kubectl");
const USER_KUBECTL = `#!/bin/sh
if [ "$1" = version ]; then echo '{"clientVersion":{"major":"1","minor":"20","gitVersion":"v1.20.0"}}'; exit 0; fi
echo "USER-KUBECTL $*"
`;
// What the server hands out as "kubectl": says the version it was asked for.
const served = { tamper: false, requests: [] };
const matchedKubectl = (v) => `#!/bin/sh
if [ "$1" = version ]; then echo '{"clientVersion":{"gitVersion":"${v}"}}'; exit 0; fi
echo "MATCHED-KUBECTL ${v} $*"
`;

let server;
let base;
const profile = createProfile();
const dataDir = join(profile.home, ".local", "share", "com.nauvi.app", "kubectl");

function makeCerts() {
  const ossl = (...args) => execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
  ossl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "2",
    "-subj", "/CN=nauvi QA 331 CA", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign");
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
      served.requests.push(req.url);
      const m = req.url.match(/^\/release\/(v1\.\d+\.\d+)\/bin\/linux\/(amd64|arm64)\/kubectl(\.sha256)?$/);
      if (!m) {
        res.writeHead(404).end("not found");
        return;
      }
      const body = matchedKubectl(m[1]);
      if (m[3]) {
        const published = served.tamper ? body + "# the published one" : body;
        res.writeHead(200, { "content-type": "text/plain" }).end(createHash("sha256").update(published).digest("hex"));
      } else {
        res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
      }
    },
  );
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `https://127.0.0.1:${server.address().port}`;
}

const offerText = (app) => app.js(`return document.querySelector('[data-testid="kubectl-offer"]')?.innerText ?? ""`);

async function newLocalTerminal(app) {
  await app.palette("local term", "New local terminal");
}

async function openSettings(app) {
  await app.js("document.activeElement?.blur()");
  await app.driver.actions().keyDown(Key.CONTROL).sendKeys(",").keyUp(Key.CONTROL).perform();
  await app.find(byTestId("settings"));
  await app.js(`document.querySelector('[data-testid="kubectl-settings"]').scrollIntoView()`);
}

async function closeSettings(app) {
  await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
}

async function closeDockTabs(app) {
  await app.js(`for (const b of document.querySelectorAll('[data-testid="dock"] button[aria-label^="Close "]')) b.click();`);
}

describe("kubectl matching the cluster (#331)", { timeout: 10 * 60_000, skip: SKIP }, () => {
  before(async () => {
    mkdirSync(userBin, { recursive: true });
    writeFileSync(userKubectl, USER_KUBECTL);
    chmodSync(userKubectl, 0o755);
    await startServer();
  });
  const s = appSession("kubectl-match", async () => ({
    profile,
    env: {
      SHELL: existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh",
      PATH: [profile.bin, userBin, process.env.PATH].join(delimiter),
      NAUVI_KUBECTL_DOWNLOAD_BASE: base,
      NAUVI_KUBECTL_DOWNLOAD_CA: join(dir, "ca.pem"),
    },
  }));
  // After the app's own `after`, which closes it.
  after(() => {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
    profile.remove();
  });

  it("offers nothing while the setting is off", T, async () => {
    const { app } = s;
    await waitLive(app);
    await newLocalTerminal(app);
    const term = terminal(app);
    await term.waitFor(`kubectl uses context ${CONTEXT}`);
    await term.waitForPrompt();
    assert.match(await term.run("kubectl get pods"), /USER-KUBECTL get pods/);
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(await offerText(app), "");
    assert.deepEqual(served.requests, []);
    await closeDockTabs(app);
  });

  it("turns the offer on in Settings", T, async () => {
    const { app } = s;
    await openSettings(app);
    const box = await app.find(By.css('[data-testid="kubectl-settings"] input[type="checkbox"]'));
    assert.equal(await box.isSelected(), false);
    await box.click();
    await app.waitFor(async () => profile.settings()?.kubectl_match === true, { message: "kubectl_match saved" });
  });

  it("offers the cluster's version above a new local terminal, without downloading", T, async () => {
    const { app } = s;
    await closeSettings(app);
    await newLocalTerminal(app);
    const text = await app.waitFor(async () => (await offerText(app)) || null, { message: "the kubectl offer" });
    assert.match(text, /Your kubectl v1\.20\.0 is more than one minor version from the cluster's v1\.\d+\.\d+/);
    assert.ok(text.includes(`${base}/release/`), text);
    assert.deepEqual(served.requests, [], "nothing is fetched before the click");
  });

  it("refuses a binary whose SHA-256 does not match the published one", T, async () => {
    const { app } = s;
    served.tamper = true;
    await (await app.find(By.xpath("//*[@data-testid='kubectl-offer']//button[starts-with(normalize-space(), 'Download kubectl')]"))).click();
    const text = await app.waitFor(async () => ((await offerText(app)).includes("does not match") ? offerText(app) : null), {
      message: "the checksum error",
    });
    assert.match(text, /It was not saved/);
    assert.equal(served.requests.length, 2);
    assert.ok(served.requests[0].endsWith(".sha256"), served.requests[0]);
    assert.ok(!existsSync(dataDir) || spawnSync("find", [dataDir, "-type", "f"]).stdout.toString().trim() === "",
      "nothing saved");
  });

  it("downloads, checks and saves a good one privately", T, async () => {
    const { app } = s;
    served.tamper = false;
    await (await app.find(By.xpath("//*[@data-testid='kubectl-offer']//button[normalize-space()='Try again']"))).click();
    await app.waitFor(async () => (await offerText(app)).includes("SHA-256 checked"), { message: "downloaded" });
    const version = served.requests.at(-1).match(/release\/(v[\d.]+)\//)[1];
    const binary = join(dataDir, version, "kubectl");
    assert.ok(existsSync(binary), binary);
    assert.equal(statSync(binary).mode & 0o777, 0o700);
    assert.equal(statSync(join(dataDir, version)).mode & 0o777, 0o700);
    assert.equal(readFileSync(binary, "utf8"), matchedKubectl(version));
  });

  it("a new local terminal runs it first on PATH; the user's kubectl is unchanged", T, async () => {
    const { app } = s;
    await (await app.find(By.xpath("//*[@data-testid='kubectl-offer']//button[normalize-space()='Open a new local terminal']"))).click();
    const term = terminal(app);
    await term.waitFor("downloaded to match the cluster");
    await term.waitForPrompt();
    assert.match(await term.run("kubectl get pods"), /MATCHED-KUBECTL v1\.\d+\.\d+ get pods/);
    assert.ok((await term.run("command -v kubectl")).startsWith(dataDir), "the download is first on PATH");
    assert.equal(await offerText(app), "");
    assert.equal(readFileSync(userKubectl, "utf8"), USER_KUBECTL, "the user's kubectl is untouched");
  });

  it("looks right in the dark theme", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    // The first terminal (the user's kubectl) still shows the done notice.
    await app.js(`document.querySelector('[data-testid="dock"] [role="tab"]')?.click()`);
    await app.waitFor(async () => (await offerText(app)).includes("SHA-256 checked"), { message: "the done notice" });
  });
});

// A cluster that reports an ancient Kubernetes version gets no kubectl
// download (#444).
//
// The version of the matching-kubectl offer (#331) comes from the API
// server's /version, so a hostile cluster could say v1.10.0 and get the
// user a kubectl with the old `kubectl cp` path-traversal bugs. Here the app
// talks to the kind cluster through a local plain-http stand-in that passes
// every request on (with the kind user's client certificate) but answers
// /version with v1.10.0. The user's kubectl is a stub that says v1.31.0.
// Checks: the bar above a local terminal says why nothing is offered (the
// cluster reports v1.10.0; nauvi only downloads 1.27 or newer), has no
// Download button, and nothing is fetched from the download host; light and
// dark theme at 1280x800.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId, CONTEXT } from "../lib/app.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 120_000 };
const SKIP = process.platform !== "linux" ? "Linux only (the stub kubectl is a shell script)" : false;
const OLD = "v1.10.0";
const STANDIN = "qa-444-old-cluster";

const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-444-"));
const userBin = join(dir, "user-bin");
const USER_KUBECTL = `#!/bin/sh
if [ "$1" = version ]; then echo '{"clientVersion":{"major":"1","minor":"31","gitVersion":"v1.31.0"}}'; exit 0; fi
echo "USER-KUBECTL $*"
`;

/** The kind context's server and client credentials. */
function kindAccess() {
  const kc = JSON.parse(
    execFileSync("kubectl", ["config", "view", "--minify", "--flatten", "--context", CONTEXT, "-o", "json"], {
      encoding: "utf8",
    }),
  );
  const cluster = kc.clusters[0].cluster;
  const user = kc.users[0].user;
  const b64 = (s) => (s ? Buffer.from(s, "base64") : undefined);
  return {
    server: new URL(cluster.server),
    ca: b64(cluster["certificate-authority-data"]),
    cert: b64(user["client-certificate-data"]),
    key: b64(user["client-key-data"]),
    token: user.token,
  };
}

const seen = { version: 0, passed: 0, download: [] };
let standin;
let downloadHost;

/** Plain http in, https with the kind user's credentials out; /version lies. */
function startStandin(access) {
  standin = createServer((req, res) => {
    if (req.url.split("?")[0] === "/version") {
      seen.version++;
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({ major: "1", minor: "10", gitVersion: OLD, platform: "linux/amd64" }),
      );
      return;
    }
    seen.passed++;
    const headers = { ...req.headers, host: access.server.host };
    if (access.token) headers.authorization = `Bearer ${access.token}`;
    const up = request(
      {
        host: access.server.hostname,
        port: access.server.port,
        method: req.method,
        path: req.url,
        headers,
        ca: access.ca,
        cert: access.cert,
        key: access.key,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on("error", (e) => res.destroyed || res.writeHead(502).end(String(e)));
    res.on("close", () => up.destroy());
    req.pipe(up);
  });
  return new Promise((r) => standin.listen(0, "127.0.0.1", () => r(standin.address().port)));
}

/** Records anything the app would download; it should get nothing. */
function startDownloadHost() {
  downloadHost = createServer((req, res) => {
    seen.download.push(req.url);
    res.writeHead(404).end();
  });
  return new Promise((r) => downloadHost.listen(0, "127.0.0.1", () => r(downloadHost.address().port)));
}

const profile = createProfile();
let kubeconfig;

/** The offer above the shown terminal. */
const offerText = (app) =>
  app.js(
    `return Array.from(document.querySelectorAll('[data-testid="kubectl-offer"]')).find((el) => el.offsetParent !== null)?.innerText ?? ""`,
  );

describe("no kubectl download for a cluster older than 1.27 (#444)", { timeout: 10 * 60_000, skip: SKIP }, () => {
  before(async () => {
    mkdirSync(userBin, { recursive: true });
    writeFileSync(join(userBin, "kubectl"), USER_KUBECTL);
    chmodSync(join(userBin, "kubectl"), 0o755);
    const port = await startStandin(kindAccess());
    await startDownloadHost();
    kubeconfig = join(dir, "kubeconfig");
    writeFileSync(
      kubeconfig,
      `apiVersion: v1
kind: Config
clusters:
  - name: ${STANDIN}
    cluster:
      server: http://127.0.0.1:${port}
contexts:
  - name: ${STANDIN}
    context:
      cluster: ${STANDIN}
      user: ${STANDIN}
current-context: ${STANDIN}
users:
  - name: ${STANDIN}
    user: {}
`,
      { mode: 0o600 },
    );
  });
  const s = appSession("kubectl-floor", async () => ({
    profile,
    kubeconfig,
    env: {
      SHELL: existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh",
      PATH: [profile.bin, userBin, process.env.PATH].join(delimiter),
      // Never dl.k8s.io: a local host that records any request (plain
      // http behind an https URL, so even a bug could not download).
      NAUVI_KUBECTL_DOWNLOAD_BASE: `https://127.0.0.1:${downloadHost.address().port}`,
    },
  }));
  after(() => {
    standin?.close();
    downloadHost?.close();
    rmSync(dir, { recursive: true, force: true });
    profile.remove();
  });

  it("connects through the stand-in that reports v1.10.0", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    assert.ok(seen.passed > 0, "requests pass through to kind");
  });

  it("turns the offer on in Settings", T, async () => {
    const { app } = s;
    await app.js("document.activeElement?.blur()");
    await app.driver.actions().keyDown(Key.CONTROL).sendKeys(",").keyUp(Key.CONTROL).perform();
    await app.find(byTestId("settings"));
    await app.js(`document.querySelector('[data-testid="kubectl-settings"]').scrollIntoView()`);
    const box = await app.find(By.css('[data-testid="kubectl-settings"] input[type="checkbox"]'));
    await box.click();
    await app.waitFor(async () => profile.settings()?.kubectl_match === true, { message: "kubectl_match saved" });
    await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
  });

  it("says why no kubectl is offered, with no Download button (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await app.palette("local term", "New local terminal");
    const term = terminal(app);
    await term.waitForPrompt();
    const text = await app.waitFor(async () => (await offerText(app)) || null, { message: "the kubectl bar" });
    console.log(`bar: ${JSON.stringify(text)}`);
    assert.match(text, /No matching kubectl to offer: the cluster reports v1\.10\.0; nauvi only downloads kubectl 1\.27 or newer/);
    assert.match(text, /Your own kubectl is used\./);
    const buttons = await app.js(
      `return Array.from(document.querySelectorAll('[data-testid="kubectl-offer"] button'), (b) => b.textContent.trim())`,
    );
    assert.ok(!buttons.some((b) => b.startsWith("Download")), JSON.stringify(buttons));
    assert.ok(seen.version > 0, "the app asked the stand-in for /version");
    // The terminal runs the user's own kubectl.
    assert.match(await term.run("kubectl get pods"), /USER-KUBECTL get pods/);
    assert.deepEqual(seen.download, [], "nothing was fetched from the download host");
  });

  it("looks right in the dark theme", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    assert.match(await offerText(app), /1\.27 or newer/);
    assert.deepEqual(seen.download, []);
  });
});

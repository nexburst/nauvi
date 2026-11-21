// The per-cluster proxy (#329), in the real app against kind, through a
// small HTTP CONNECT proxy this scenario runs on 127.0.0.1 (it wants a user
// and password):
// - none set: the cluster settings' Network section says it connects
//   directly (empty state)
// - a bad URL: the backend's error, the password not repeated (error state)
//   (https:// proxies: cluster-proxy-https.test.mjs, #362)
// - set with a password, for a cluster on this machine too: shown masked,
//   "Reconnect now" reconnects through it, the Pods table loads, the proxy
//   saw the tunnels
// - the password is only in proxies.json (0600), never in settings.json,
//   the kubeconfig, the page or the app's logs
// - the proxy stopped: reconnecting fails with a message that names the
//   proxy, masked (error state)
// - removed: the cluster connects directly again
// Light and dark theme at 1280x800. Reads the cluster only.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { ARTIFACTS, CONTEXT, byTestId } from "../lib/app.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { tableData } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const USER = "qa";
const PASSWORD = "s3cret-329-pw";

/** A CONNECT proxy on 127.0.0.1 that wants `USER:PASSWORD`. */
function startProxy() {
  const want = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
  const state = { tunnels: [], refused: 0, sockets: new Set() };
  const server = createServer((client) => {
    state.sockets.add(client);
    client.on("close", () => state.sockets.delete(client));
    client.on("error", () => {});
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      client.off("data", onData);
      const lines = head.subarray(0, end).toString("latin1").split("\r\n");
      const [method, target] = lines[0].split(" ");
      const auth = lines
        .slice(1)
        .find((l) => l.toLowerCase().startsWith("proxy-authorization:"))
        ?.slice("proxy-authorization:".length)
        .trim();
      if (method !== "CONNECT" || auth !== want) {
        state.refused += 1;
        client.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic\r\n\r\n");
        return;
      }
      const i = target.lastIndexOf(":");
      const upstream = connect(Number(target.slice(i + 1)), target.slice(0, i), () => {
        state.tunnels.push(target);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const rest = head.subarray(end + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
      });
      state.sockets.add(upstream);
      upstream.on("close", () => state.sockets.delete(upstream));
      upstream.on("error", () => client.destroy());
    };
    client.on("data", onData);
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      state.port = server.address().port;
      state.stop = () =>
        new Promise((done) => {
          server.close(() => done());
          for (const s of state.sockets) s.destroy();
        });
      resolve(state);
    }),
  );
}

/** A copy of the test context's kubeconfig, to check the app never writes it. */
function kubeconfigCopy() {
  const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-329-"));
  const path = join(dir, "kubeconfig");
  const yaml = execFileSync("kubectl", ["config", "view", "--minify", "--flatten", "--context", CONTEXT], {
    encoding: "utf8",
  });
  writeFileSync(path, yaml, { mode: 0o600 });
  return { dir, path };
}

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Every file under `dir`, recursively. */
function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
  );
}

const section = (app) => app.find(byTestId("cluster-proxy"));
const sectionText = (app) =>
  app.js(`return document.querySelector('[data-testid="cluster-proxy"]')?.innerText ?? ""`);
const bodyText = (app) => app.js("return document.body.innerText");

async function openSettings(app) {
  if ((await app.driver.findElements(byTestId("cluster-settings"))).length === 0) {
    await app.palette("cluster settings", "Cluster settings");
  }
  const s = await section(app);
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", s);
  return s;
}

async function closeSettings(app) {
  const dialog = await app.driver.findElements(byTestId("cluster-settings"));
  if (!dialog.length) return;
  await (await dialog[0].findElement(By.xpath(".//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("cluster-settings"))).length === 0, {
    message: "the cluster settings to close",
  });
}

async function typeUrl(app, url) {
  const s = await openSettings(app);
  const input = await s.findElement(By.css('input[aria-label="Proxy URL"]'));
  await app.setValue(input, url);
  await (await s.findElement(By.xpath(".//button[normalize-space()='Save proxy']"))).click();
}

async function podsLoaded(app, message) {
  await app.nav("Pods");
  return app.waitFor(
    async () => {
      const t = await tableData(app);
      return t && t.rows.length > 0 ? t : null;
    },
    { timeout: 60_000, message },
  );
}

describe("a proxy per cluster", { timeout: 15 * 60_000 }, () => {
  /** The running proxy (`startProxy`), started before the app. */
  const proxy = {};
  let url = "";
  let masked = "";
  const kc = kubeconfigCopy();
  const kcHash = sha(kc.path);
  before(async () => {
    Object.assign(proxy, await startProxy());
    url = `http://${USER}:${PASSWORD}@127.0.0.1:${proxy.port}`;
    masked = `http://[redacted]@127.0.0.1:${proxy.port}`;
  });
  const s = appSession("cluster-proxy", { kubeconfig: kc.path });
  after(async () => {
    await proxy.stop?.().catch(() => {});
    rmSync(kc.dir, { recursive: true, force: true });
  });

  it("none set: the Network section says it connects directly (light)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "light");
    await waitLive(app);
    await openSettings(app);
    await app.waitFor(async () => /Connects directly\./.test(await sectionText(app)), {
      message: "the route of a cluster without a proxy",
    });
    assert.doesNotMatch(await sectionText(app), /Remove proxy/);
  });

  it("a bad URL: the backend says why, without the password (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await typeUrl(app, `ftp://${USER}:${PASSWORD}@127.0.0.1:${proxy.port}`);
    await app.waitFor(async () => /not ftp:\/\//.test(await sectionText(app)), { message: "the scheme error" });
    assert.ok(!(await bodyText(app)).includes(PASSWORD));
    await typeUrl(app, `http://${USER}:${PASSWORD}@127.0.0.1:${proxy.port}/some/path`);
    await app.waitFor(async () => /no path or query/.test(await sectionText(app)), { message: "the path error" });
    assert.ok(!(await bodyText(app)).includes(PASSWORD), "the password is on the page");
  });

  it("set with a password: shown masked, reconnects through the proxy (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    const sec = await openSettings(app);
    const local = await sec.findElement(By.css('input[aria-label="Use the proxy for a cluster on this machine"]'));
    if (!(await local.isSelected())) await local.click();
    await typeUrl(app, url);
    await app.waitFor(async () => (await sectionText(app)).includes(`Connects through ${masked}.`), {
      message: "the masked proxy in the route",
    });
    assert.ok(!(await bodyText(app)).includes(PASSWORD), "the password is on the page");
    await app.shot("proxy-saved-masked");
    const before = proxy.tunnels.length;
    await (await sec.findElement(By.xpath(".//button[normalize-space()='Reconnect now']"))).click();
    await waitLive(app);
    const t = await podsLoaded(app, "the Pods table through the proxy");
    assert.ok(t.rows.length > 0);
    await app.waitFor(() => proxy.tunnels.length > before, { message: "tunnels through the proxy" });
    const server = new URL(readFileSync(kc.path, "utf8").match(/server:\s*(\S+)/)[1]);
    assert.ok(
      proxy.tunnels.every((target) => target === `${server.hostname}:${server.port}`),
      `tunnels: ${proxy.tunnels}`,
    );
    assert.equal(proxy.refused, 0, "the proxy refused the app's credentials");
  });

  it("the password is only in proxies.json, readable by the user alone (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    const saved = join(app.profile.configDir, "proxies.json");
    const json = JSON.parse(readFileSync(saved, "utf8"));
    assert.deepEqual(json[CONTEXT], { url: `${url}`, local: true });
    if (process.platform !== "win32") assert.equal(statSync(saved).mode & 0o777, 0o600);
    // Nowhere else: not the settings, the kubeconfig (unchanged), the logs.
    const leaks = [...files(app.profile.home), ...files(ARTIFACTS).filter((f) => f.includes("cluster-proxy"))]
      .filter((f) => f !== saved && !f.endsWith(".png"))
      .filter((f) => readFileSync(f).includes(PASSWORD));
    assert.deepEqual(leaks, []);
    assert.equal(sha(kc.path), kcHash, "the kubeconfig changed");
    assert.ok(!readFileSync(kc.path, "utf8").includes("proxy-url"));
    await app.nav("Overview");
    await openSettings(app);
  });

  it("the proxy stopped: reconnecting fails and names it, masked (dark)", T, async () => {
    const { app } = s;
    await proxy.stop();
    const sec = await openSettings(app);
    // Saving the same setting again shows "Reconnect now".
    const local = await sec.findElement(By.css('input[aria-label="Use the proxy for a cluster on this machine"]'));
    await local.click();
    await local.click();
    await (await sec.findElement(By.xpath(".//button[normalize-space()='Reconnect now']"))).click();
    const text = await app.waitFor(
      async () => {
        const t = await bodyText(app);
        return /through the proxy/.test(t) ? t : null;
      },
      { timeout: 90_000, message: "an error that names the proxy" },
    );
    assert.ok(text.includes(masked), text);
    assert.ok(!text.includes(PASSWORD), "the password is on the page");
  });

  it("removed: the cluster connects directly again (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    const sec = await openSettings(app);
    await (await sec.findElement(By.xpath(".//button[normalize-space()='Remove proxy']"))).click();
    await app.waitFor(async () => /Connects directly\./.test(await sectionText(app)), { message: "no proxy" });
    await (await sec.findElement(By.xpath(".//button[normalize-space()='Reconnect now']"))).click();
    await waitLive(app, 90_000);
    await podsLoaded(app, "the Pods table without the proxy");
    await closeSettings(app);
    const json = JSON.parse(readFileSync(join(app.profile.configDir, "proxies.json"), "utf8"));
    assert.deepEqual(json, {});
  });
});

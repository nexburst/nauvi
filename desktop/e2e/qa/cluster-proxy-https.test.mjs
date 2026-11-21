// An https:// proxy per cluster (#362), in the real app against kind,
// through a small HTTPS CONNECT proxy this scenario runs on 127.0.0.1 with a
// CA of its own (made with openssl; skipped without it). That the proxy is
// never shown the cluster's client certificate is checked by
// tests/proxy_cluster.rs, whose rustls proxy asks every client for one.
// - set without a CA file: the route says the system's trust store checks
//   it; reconnecting is refused with a certificate problem that names the
//   proxy, masked; the proxy saw no finished handshake and no CONNECT (so
//   no password) (error state)
// - a CA file that is not there: the backend says so (error state)
// - the proxy's CA file set: shown, "Reconnect now" connects through the
//   proxy, the Pods table loads, a port-forward works through it; every
//   tunnel goes to the API server
// - the CA file and the password only in proxies.json (0600)
// - removed: the cluster connects directly again (empty state)
// Light and dark theme at 1280x800. Creates one pod in a temp namespace.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createServer } from "node:tls";
import { By } from "selenium-webdriver";
import { CONTEXT, byTestId } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { tableData } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const USER = "qa";
const PASSWORD = "s3cret-362-pw";

function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** A CA, and a certificate for 127.0.0.1 it signed, in a temp directory. */
function makeCerts() {
  const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-362-"));
  const f = (name) => join(dir, name);
  const ossl = (args) => execFileSync("openssl", args, { stdio: "pipe" });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
  ossl([
    "req", "-x509", ...ec, "-keyout", f("ca.key"), "-out", f("ca.pem"), "-days", "2",
    "-subj", "/CN=nauvi QA 362 proxy CA",
    "-addext", "basicConstraints=critical,CA:TRUE",
    "-addext", "keyUsage=critical,keyCertSign,cRLSign",
  ]);
  ossl(["req", ...ec, "-keyout", f("proxy.key"), "-out", f("proxy.csr"), "-subj", "/CN=127.0.0.1"]);
  writeFileSync(
    f("ext.cnf"),
    "subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n",
  );
  ossl([
    "x509", "-req", "-in", f("proxy.csr"), "-CA", f("ca.pem"), "-CAkey", f("ca.key"),
    "-CAcreateserial", "-out", f("proxy.pem"), "-days", "2", "-extfile", f("ext.cnf"),
  ]);
  return { dir, ca: f("ca.pem"), key: readFileSync(f("proxy.key")), cert: readFileSync(f("proxy.pem")) };
}

/** An HTTPS CONNECT proxy on 127.0.0.1 that wants `USER:PASSWORD`. */
function startProxy(certs) {
  const want = `Basic ${Buffer.from(`${USER}:${PASSWORD}`).toString("base64")}`;
  const state = { tunnels: [], refused: 0, handshakes: 0, connections: 0, sockets: new Set() };
  const server = createServer({ key: certs.key, cert: certs.cert }, (client) => {
    state.handshakes += 1;
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
  // Every TCP connection: one whose handshake never finished was refused.
  server.on("connection", () => {
    state.connections += 1;
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

/** A copy of the test context's kubeconfig (kind: a client certificate). */
function kubeconfigCopy(dir) {
  const path = join(dir, "kubeconfig");
  const yaml = execFileSync("kubectl", ["config", "view", "--minify", "--flatten", "--context", CONTEXT], {
    encoding: "utf8",
  });
  writeFileSync(path, yaml, { mode: 0o600 });
  return path;
}

const sectionText = (app) =>
  app.js(`return document.querySelector('[data-testid="cluster-proxy"]')?.innerText ?? ""`);
const bodyText = (app) => app.js("return document.body.innerText");

async function openSettings(app) {
  if ((await app.driver.findElements(byTestId("cluster-settings"))).length === 0) {
    await app.palette("cluster settings", "Cluster settings");
  }
  const s = await app.find(byTestId("cluster-proxy"));
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

/** Type into the Network section's fields (null: leave it) and save. */
async function save(app, { url = null, ca = null }) {
  const s = await openSettings(app);
  if (url !== null) await app.setValue(await s.findElement(By.css('input[aria-label="Proxy URL"]')), url);
  if (ca !== null) await app.setValue(await s.findElement(By.css('input[aria-label="Proxy CA file"]')), ca);
  await (await s.findElement(By.xpath(".//button[normalize-space()='Save proxy']"))).click();
}

async function reconnect(app) {
  const s = await openSettings(app);
  await (await s.findElement(By.xpath(".//button[normalize-space()='Reconnect now']"))).click();
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

describe("an https:// proxy per cluster", { timeout: 15 * 60_000, skip: hasOpenssl() ? false : "needs openssl" }, () => {
  const proxy = {};
  let certs;
  let url = "";
  let masked = "";
  let server = "";
  let ns;
  before(async () => {
    certs = makeCerts();
    Object.assign(proxy, await startProxy(certs));
    url = `https://${USER}:${PASSWORD}@127.0.0.1:${proxy.port}`;
    masked = `https://[redacted]@127.0.0.1:${proxy.port}`;
    ns = tempNamespace("qa-362-proxy", httpPodYaml("web", 8080, "hello through the https proxy"));
    waitPodReady(ns, "web");
  });
  const s = appSession("cluster-proxy-https", () => {
    const kc = kubeconfigCopy(certs.dir);
    const u = new URL(readFileSync(kc, "utf8").match(/server:\s*(\S+)/)[1]);
    server = `${u.hostname}:${u.port}`;
    return { kubeconfig: kc };
  });
  after(async () => {
    await proxy.stop?.().catch(() => {});
    deleteNamespace(ns);
    if (certs) rmSync(certs.dir, { recursive: true, force: true });
  });

  it("an untrusted proxy certificate is refused, and the proxy gets nothing (light)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "light");
    await waitLive(app);
    const sec = await openSettings(app);
    // No CA field until the URL is https://.
    assert.equal((await sec.findElements(By.css('input[aria-label="Proxy CA file"]'))).length, 0);
    const local = await sec.findElement(By.css('input[aria-label="Use the proxy for a cluster on this machine"]'));
    if (!(await local.isSelected())) await local.click();
    await save(app, { url });
    await app.waitFor(
      async () => (await sectionText(app)).includes(`Connects through ${masked}, its certificate checked against the system's trust store.`),
      { message: "the route of an https:// proxy without a CA file" },
    );
    await reconnect(app);
    const text = await app.waitFor(
      async () => {
        const t = await bodyText(app);
        return /Certificate problem with the proxy/.test(t) ? t : null;
      },
      { timeout: 90_000, message: "a certificate problem with the proxy" },
    );
    console.log(text.split("\n").filter((l) => l.includes("proxy")).join("\n"));
    assert.ok(text.includes(masked), "the error names the proxy");
    assert.ok(!text.includes(PASSWORD), "the password is on the page");
    assert.ok(proxy.connections > 0, "the app never connected to the proxy");
    assert.equal(proxy.handshakes, 0, "a handshake with the untrusted proxy finished");
    assert.deepEqual(proxy.tunnels, [], "a CONNECT reached the untrusted proxy");
  });

  it("a CA file that is not there says so (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await save(app, { ca: join(certs.dir, "missing-ca.pem") });
    await app.waitFor(async () => /Cannot read the proxy's CA file/.test(await sectionText(app)), {
      message: "the missing CA file error",
    });
    await save(app, { ca: "ca.pem" });
    await app.waitFor(async () => /full path/.test(await sectionText(app)), { message: "the relative path error" });
    assert.ok(!(await bodyText(app)).includes(PASSWORD));
  });

  it("with the proxy's CA file: connects through it (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await save(app, { ca: certs.ca });
    await app.waitFor(async () => (await sectionText(app)).includes(`trust store and ${certs.ca}.`), {
      message: "the route with the CA file",
    });
    const sec = await app.find(byTestId("proxy-ca"));
    assert.equal(await sec.getText(), certs.ca);
    await app.shot("https-proxy-with-ca");
    await reconnect(app);
    await waitLive(app, 90_000);
    await podsLoaded(app, "the Pods table through the https proxy");
    await app.waitFor(() => proxy.tunnels.length > 0, { message: "tunnels through the proxy" });
    assert.ok(proxy.tunnels.every((t) => t === server), `tunnels: ${proxy.tunnels}`);
    assert.equal(proxy.refused, 0, "the proxy refused the app's credentials");
  });

  it("a port-forward goes through the https proxy too (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    const before = proxy.tunnels.length;
    await app.openDetail("Pods", ns, "web");
    const panel = await app.find(byTestId("detail-panel"));
    await app.setValue(await panel.findElement(By.css('input[aria-label="Pod port"]')), "8080");
    await (await panel.findElement(By.xpath(".//button[normalize-space()='Forward']"))).click();
    const fwd = await app.waitFor(async () => (await panel.getText()).match(/Forwarding (http:\/\/127\.0\.0\.1:\d+)/)?.[1], {
      message: "Forwarding http://127.0.0.1:<port>",
    });
    assert.match(await (await fetch(fwd)).text(), /hello through the https proxy/);
    assert.ok(proxy.tunnels.length > before, "the forward went around the proxy");
    assert.ok(proxy.tunnels.every((t) => t === server), `tunnels: ${proxy.tunnels}`);
    const stop = await panel.findElements(By.xpath(".//button[normalize-space()='Stop']"));
    if (stop.length) await stop[0].click();
    await (await app.find(By.css('[data-testid="detail-panel"] button[aria-label="Close details"]'))).click();
  });

  it("the password and the CA file are only in proxies.json (dark)", T, async () => {
    const { app } = s;
    const saved = join(app.profile.configDir, "proxies.json");
    const json = JSON.parse(readFileSync(saved, "utf8"));
    assert.deepEqual(json[CONTEXT], { url: `https://${USER}:${PASSWORD}@127.0.0.1:${proxy.port}`, local: true, ca_file: certs.ca });
    if (process.platform !== "win32") assert.equal(statSync(saved).mode & 0o777, 0o600);
    const settings = join(app.profile.configDir, "settings.json");
    try {
      assert.ok(!readFileSync(settings, "utf8").includes(PASSWORD));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  });

  it("removed: the cluster connects directly again (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    const sec = await openSettings(app);
    await (await sec.findElement(By.xpath(".//button[normalize-space()='Remove proxy']"))).click();
    await app.waitFor(async () => /Connects directly\./.test(await sectionText(app)), { message: "no proxy" });
    const before = proxy.tunnels.length;
    await reconnect(app);
    await waitLive(app, 90_000);
    await podsLoaded(app, "the Pods table without the proxy");
    await closeSettings(app);
    assert.equal(proxy.tunnels.length, before, "still tunnelled through the removed proxy");
  });
});

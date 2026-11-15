// Helper: a TCP proxy (in this file) between the app and the kind API
// server, which the scenario closes and opens again on the same port.
// Checks (#180): when the path to the API server drops (a VPN or SSH tunnel
// that closes: open connections end, new ones are refused), the header says
// "Reconnecting…" and the banner says so plainly ("Lost the connection to
// the cluster (https://…); retrying.", no raw error chain); once the path is
// back, the table goes Live again by itself, without Refresh and without
// any change in the cluster, within LIVE_MS.
//
// The `reconnect` scenario pauses the control plane instead, which leaves
// the connections open: a different failure, caught by the liveness guard.
// Config Maps across all namespaces, as in the report: they hardly change,
// so only a new list can bring back Live (kube's watcher resumes a watch
// silently). Skipped when the API server is not on a loopback address
// (the proxy's address must match its certificate).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT } from "../lib/app.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const RECONNECT_MS = 30_000;
// How long the path stays down: as in the report.
const DOWN_MS = 25_000;
// The watches retry at most 10 s apart (src/reconnect.rs), then list again.
const LIVE_MS = 30_000;
const T = { timeout: 3 * 60_000 };

function kubeconfigOf(context) {
  return execFileSync("kubectl", ["config", "view", "--minify", "--flatten", "--context", context], {
    encoding: "utf8",
  });
}

function upstream() {
  try {
    const server = execFileSync(
      "kubectl",
      ["config", "view", "--minify", "--context", CONTEXT, "-o", "jsonpath={.clusters[0].cluster.server}"],
      { encoding: "utf8" },
    ).trim();
    const url = new URL(server);
    return { host: url.hostname, port: Number(url.port || 443) };
  } catch {
    return null;
  }
}

const up = upstream();
const skip = !up
  ? `no server for context ${CONTEXT}`
  : !["127.0.0.1", "localhost"].includes(up.host) && `the API server is at ${up.host}, not on a loopback address`;

/** A TCP proxy to `target` on 127.0.0.1; `stop()` closes the port and every connection. */
function proxy(target) {
  const sockets = new Set();
  const server = createServer((down) => {
    const upSock = createConnection(target.port, target.host);
    for (const s of [down, upSock]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => {
        down.destroy();
        upSock.destroy();
      });
    }
    down.pipe(upSock);
    upSock.pipe(down);
  });
  let port = 0;
  return {
    get port() {
      return port;
    },
    start: () =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          port = server.address().port;
          resolve();
        });
      }),
    stop: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        if (!server.listening) return resolve();
        server.close(() => resolve());
      }),
  };
}

describe("reconnecting after the path to the API server drops", { timeout: 5 * 60_000, skip }, () => {
  const p = skip ? null : proxy(up);
  let dir = "";
  const s = appSession("reconnect-drop", async () => {
    await p.start();
    dir = mkdtempSync(join(tmpdir(), "kubeloupe-qa-drop-"));
    const path = join(dir, "kubeconfig");
    writeFileSync(path, kubeconfigOf(CONTEXT), { mode: 0o600 });
    const cluster = execFileSync(
      "kubectl",
      ["--kubeconfig", path, "config", "view", "-o", "jsonpath={.clusters[0].name}"],
      { encoding: "utf8" },
    ).trim();
    execFileSync("kubectl", [
      "--kubeconfig",
      path,
      "config",
      "set-cluster",
      cluster,
      `--server=https://127.0.0.1:${p.port}`,
    ]);
    return { kubeconfig: path };
  });
  after(async () => {
    await p?.stop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const banner = async (app) => {
    const els = await app.driver.findElements(By.css('[role="alert"]'));
    const texts = await Promise.all(els.map((e) => e.getText()));
    return texts.join("\n");
  };

  it("says plainly that the connection was lost, and goes Live again by itself once it is back", T, async () => {
    const { app } = s;
    const server = `https://127.0.0.1:${p.port}`;
    await app.nav("Config Maps");
    await waitLive(app);
    await app.shot("live-before");

    await p.stop();
    const dropped = Date.now();
    await app.waitFor(async () => (await app.statusText()).startsWith("Reconnecting"), {
      timeout: RECONNECT_MS,
      interval: 500,
      message: `header status "Reconnecting…" within ${RECONNECT_MS / 1000} s of the drop`,
    });
    console.log(`Reconnecting… shown ${((Date.now() - dropped) / 1000).toFixed(1)} s after the drop`);
    const expected = `Lost the connection to the cluster (${server}); retrying.`;
    const text = await app.waitFor(async () => {
      const t = await banner(app);
      return t.includes(expected) ? t : null;
    }, { timeout: 10_000, message: `the banner "${expected}"` });
    assert.doesNotMatch(text, /docs\.rs|rustls|ServiceError|close_notify|Watch interrupted/, text);
    await app.shot("dropped");
    await setTheme(app, "dark");
    await app.shot("dropped-dark");
    await setTheme(app, null);

    const left = DOWN_MS - (Date.now() - dropped);
    if (left > 0) await new Promise((r) => setTimeout(r, left));
    assert.ok((await app.statusText()).startsWith("Reconnecting"), "still Reconnecting while the path is down");

    await p.start();
    const back = Date.now();
    // No Refresh, and no change in the cluster.
    await waitLive(app, LIVE_MS);
    console.log(`Live again ${((Date.now() - back) / 1000).toFixed(1)} s after the path came back`);
    await app.waitFor(async () => !(await banner(app)).includes("Lost the connection"), {
      timeout: 5_000,
      message: "the banner gone",
    });
  });
});

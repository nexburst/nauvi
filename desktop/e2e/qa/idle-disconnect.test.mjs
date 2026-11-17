// Idle disconnect (ADR 0007, #333 PR 4), in the real app against kind:
// - Settings offers the timeout (10 minutes by default), set here to 1 minute
// - a second cluster connected in the background (`cmd_cluster_connect`)
//   with a port-forward stays connected past the timeout, and Settings says
//   what keeps it ("kept by a port-forward")
// - once the forward stops, the reaper (every 30 s) disconnects it within
//   a minute and a half; Settings says "Disconnected while idle"
// - the next command connects it again, and Settings says "Connected"
// - the cluster the window shows is never disconnected (still Live)
// Light and dark theme at 1280x800. The second context is the admin
// context under another name; forwards go to demo/web, which is only read.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Key } from "selenium-webdriver";
import { byTestId, CONTEXT } from "../lib/app.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 300_000 };
const SECOND = `${CONTEXT}-qa-idle`;
/** One minute of timeout plus a reaper period, and some slack. */
const IDLE_WAIT = 120_000;

const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-idle-"));
const view = (args, env = {}) =>
  execFileSync("kubectl", ["config", "view", "--flatten", ...args], { encoding: "utf8", env: { ...process.env, ...env } });

/** A kubeconfig with the admin context (current) and an alias of it. */
function twoContexts() {
  const admin = join(dir, "admin");
  writeFileSync(admin, view(["--minify", "--context", CONTEXT]), { mode: 0o600 });
  const alias = join(dir, "alias");
  writeFileSync(alias, view(["--minify", "--context", CONTEXT]).replaceAll(CONTEXT, SECOND), { mode: 0o600 });
  const path = join(dir, "kubeconfig");
  writeFileSync(path, view([], { KUBECONFIG: `${admin}:${alias}` }), { mode: 0o600 });
  return path;
}

const kubeconfig = twoContexts();

/** Call a command from the window, as the UI does: `{ ok }` or `{ err }`. */
function ipc(app, cmd, args) {
  return app.driver.executeAsyncScript(
    `const done = arguments[arguments.length - 1];
     window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1])
       .then((ok) => done({ ok: ok ?? null }), (e) => done({ err: String(e) }));`,
    cmd,
    args,
  );
}

async function ok(app, cmd, args) {
  const r = await ipc(app, cmd, args);
  assert.ok(!("err" in r), `${cmd}: ${r.err}`);
  return r.ok;
}

async function openSettings(app) {
  await app.js("document.activeElement?.blur()");
  await app.driver.actions().keyDown(Key.CONTROL).sendKeys(",").keyUp(Key.CONTROL).perform();
  await app.find(byTestId("settings"));
  await app.js(`document.querySelector('[data-testid="idle-settings"]').scrollIntoView({ block: "start" })`);
}

const idleValue = (app) =>
  app.js(`return document.querySelector('select[aria-label="Disconnect idle clusters after"]').value`);

/** What Settings says about the background cluster. */
const backgroundText = (app) =>
  app.js(`return document.querySelector('[data-testid="background-clusters"]')?.innerText ?? ""`);

async function waitBackground(app, re, message, timeout = IDLE_WAIT) {
  await app.waitFor(async () => re.test(await backgroundText(app)), { timeout, interval: 1000, message });
}

async function shots(app, name) {
  for (const theme of ["light", "dark"]) {
    await setTheme(app, theme);
    await app.shot(`${name}-${theme}`);
  }
  await setTheme(app, null);
}

describe("idle disconnect", { timeout: 15 * 60_000 }, () => {
  after(() => rmSync(dir, { recursive: true, force: true }));
  const s = appSession("idle-disconnect", { kubeconfig });

  it("Settings offers the timeout, 10 minutes by default; set to 1 minute", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await openSettings(app);
    assert.equal(await idleValue(app), "10");
    await app.js(
      `const el = document.querySelector('select[aria-label="Disconnect idle clusters after"]');
       el.value = "1"; el.dispatchEvent(new Event("change", { bubbles: true }));`,
    );
    await app.waitFor(async () => app.profile.settings()?.idle_disconnect_minutes === 1, {
      message: "settings.json has 1 minute",
    });
    // No background cluster yet: no list.
    assert.equal(await backgroundText(app), "");
    await shots(app, "settings-idle-empty");
  });

  it("a background cluster with a port-forward stays connected past the timeout", T, async () => {
    const { app } = s;
    await ok(app, "cmd_cluster_connect", { cluster: SECOND });
    const namespaces = await ok(app, "cmd_list_namespaces", { cluster: SECOND });
    assert.ok(namespaces.some((n) => n.name === "demo"));
    await ok(app, "cmd_portforward_start", {
      cluster: SECOND,
      target: { kind: "deployment", namespace: "demo", name: "web" },
      remotePort: "80",
      localPort: 0,
    });
    await waitBackground(app, /Connected, kept by a port-forward/, "the reaper's report", 60_000);
    // Past one minute untouched plus a reaper pass: still connected.
    await new Promise((r) => setTimeout(r, 95_000));
    assert.match(await backgroundText(app), /Connected, kept by a port-forward/);
    const [forward] = await ok(app, "cmd_portforward_list", { cluster: SECOND });
    const res = await fetch(`http://127.0.0.1:${forward.local_port}/`, { signal: AbortSignal.timeout(10_000) });
    assert.ok(res.ok, "the forward still answers");
    await shots(app, "settings-idle-pinned");
  });

  it("without the forward, it is disconnected once idle; the next command reconnects", T, async () => {
    const { app } = s;
    const [forward] = await ok(app, "cmd_portforward_list", { cluster: SECOND });
    await ok(app, "cmd_portforward_stop", { cluster: SECOND, id: forward.id });
    const stopped = Date.now();
    await waitBackground(app, /Disconnected while idle/, "the idle disconnect");
    const after = Date.now() - stopped;
    assert.ok(after >= 55_000, `not before the timeout (after ${after} ms)`);
    await shots(app, "settings-idle-disconnected");

    // Shown cluster untouched.
    assert.equal(await app.statusText(), "Live");

    // The next command builds a new client.
    const namespaces = await ok(app, "cmd_list_namespaces", { cluster: SECOND });
    assert.ok(namespaces.some((n) => n.name === "demo"), "reconnected");
    await waitBackground(app, /^\S+\s+Connected\.$/m, "reported connected again", 30_000);
    await shots(app, "settings-idle-reconnected");
  });
});

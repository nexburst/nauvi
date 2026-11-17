// Sessions per (window, cluster) (ADR 0007, #333 PR 2), in the real app.
// Checks: the window shows one cluster and connects a second one in the
// background (`cmd_cluster_connect`), whose commands and port-forwards are
// its own; disconnecting it stops its forward; the visible cluster cannot
// be disconnected; switching context in the UI opens another session and
// keeps the old one connected (PR 3: its forward runs on, its commands
// still answer); switching back (A -> B -> A) shows it again, with its
// remembered view; disconnecting the one left stops its forward.
//
// The second context is the admin context under another name (same kind
// cluster), so both answer. Forwards go to demo/web, which is only read.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT } from "../lib/app.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "../lib/theme.mjs";

const T = { timeout: 150_000 };
const SECOND = `${CONTEXT}-qa-second`;

const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-sessions-"));
const view = (args, env = {}) =>
  execFileSync("kubectl", ["config", "view", "--flatten", ...args], { encoding: "utf8", env: { ...process.env, ...env } });

/** A kubeconfig with the admin context (current) and an alias of it. */
function twoContexts() {
  const admin = join(dir, "admin");
  writeFileSync(admin, view(["--minify", "--context", CONTEXT]), { mode: 0o600 });
  const alias = join(dir, "alias");
  // Every name (context, cluster, user) renamed; the server is the same.
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

const visible = async (app) => (await ok(app, "cmd_list_contexts", { cluster: "" })).find((c) => c.current)?.name;

/** Forward demo/web's port 80 from cluster `cluster` to a free local port. */
async function forwardWeb(app, cluster) {
  const info = await ok(app, "cmd_portforward_start", {
    cluster,
    target: { kind: "deployment", namespace: "demo", name: "web" },
    remotePort: "80",
    localPort: 0,
  });
  return info.local_port;
}

/** Whether nginx answers on the local port. */
async function answers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(10_000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function switchTo(app, name) {
  const select = await app.find(By.css('select[aria-label="Cluster context"]'));
  await app.js('arguments[0].value = arguments[1]; arguments[0].dispatchEvent(new Event("change", { bubbles: true }))', select, name);
  await app.waitFor(async () => (await visible(app)) === name, { message: `the window shows ${name}` });
}

describe("sessions per (window, cluster)", { timeout: 10 * 60_000 }, () => {
  after(() => rmSync(dir, { recursive: true, force: true }));
  const s = appSession("cluster-sessions", { kubeconfig });
  let firstPort;

  it("a second cluster connects in the background with its own session", T, async () => {
    const { app } = s;
    await waitLive(app);
    assert.equal(await visible(app), CONTEXT);
    firstPort = await forwardWeb(app, CONTEXT);
    assert.ok(await answers(firstPort), "the visible cluster's forward answers");

    await ok(app, "cmd_cluster_connect", { cluster: SECOND });
    // Connected, not shown.
    assert.equal(await visible(app), CONTEXT);
    const namespaces = await ok(app, "cmd_list_namespaces", { cluster: SECOND });
    assert.ok(namespaces.some((n) => n.name === "demo"), "the second cluster answers");
    const secondPort = await forwardWeb(app, SECOND);
    assert.ok(await answers(secondPort), "the second cluster's forward answers");
    // Each cluster lists its own forward.
    assert.deepEqual((await ok(app, "cmd_portforward_list", { cluster: CONTEXT })).map((f) => f.local_port), [firstPort]);
    assert.deepEqual((await ok(app, "cmd_portforward_list", { cluster: SECOND })).map((f) => f.local_port), [secondPort]);

    // The visible cluster stays; the other one goes, with its forward.
    const refused = await ipc(app, "cmd_cluster_disconnect", { cluster: CONTEXT });
    assert.match(refused.err ?? "", /is the cluster this window shows/);
    await ok(app, "cmd_cluster_disconnect", { cluster: SECOND });
    await app.waitFor(async () => !(await answers(secondPort)), { message: "the second forward stopped" });
    assert.deepEqual(await ok(app, "cmd_portforward_list", { cluster: SECOND }), []);
    const late = await ipc(app, "cmd_list_namespaces", { cluster: SECOND });
    assert.match(late.err ?? "", /no longer connected to this cluster/);
    const unknown = await ipc(app, "cmd_cluster_connect", { cluster: "qa-no-such-context" });
    assert.match(unknown.err ?? "", /There is no context qa-no-such-context in your kubeconfigs/);

    // The visible cluster was not touched.
    assert.ok(await answers(firstPort), "the first forward still answers");
    assert.equal(await app.statusText(), "Live");
    await app.nav("Pods");
    await waitLive(app);
  });

  it(`switching to ${SECOND} opens another session and keeps ${CONTEXT} connected`, T, async () => {
    const { app } = s;
    await switchTo(app, SECOND);
    await waitLive(app);
    // ADR 0007: the old cluster's forward runs on, and it still answers.
    assert.ok(await answers(firstPort), "the old cluster's forward still answers");
    assert.deepEqual((await ok(app, "cmd_portforward_list", { cluster: CONTEXT })).map((f) => f.local_port), [firstPort]);
    assert.ok((await ok(app, "cmd_list_namespaces", { cluster: CONTEXT })).some((n) => n.name === "demo"));
    // The new one answers, and names itself.
    const namespaces = await ok(app, "cmd_list_namespaces", { cluster: SECOND });
    assert.ok(namespaces.some((n) => n.name === "demo"));
    assert.deepEqual(await ok(app, "cmd_portforward_list", { cluster: SECOND }), []);
    await app.nav("Pods");
    await waitLive(app);
    await app.waitFor(async () => (await app.rows()).length > 0, { timeout: 30_000, message: "pods listed" });
  });

  it(`switching back to ${CONTEXT} shows it again (A -> B -> A)`, T, async () => {
    const { app } = s;
    await switchTo(app, CONTEXT);
    await waitLive(app);
    // The same session: its forward is still listed and answers.
    assert.deepEqual((await ok(app, "cmd_portforward_list", { cluster: CONTEXT })).map((f) => f.local_port), [firstPort]);
    assert.ok(await answers(firstPort));
    await ok(app, "cmd_portforward_stop", { cluster: CONTEXT, id: (await ok(app, "cmd_portforward_list", { cluster: CONTEXT }))[0].id });
    // The one left is still connected until disconnected.
    assert.ok((await ok(app, "cmd_list_namespaces", { cluster: SECOND })).some((n) => n.name === "demo"));
    await ok(app, "cmd_cluster_disconnect", { cluster: SECOND });
    const late = await ipc(app, "cmd_list_namespaces", { cluster: SECOND });
    assert.match(late.err ?? "", /no longer connected to this cluster/);
    // The view it remembers (#70) is Pods, opened again on the new session.
    const active = () => app.js(`return document.querySelector("nav button.active")?.textContent.trim() ?? ""`);
    await app.waitFor(async () => (await active()).startsWith("Pods"), { message: "the remembered Pods view" });
    await waitLive(app);
    await app.waitFor(async () => (await app.rows()).length > 0, { timeout: 30_000, message: "pods listed" });
    // A forward on the cluster shown again works.
    const port = await forwardWeb(app, CONTEXT);
    assert.ok(await answers(port));
    await ok(app, "cmd_portforward_stop", { cluster: CONTEXT, id: (await ok(app, "cmd_portforward_list", { cluster: CONTEXT }))[0].id });
    for (const theme of ["light", "dark"]) {
      await setTheme(app, theme);
      await app.shot(`pods-after-a-b-a-${theme}`);
    }
    await setTheme(app, null);
  });
});

// "Remove = hide" and cluster labels (ADR 0007, #333 PR 5), in the real app
// against kind:
// - a log tab and a port-forward run on the first cluster while the window
//   shows the second: the dock tab, the status bar and Port Forwards name
//   the first cluster, in its colour
// - hiding it from the tree asks first, says it is only hidden in nauvi
//   (the kubeconfig is not changed) and that its tab and forward stop;
//   then the tree and the context selector leave it out
// - the notification of the hide names its cluster with its label
// - the catalog lists it again with Show hidden, and Unhide brings it back
// - the kubeconfig file stays byte-identical throughout
// Light and dark theme at 1280x800. The second context is the admin context
// under another name; the forward goes to demo/web, which is only read.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CONTEXT } from "../lib/app.mjs";
import { dockTabs, openPodLogs } from "../lib/dock.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "../lib/theme.mjs";
import { dockTabClusters, nodeState, selectCluster, treeNode, waitNodeState } from "../lib/tree.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const SECOND = `${CONTEXT}-qa-hide`;
const RED = "#ef4444";
const BLUE = "#3b82f6";

const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-hide-"));
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
const sha = () => createHash("sha256").update(readFileSync(kubeconfig)).digest("hex");
const original = sha();

const colour = (color) => ({ color });
const profile = createProfile();
profile.writeSettings({ contexts: { [CONTEXT]: colour(RED), [SECOND]: colour(BLUE) } });

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

async function shots(app, label) {
  for (const theme of ["light", "dark"]) {
    await setTheme(app, theme);
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

/** Click the button named `name` inside the element `selector` (in the page:
 *  row buttons show on hover only). */
function clickIn(app, selector, name) {
  return app.waitFor(
    () =>
      app.js(
        `const b = Array.from(document.querySelectorAll(arguments[0] + " button")).find(
           (b) => b.getAttribute("aria-label") === arguments[1] || b.textContent.trim() === arguments[1]);
         if (!b || b.disabled) return false;
         b.scrollIntoView({ block: "center" });
         b.click();
         return true;`,
        selector,
        name,
      ),
    { message: `the ${name} button in ${selector}` },
  );
}

const text = (app, selector) => app.js(`return document.querySelector(arguments[0])?.innerText ?? ""`, selector);
const options = (app) =>
  app.js(`return Array.from(document.querySelectorAll('select[aria-label="Cluster context"] option'), (o) => o.value)`);
/** The swatch colour of the first cluster label inside `selector` ("" without one). */
const swatch = (app, selector) =>
  app.js(
    `const s = document.querySelector(arguments[0] + ' [data-testid="cluster-label-color"]');
     return s ? getComputedStyle(s).backgroundColor : "";`,
    selector,
  );

describe("hide clusters and cluster labels", { timeout: 12 * 60_000 }, () => {
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    profile.remove();
  });
  const s = appSession("hide-clusters", { kubeconfig, profile });

  it("a tab and a forward of a background cluster are labelled with it", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.nav("Pods");
    await waitLive(app);
    const logger = (await app.rows()).find(([n, ns]) => ns === "demo" && n.startsWith("logger"))?.[0] ?? "logger";
    await openPodLogs(app, "demo", logger);
    const fwd = await ipc(app, "cmd_portforward_start", {
      cluster: CONTEXT,
      target: { kind: "deployment", namespace: "demo", name: "web" },
      remotePort: "80",
      localPort: 0,
    });
    assert.ok(!("err" in fwd), `forward: ${fwd.err}`);

    await selectCluster(app, SECOND);
    await waitNodeState(app, SECOND, "visible");
    await waitLive(app);
    assert.deepEqual(await dockTabClusters(app), [CONTEXT]);
    assert.equal(await swatch(app, '[data-testid="dock-tab-cluster"]'), "rgb(239, 68, 68)");
    const status = `[data-testid="status-background-cluster"][data-cluster="${CONTEXT}"]`;
    await app.waitFor(async () => (await text(app, status)).includes("1 forward · 1 tab"), {
      timeout: 15_000,
      message: "the status bar names the background cluster",
    });
    assert.equal(await swatch(app, '[data-testid="status-cluster"]'), "rgb(59, 130, 246)");
    await app.nav("Port Forwards");
    const other = `[data-testid="forward-row-other"][data-cluster="${CONTEXT}"]`;
    await app.waitFor(async () => (await text(app, other)).includes("127.0.0.1"), {
      timeout: 15_000,
      message: "Port Forwards lists the background cluster's forward",
    });
    assert.ok((await text(app, `${other} [data-testid="forward-cluster"]`)).includes(CONTEXT));
    await shots(app, "labels");
  });

  it("hiding it asks first, says what stops, and the kubeconfig is not changed", T, async () => {
    const { app } = s;
    await clickIn(app, `${treeNode(CONTEXT)} > .row`, `Hide ${CONTEXT}`);
    await app.waitFor(async () => (await text(app, '[data-testid="hide-dialog"]')) !== "", { message: "the hide dialog" });
    const dialog = await text(app, '[data-testid="hide-dialog"]');
    assert.ok(dialog.includes("only hidden in nauvi: your kubeconfig is not changed"), dialog);
    assert.ok(dialog.includes("1 port-forward and 1 dock tab run on it"), dialog);
    await shots(app, "hide-dialog");
    await clickIn(app, '[data-testid="hide-dialog"]', `Stop and hide ${CONTEXT}`);
    await app.waitFor(async () => (await nodeState(app, CONTEXT)) === "", { message: "the hidden node left the tree" });
    await app.waitFor(async () => (await dockTabs(app)).length === 0, { message: "its tab closed" });
    assert.deepEqual(await options(app), [SECOND]);
    await app.waitFor(async () => (profile.settings()?.hidden_contexts ?? []).includes(CONTEXT), {
      message: "hidden_contexts saved",
    });
    assert.equal(sha(), original, "the kubeconfig is byte-identical");
    await shots(app, "hidden");
  });

  it("the notification names its cluster", T, async () => {
    const { app } = s;
    await app.js(`document.querySelector('[data-testid="notification-bell"]').click()`);
    await app.waitFor(async () => (await text(app, '[data-testid="notifications-panel"]')).includes(`Hid ${CONTEXT}`), {
      message: "the hide notification",
    });
    assert.ok((await text(app, '[data-testid="notification"] [data-testid="cluster-label"]')).includes(SECOND));
    await shots(app, "notifications");
    await clickIn(app, '[data-testid="notifications-panel"]', "Close notifications");
  });

  it("the catalog lists it with Show hidden, and Unhide brings it back", T, async () => {
    const { app } = s;
    await clickIn(app, "header", "Cluster catalog");
    const row = `[data-testid="catalog-row"][data-context="${CONTEXT}"]`;
    await app.waitFor(async () => (await text(app, '[data-testid="catalog"]')).includes("Show hidden (1)"), {
      message: "Show hidden",
    });
    assert.equal(await text(app, row), "", "hidden: not listed yet");
    await app.js(`document.querySelector('[data-testid="catalog-show-hidden"]').click()`);
    await app.waitFor(async () => /hidden/i.test(await text(app, row)), { message: "the hidden row" });
    await shots(app, "catalog-hidden");
    await clickIn(app, row, `Unhide ${CONTEXT}`);
    await app.waitFor(async () => (await nodeState(app, CONTEXT)) !== "", { message: "back in the tree" });
    assert.deepEqual((await options(app)).sort(), [CONTEXT, SECOND].sort());
    await app.waitFor(async () => !(profile.settings()?.hidden_contexts ?? []).includes(CONTEXT), {
      message: "hidden_contexts saved without it",
    });
    assert.equal(sha(), original, "the kubeconfig is byte-identical");
    await shots(app, "unhidden");
  });
});

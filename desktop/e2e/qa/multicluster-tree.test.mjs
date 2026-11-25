// Helpers: lib/tree.mjs (treeNode, nodeState, expandCluster, selectCluster,
// disconnectCluster, dockTabClusters), openPodLogs/logLines (lib/dock.mjs).
// Checks (ADR 0007, #333 PR 3): the sidebar's cluster tree lists every
// context by source; the second cluster (kind-nauvi-staging in qa.yml, an
// alias of the test context otherwise) asks nothing until its node is
// expanded, which connects it and lists its own kinds; selecting it shows
// it while the first cluster's log stream keeps running, labelled with
// its cluster in the dock; A -> B -> A shows only each cluster's pods; an
// added kubeconfig whose login runs a plugin asks inside its node and runs
// it only once allowed; disconnecting a background cluster ends its tab;
// "Open in new window" still opens one. Screenshots at 1280x800 in light
// and dark.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { CONTEXT } from "../lib/app.mjs";
import { contexts as kubeContexts } from "../lib/cluster.mjs";
import { logLines, openPodLogs, dockTabs } from "../lib/dock.mjs";
import { setTheme } from "../lib/panels.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import {
  disconnectCluster,
  dockTabClusters,
  expandCluster,
  nodeState,
  nodeText,
  selectCluster,
  treeNode,
  waitNodeState,
} from "../lib/tree.mjs";
import { resizeWindow, windowHandles } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const STAGING = process.env.QA_STAGING_CONTEXT || "kind-nauvi-staging";
const hasStaging = kubeContexts().includes(STAGING);
const SECOND = hasStaging ? STAGING : `${CONTEXT}-qa-tree`;
const PLUGIN_ID = "qa-tree-plugin";
const suffix = Date.now().toString(36);
const NS = `qa-tree-${suffix}`;
const BINDING = `qa-tree-${suffix}`;

const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-tree-"));
const kubectl = (args) => execFileSync("kubectl", ["--context", CONTEXT, ...args], { encoding: "utf8" });
const view = (args, env = {}) =>
  execFileSync("kubectl", ["config", "view", "--flatten", ...args], { encoding: "utf8", env: { ...process.env, ...env } });

/** The test context (current) and the second one, in one kubeconfig. */
function twoContexts() {
  const admin = join(dir, "admin");
  writeFileSync(admin, view(["--minify", "--context", CONTEXT]), { mode: 0o600 });
  const second = join(dir, "second");
  const yaml = view(["--minify", "--context", hasStaging ? STAGING : CONTEXT]);
  writeFileSync(second, hasStaging ? yaml : yaml.replaceAll(CONTEXT, SECOND), { mode: 0o600 });
  const path = join(dir, "kubeconfig");
  writeFileSync(path, view([], { KUBECONFIG: `${admin}:${second}` }), { mode: 0o600 });
  // `current-context` is the first file's.
  return path;
}
const kubeconfig = twoContexts();

// An added kubeconfig whose user logs in with a stand-in plugin: it counts
// its runs and prints a token of a ServiceAccount that may view the cluster.
kubectl(["create", "namespace", NS]);
kubectl(["-n", NS, "create", "serviceaccount", "viewer"]);
kubectl(["create", "clusterrolebinding", BINDING, "--clusterrole=view", `--serviceaccount=${NS}:viewer`]);
const token = kubectl(["-n", NS, "create", "token", "viewer", "--duration=1h"]).trim();
const plugin = join(dir, "login.sh");
const runsFile = join(dir, "runs");
const expires = new Date(Date.now() + 30 * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
writeFileSync(
  plugin,
  `#!/bin/sh\necho run >> '${runsFile}'\n` +
    `printf '%s\\n' '{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"${token}","expirationTimestamp":"${expires}"}}'\n`,
);
chmodSync(plugin, 0o755);
const runs = () => {
  try {
    return readFileSync(runsFile, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};
const real = JSON.parse(kubectl(["config", "view", "--minify", "--flatten", "-o", "json"]));
const added = join(dir, "team.yaml");
writeFileSync(
  added,
  JSON.stringify({
    apiVersion: "v1",
    kind: "Config",
    clusters: [{ name: "c", cluster: real.clusters[0].cluster }],
    users: [{ name: "plugin", user: { exec: { apiVersion: "client.authentication.k8s.io/v1", command: plugin, interactiveMode: "Never" } } }],
    contexts: [{ name: PLUGIN_ID, context: { cluster: "c", user: "plugin" } }],
  }),
  { mode: 0o600 },
);
const profile = createProfile();
profile.writeSettings({ kubeconfig_sources: [added] });

async function shots(app, label) {
  for (const theme of ["light", "dark"]) {
    await setTheme(app, theme);
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

describe("the cluster tree", { timeout: 15 * 60_000 }, () => {
  after(() => {
    try {
      kubectl(["delete", "clusterrolebinding", BINDING, "--ignore-not-found"]);
      kubectl(["delete", "namespace", NS, "--wait=false", "--ignore-not-found"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      profile.remove();
    }
  });
  const s = appSession("multicluster-tree", { kubeconfig, profile });
  let logId;

  it("lists every context by source and connects none but the one shown", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    assert.equal(await nodeState(app, CONTEXT), "visible");
    await app.waitFor(async () => (await nodeState(app, PLUGIN_ID)) !== "", { message: "the added kubeconfig's context" });
    assert.equal(await nodeState(app, SECOND), "idle");
    assert.equal(await nodeState(app, PLUGIN_ID), "idle");
    const groups = await app.js(`return Array.from(document.querySelectorAll('[data-testid="cluster-group"] > button'), (b) => b.textContent.trim())`);
    console.log(`groups: ${JSON.stringify(groups)}`);
    assert.ok(groups.some((g) => /Kubeconfig/i.test(g)));
    assert.ok(groups.some((g) => /team\.yaml/.test(g)));
    assert.equal(runs(), 0, "the plugin did not run at start-up");
    await app.nav("Pods");
    await waitLive(app);
    await shots(app, "tree-start");
  });

  it(`expanding ${SECOND} connects it in the background and lists its kinds`, T, async () => {
    const { app } = s;
    await expandCluster(app, SECOND);
    await waitNodeState(app, SECOND, "connected");
    await app.waitFor(async () => (await nodeText(app, SECOND)).includes("Workloads"), { message: `${SECOND}'s resource groups` });
    // Still showing the first cluster.
    assert.equal(await nodeState(app, CONTEXT), "visible");
    assert.equal(await app.statusText(), "Live");
    await shots(app, "tree-two-connected");
  });

  it(`selecting ${SECOND} shows it; the first cluster's log stream runs on, labelled`, T, async () => {
    const { app } = s;
    logId = await openPodLogs(app, "demo", (await app.rows()).find(([n, ns]) => ns === "demo" && n.startsWith("logger"))?.[0] ?? "logger");
    await app.waitFor(async () => (await logLines(app, logId)).length > 0, { message: "logger lines" });
    await selectCluster(app, SECOND);
    await waitNodeState(app, SECOND, "visible");
    await waitNodeState(app, CONTEXT, "connected");
    await waitLive(app);
    // The newest line, not the count: the pane only renders the lines in view.
    const before = (await logLines(app, logId)).at(-1);
    assert.equal((await dockTabs(app)).length, 1, "the log tab stayed");
    assert.deepEqual(await dockTabClusters(app), [CONTEXT]);
    await app.waitFor(async () => (await logLines(app, logId)).at(-1) !== before, {
      timeout: 30_000,
      message: "new log lines from the first cluster after the switch",
    });
    await app.nav("Pods");
    await waitLive(app);
    // Opening the logger's panel filtered the table by its name.
    await app.filter("");
    await app.waitFor(async () => (await app.rows()).length > 0, { timeout: 30_000, message: `pods of ${SECOND}` });
    const rows = await app.rows();
    if (hasStaging) {
      assert.ok(!rows.some(([, ns]) => ns === "demo"), "no demo pods on staging");
    }
    await shots(app, "tree-second-shown");
  });

  it("switching back shows only the first cluster's pods (A -> B -> A)", T, async () => {
    const { app } = s;
    await selectCluster(app, CONTEXT);
    await waitNodeState(app, CONTEXT, "visible");
    await waitLive(app);
    await app.nav("Pods");
    await waitLive(app);
    await app.waitFor(async () => (await app.rows()).some(([, ns]) => ns === "demo"), { timeout: 30_000, message: "demo pods" });
    if (hasStaging) {
      const rows = await app.rows();
      assert.ok(!rows.some(([n]) => n.includes("nauvi-staging")), "no staging pods back on the first cluster");
    }
    assert.equal(await nodeState(app, SECOND), "connected");
    // The log tab is on the cluster shown again: no label needed.
    assert.deepEqual(await dockTabClusters(app), []);
    // Selecting the cluster shown again restarts nothing: the tab streams on.
    // The newest line, not the count: the pane only renders the lines in view.
    const last = (await logLines(app, logId)).at(-1);
    await selectCluster(app, CONTEXT);
    assert.equal((await dockTabs(app)).length, 1);
    await app.waitFor(async () => (await logLines(app, logId)).at(-1) !== last, {
      timeout: 30_000,
      message: "the log tab still streams after selecting the shown cluster",
    });
  });

  it("an added kubeconfig's login asks inside its node and runs only once allowed", T, async () => {
    const { app } = s;
    await expandCluster(app, PLUGIN_ID);
    await waitNodeState(app, PLUGIN_ID, "consent");
    const prompt = `${treeNode(PLUGIN_ID)} [data-testid="exec-prompt"]`;
    const text = await app.js(`return document.querySelector(arguments[0])?.innerText ?? ""`, prompt);
    assert.ok(text.includes(plugin), `the exact command is shown: ${text}`);
    assert.equal(runs(), 0);
    await shots(app, "tree-consent");
    const click = (label) =>
      app.js(
        `Array.from(document.querySelectorAll(arguments[0] + " button")).find((b) => b.textContent.trim() === arguments[1]).click()`,
        prompt,
        label,
      );
    await click("Don't run");
    await waitNodeState(app, PLUGIN_ID, "failed");
    assert.equal(runs(), 0, "refused: not run");
    await expandCluster(app, PLUGIN_ID);
    await waitNodeState(app, PLUGIN_ID, "consent");
    await click("Allow and connect");
    await waitNodeState(app, PLUGIN_ID, "connected");
    assert.ok(runs() >= 1, "allowed: it ran");
    await app.waitFor(async () => (await nodeText(app, PLUGIN_ID)).includes("Workloads"), { message: "its resource groups" });
    await shots(app, "tree-plugin-connected");
  });

  it("disconnecting a background cluster ends its tab; Open in new window still works", T, async () => {
    const { app } = s;
    // The log tab runs on the cluster shown: show another one first.
    await selectCluster(app, SECOND);
    await waitNodeState(app, SECOND, "visible");
    await waitLive(app);
    assert.deepEqual(await dockTabClusters(app), [CONTEXT]);
    await disconnectCluster(app, CONTEXT);
    await waitNodeState(app, CONTEXT, "idle");
    await app.waitFor(async () => (await dockTabs(app)).length === 0, { message: "the disconnected cluster's tab closed" });
    await disconnectCluster(app, PLUGIN_ID);
    await waitNodeState(app, PLUGIN_ID, "idle");
    await shots(app, "tree-after-disconnect");

    const before = await windowHandles(app);
    await app.js(
      `document.querySelector(arguments[0] + ' button[aria-label="Open ' + arguments[1] + ' in new window"]').click()`,
      treeNode(CONTEXT),
      CONTEXT,
    );
    await app.waitFor(async () => (await windowHandles(app)).length > before.length, { message: "a new window" });
    // Back on the first window, which still shows the second cluster.
    await app.driver.switchTo().window(before[0]);
    assert.equal(await nodeState(app, SECOND), "visible");
  });
});

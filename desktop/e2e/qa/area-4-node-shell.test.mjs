// QA area 4 (#83): node shells (#72).
// Checks: Shell on a Node opens a root shell on it in a dock tab; its pod
// (kube-system, label nauvi.dev/node-shell) is deleted when the tab
// closes, when its cluster is disconnected (a context switch keeps it
// open, ADR 0007) and when the window is closed (app quits);
// after the app is killed with a node shell open, the next start offers to
// delete the leftover pod, and Delete does.
//
// Node shell pods are privileged: every one this scenario starts is
// deleted in `after`, whatever happened. Other copies of the app (other
// agents, CI) may have node shells of their own on the shared cluster; the
// checks only look at the pods this scenario started, and the leftover
// offer's Delete is only clicked when it lists nothing else.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, byTestId } from "../lib/app.mjs";
import { kubectl } from "../lib/cluster.mjs";
import { aliasKubeconfig, appPid, closeTab, dockTabs, paneTerminal, panelButton } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { disconnectCluster, waitNodeState } from "../lib/tree.mjs";
import { terminal } from "../lib/terminal.mjs";
import { cannotCloseLikeUser, closeLikeUser, selectContext } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const LABEL = "nauvi.dev/node-shell=true";
const NODE = kubectl(["get", "nodes", "-o", "jsonpath={.items[0].metadata.name}"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Node shell pods on the cluster, as `name` (all in kube-system). */
function nodeShellPods() {
  const out = kubectl(["-n", "kube-system", "get", "pods", "-l", LABEL, "-o", "jsonpath={.items[*].metadata.name}"]);
  return out ? out.split(/\s+/) : [];
}

const ours = new Set();
let kc;

async function waitGone(app, pod, timeout = 60_000) {
  await app.waitFor(() => !nodeShellPods().includes(pod), { timeout, interval: 1000, message: `pod kube-system/${pod} deleted` });
}

/** Open the Node panel (cluster-scoped: filter, click the row). */
async function openNode(app) {
  await app.nav("Nodes");
  await app.filter(NODE);
  await app.clickRow(NODE);
  await app.find(byTestId("detail-panel"));
}

describe("area 4: node shells", { timeout: 20 * 60_000 }, () => {
  after(() => {
    for (const pod of ours) {
      try {
        kubectl(["-n", "kube-system", "delete", "pod", pod, "--ignore-not-found", "--wait=false"]);
      } catch (e) {
        console.error(`could not delete kube-system/${pod}: ${e.message}`);
      }
    }
    kc?.remove();
  });
  const s = appSession("area-4-node-shell", () => {
    kc = aliasKubeconfig();
    return { kubeconfig: kc.path };
  });

  async function shell(app) {
    await openNode(app);
    const before = new Set(nodeShellPods());
    await panelButton(app, "Shell");
    const term = terminal(app, paneTerminal(`node:${NODE}`));
    await term.waitFor(/Shell on /, { timeout: 120_000 });
    const pod = await app.waitFor(() => nodeShellPods().find((p) => !before.has(p)), {
      message: "the node shell pod",
    });
    ours.add(pod);
    await term.type("");
    await term.waitForPrompt(60_000);
    return { pod, term };
  }

  it("Shell on a node: a root shell on that node; closing the tab deletes the pod", T, async () => {
    const { app } = s;
    await waitLive(app);
    const { pod, term } = await shell(app);
    console.log(`node shell pod: ${pod}`);
    assert.equal(await term.run("id -u"), "0");
    assert.equal(await term.run("cat /etc/hostname"), NODE, "the host's hostname (nsenter into the node)");
    await app.shot("node-shell");
    await closeTab(app, `Node: ${NODE}`);
    await waitGone(app, pod);
  });

  it("a context switch keeps the node shell; disconnecting its cluster deletes its pod", T, async () => {
    const { app } = s;
    const { pod } = await shell(app);
    await selectContext(app, kc.alias);
    await waitLive(app);
    assert.equal((await dockTabs(app)).length, 1, "the node shell tab stays");
    assert.ok(nodeShellPods().includes(pod), "its pod stays");
    await waitNodeState(app, CONTEXT, "connected");
    await disconnectCluster(app, CONTEXT);
    await app.waitFor(async () => (await dockTabs(app)).length === 0, { message: "no tabs after the disconnect" });
    await waitGone(app, pod);
    await selectContext(app, CONTEXT);
    await waitLive(app);
  });

  it("closing the window (the app quits) deletes the node shell pod", { ...T, skip: cannotCloseLikeUser() }, async () => {
    const { app } = s;
    const { pod } = await shell(app);
    try {
      // As the title bar's close button would (WebDriver's Close Window
      // would kill the app before its exit path runs).
      const pid = appPid(app.profile.home);
      const t0 = Date.now();
      console.log(`closing windows ${closeLikeUser(pid).join(", ")} of pid ${pid}`);
      await app.waitFor(() => appPid(app.profile.home) === null, { timeout: 15_000, message: "the app to exit" });
      console.log(`app exited ${Date.now() - t0} ms after closing its window`);
      // Deleted, or at least being deleted (the node shell pod may take its grace period).
      const state = await app.waitFor(
        () => {
          if (!nodeShellPods().includes(pod)) return "gone";
          const ts = kubectl(["-n", "kube-system", "get", "pod", pod, "--ignore-not-found", "-o", "jsonpath={.metadata.deletionTimestamp}"]);
          return ts ? `terminating since ${ts}` : null;
        },
        { timeout: 15_000, interval: 500, message: `pod ${pod} deleted on quit` },
      );
      console.log(`node shell pod after quit: ${state}`);
      await waitGone(app, pod, 60_000);
    } finally {
      await app.restart({ wait: 0 });
      await waitLive(app);
    }
  });

  it("killed with a node shell open: the next start offers to delete the leftover", T, async () => {
    const { app } = s;
    const { pod } = await shell(app);
    const pid = appPid(app.profile.home);
    assert.ok(pid, "the app's pid");
    process.kill(pid, "SIGKILL");
    await sleep(1000);
    assert.ok(nodeShellPods().includes(pod), "the pod is left behind by a kill");
    await app.restart({ wait: 0 });
    await waitLive(app);
    const offer = await app.find(byTestId("node-shell-leftovers"), { timeout: 30_000 });
    const text = await offer.getText();
    console.log(`leftover offer: ${text}`);
    assert.ok(text.includes(`kube-system/${pod}`), text);
    await app.shot("leftover-offer");
    const others = nodeShellPods().filter((p) => !ours.has(p));
    if (others.length === 0) {
      await (await offer.findElement(By.xpath(".//button[normalize-space()='Delete']"))).click();
      await waitGone(app, pod, 30_000);
      await app.waitFor(async () => (await app.js("return document.body.innerText")).match(/Deleted \d+ node shell pods?/), {
        message: "\"Deleted N node shell pod(s)\"",
      });
    } else {
      console.log(`not clicking Delete: other node shells exist (${others.join(", ")}); deleting ${pod} with kubectl`);
      kubectl(["-n", "kube-system", "delete", "pod", pod, "--wait=false"]);
    }
  });
});

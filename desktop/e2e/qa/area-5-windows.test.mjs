// QA area 5 (#83): several windows (PR #76) beyond multi-window.test.mjs,
// with a second context on the same cluster (aliasKubeconfig) instead of a
// second cluster.
// Checks: "Open in new window" opens a window titled with the context, and
// a context switch there retitles it; a port-forward in window A survives a
// context switch in window B and B being closed; the first log stream and a
// terminal in each window (same stream ids on both sides) show only their
// own output; closing window B deletes its node shell pod and its local
// shell's temp kubeconfig; `win <context>` in the palette opens a window;
// closing the main window and then the second (WM_DELETE_WINDOW, like the
// close button) and starting again reopens both; closing both at once
// forgets the second (#126, todo).

import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, byTestId } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { aliasKubeconfig, appPid, dockControl, logLines, openPodLogs, paneTerminal, panelButton, shellKubeconfigs } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";
import { cannotCloseLikeUser, closeLikeUser, openNewWindow, selectContext, switchTo, windowHandles, x11Titles } from "../lib/window.mjs";

const contextValue = (app) => app.js(`return document.querySelector('select[aria-label="Cluster context"]')?.value ?? ""`);

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LABEL = "kubeloupe.dev/node-shell=true";
const NODE = kubectl(["get", "nodes", "-o", "jsonpath={.items[0].metadata.name}"]);

/** A pod that logs `word-<n>` every half second. */
const sayer = (name, word) => `
apiVersion: v1
kind: Pod
metadata:
  name: ${name}
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "i=0; while true; do echo ${word}-$i; i=$((i+1)); sleep 0.5; done"]
`;

function nodeShellPods() {
  const out = kubectl(["-n", "kube-system", "get", "pods", "-l", LABEL, "-o", "jsonpath={.items[*].metadata.name}"]);
  return out ? out.split(/\s+/) : [];
}

let ns;
let kc;
let main;
let second;
let url;
const ours = new Set();

describe("area 5: several windows", { timeout: 25 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-area5-win", [httpPodYaml("web", 8080, "hello from area 5"), sayer("alpha", "ALPHA"), sayer("bravo", "BRAVO")].join("---\n"));
    for (const p of ["web", "alpha", "bravo"]) waitPodReady(ns, p);
  });
  after(() => {
    for (const pod of ours) {
      try {
        kubectl(["-n", "kube-system", "delete", "pod", pod, "--ignore-not-found", "--wait=false"]);
      } catch (e) {
        console.error(`could not delete kube-system/${pod}: ${e.message}`);
      }
    }
    deleteNamespace(ns);
    kc?.remove();
  });
  const s = appSession("area-5-windows", () => {
    kc = aliasKubeconfig();
    return { kubeconfig: kc.path };
  });

  it("a new window is titled with its context and retitled on a switch", T, async () => {
    const { app } = s;
    await waitLive(app);
    main = await app.driver.getWindowHandle();
    second = await openNewWindow(app);
    // The native window titles (WebDriver's getTitle() is the page's <title>).
    const pid = appPid(app.profile.home);
    const titles = () => (cannotCloseLikeUser() ? null : x11Titles(pid));
    if (titles()) {
      await app.waitFor(() => JSON.stringify(titles()) === JSON.stringify([CONTEXT, CONTEXT]), {
        message: `both windows titled ${CONTEXT}`,
      });
    }
    await switchTo(app, second);
    await waitLive(app);
    await selectContext(app, kc.alias);
    await waitLive(app);
    if (titles()) {
      await app.waitFor(() => JSON.stringify(titles()) === JSON.stringify([CONTEXT, kc.alias].sort()), {
        message: `titles ${CONTEXT} and ${kc.alias}`,
      });
      console.log(`window titles: ${JSON.stringify(titles())}`);
    }
  });

  it("logs in both windows show only their own pod", T, async () => {
    const { app } = s;
    await switchTo(app, main);
    const a = await openPodLogs(app, ns, "alpha");
    await switchTo(app, second);
    const b = await openPodLogs(app, ns, "bravo");
    await sleep(4000);
    await app.waitFor(async () => (await logLines(app, b)).some((l) => l.includes("BRAVO-")), { message: "BRAVO lines in B" });
    const inB = await logLines(app, b);
    await switchTo(app, main);
    const inA = await logLines(app, a);
    console.log(`A: ${inA.length} lines (${inA.at(-1)}), B: ${inB.length} lines (${inB.at(-1)})`);
    assert.ok(inA.some((l) => l.includes("ALPHA-")), "ALPHA lines in A");
    assert.ok(!inA.some((l) => l.includes("BRAVO")), "no BRAVO line in A");
    assert.ok(!inB.some((l) => l.includes("ALPHA")), "no ALPHA line in B");
  });

  it("terminals in both windows keep their own output", T, async () => {
    const { app } = s;
    await switchTo(app, main);
    await app.openDetail("Pods", ns, "alpha");
    await panelButton(app, "Open terminal");
    const ta = terminal(app, paneTerminal(`shell:${ns}/alpha`));
    await ta.waitForPrompt(60_000);
    await switchTo(app, second);
    await app.openDetail("Pods", ns, "bravo");
    await panelButton(app, "Open terminal");
    const tb = terminal(app, paneTerminal(`shell:${ns}/bravo`));
    await tb.waitForPrompt(60_000);
    assert.equal(await tb.run("hostname"), "bravo");
    await tb.type("echo MARK-FROM-B");
    await sleep(1500);
    await switchTo(app, main);
    assert.equal(await ta.run("hostname"), "alpha");
    await ta.type("echo MARK-FROM-A");
    await sleep(1500);
    const screenA = await ta.screen();
    await switchTo(app, second);
    const screenB = await tb.screen();
    assert.ok(screenA.includes("MARK-FROM-A") && !screenA.includes("MARK-FROM-B"), `A's terminal:\n${screenA}`);
    assert.ok(screenB.includes("MARK-FROM-B") && !screenB.includes("MARK-FROM-A"), `B's terminal:\n${screenB}`);
  });

  it("a port-forward in A survives a context switch in B", T, async () => {
    const { app } = s;
    await switchTo(app, main);
    await app.openDetail("Pods", ns, "web");
    const panel = await app.find(byTestId("detail-panel"));
    await app.setValue(await panel.findElement(By.css('input[aria-label="Pod port"]')), "8080");
    await (await panel.findElement(By.xpath(".//button[normalize-space()='Forward']"))).click();
    url = await app.waitFor(async () => (await panel.getText()).match(/Forwarding (http:\/\/127\.0\.0\.1:\d+)/)?.[1], {
      message: "Forwarding http://127.0.0.1:<port>",
    });
    assert.match(await (await fetch(url)).text(), /hello from area 5/);
    await switchTo(app, second);
    await selectContext(app, CONTEXT);
    await waitLive(app);
    assert.match(await (await fetch(url)).text(), /hello from area 5/, "still forwarding after B switched context");
    await selectContext(app, kc.alias);
    await waitLive(app);
  });

  it("closing B deletes its node shell pod and local shell kubeconfig; A's forward survives", T, async () => {
    const { app } = s;
    const pid = appPid(app.profile.home);
    await switchTo(app, second);
    // A node shell in B.
    await app.nav("Nodes");
    await app.filter(NODE);
    await (await app.find(app.row(NODE))).click();
    await app.find(byTestId("detail-panel"));
    const before = new Set(nodeShellPods());
    await panelButton(app, "Shell");
    await terminal(app, paneTerminal(`node:${NODE}`)).waitFor(/Shell on /, { timeout: 120_000 });
    const pod = await app.waitFor(() => nodeShellPods().find((p) => !before.has(p)), { message: "the node shell pod" });
    ours.add(pod);
    // A local shell in B.
    const files0 = new Set(shellKubeconfigs(tmpdir()).filter((f) => f.startsWith(`kubeloupe-shell-${pid}-`)));
    await dockControl(app, "New local terminal");
    const file = await app.waitFor(
      () => shellKubeconfigs(tmpdir()).find((f) => f.startsWith(`kubeloupe-shell-${pid}-`) && !files0.has(f)),
      { message: "the local shell's temp kubeconfig" },
    );
    console.log(`node shell pod ${pod}, local shell kubeconfig ${file}`);
    await app.shot("window-b-before-close");

    // Like the window manager's close button: WebDriver's Close Window only
    // drops the webview and leaves the native window (and its session) alive.
    await switchTo(app, main);
    if (cannotCloseLikeUser()) await switchTo(app, second).then(() => app.driver.close()).then(() => switchTo(app, main));
    else assert.equal(closeLikeUser(pid, { title: kc.alias }).length, 1, `one window titled ${kc.alias}`);
    await app.waitFor(async () => (await windowHandles(app)).length === 1, { message: "one window left" });
    await app.waitFor(() => !nodeShellPods().includes(pod), { timeout: 60_000, interval: 1000, message: `node shell pod ${pod} deleted` });
    await app.waitFor(() => !shellKubeconfigs(tmpdir()).includes(file), { message: `${file} removed` });
    assert.match(await (await fetch(url)).text(), /hello from area 5/, "A's forward after B closed");
    assert.equal(await app.statusText(), "Live");
    await app.waitFor(() => (app.profile.settings()?.windows ?? []).length === 0, { message: "no extra window remembered" });
  });

  it("`win <context>` in the palette opens a window on that context", T, async () => {
    const { app } = s;
    const before = await windowHandles(app);
    await app.palette(`win ${kc.alias}`, kc.alias);
    const all = await app.waitFor(async () => {
      const now = await windowHandles(app);
      return now.length > before.length ? now : null;
    }, { message: "a new window" });
    second = all.find((h) => !before.includes(h));
    await switchTo(app, second);
    await waitLive(app);
    assert.equal(await contextValue(app), kc.alias);
    await app.waitFor(() => JSON.stringify(app.profile.settings()?.windows) === JSON.stringify([kc.alias]), {
      message: `settings.windows = [${kc.alias}]`,
    });
    await switchTo(app, main);
  });

  /** Wait for the app to exit, start it again and return the contexts of its windows. */
  async function restartAndList(app, pid) {
    await app.waitFor(() => !isRunning(pid), { timeout: 20_000, message: "the app to exit" });
    console.log(`settings.windows after exit: ${JSON.stringify(app.profile.settings()?.windows)}`);
    await app.restart({ wait: 0 });
    await app.find(By.css("nav"));
    await sleep(5000); // the remembered windows open after start-up
    const contexts = [];
    for (const h of await windowHandles(app)) {
      await switchTo(app, h);
      await app.waitFor(() => contextValue(app), { message: "a context in the window" });
      contexts.push(await contextValue(app));
    }
    const titles = x11Titles(appPid(app.profile.home));
    console.log(`after the restart: contexts ${JSON.stringify(contexts)}, window titles ${JSON.stringify(titles)}`);
    main = (await windowHandles(app))[contexts.indexOf(CONTEXT)];
    return { contexts: contexts.sort(), titles };
  }

  it(
    "closing the main window, then the second, reopens the second on its context",
    { ...T, skip: cannotCloseLikeUser() },
    async () => {
      const { app } = s;
      const pid = appPid(app.profile.home);
      closeLikeUser(pid, { title: CONTEXT });
      await sleep(1500);
      assert.ok(isRunning(pid), "the app keeps running with the second window");
      closeLikeUser(pid, { title: kc.alias });
      const { contexts, titles } = await restartAndList(app, pid);
      assert.deepEqual(contexts, [CONTEXT, kc.alias].sort());
      assert.deepEqual(titles, [CONTEXT, kc.alias].sort());
    },
  );

  it(
    "closing both windows at once (as on logout) reopens the second on its context",
    { ...T, skip: cannotCloseLikeUser(), todo: "#126: the second window is forgotten when it closes before the main one" },
    async () => {
      const { app } = s;
      const pid = appPid(app.profile.home);
      const ids = closeLikeUser(pid);
      console.log(`closed X11 windows ${ids.join(", ")}`);
      const { contexts } = await restartAndList(app, pid);
      assert.deepEqual(contexts, [CONTEXT, kc.alias].sort());
    },
  );
});

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

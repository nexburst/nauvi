// QA area 4 (#83): the bottom dock with several terminals and log tabs.
// Checks (#67): two terminals and a log tab at once; resizing and
// maximizing the dock refits xterm and the shell gets the new size
// (`stty size`), and at the default height the last row is fully visible
// (#181); Ctrl+` and Ctrl+(dead Backquote) inside a shell toggle the dock
// and send nothing to it, while Ctrl+J reaches the shell (#175); an 11th
// log tab shows the cap message; switching context closes every
// tab and no stream or session keeps running.
// Checks (#19): close a terminal tab and open it again; switching views
// keeps the dock (the panel and its streams were replaced by dock tabs in #67).
// Checks (#43): Ctrl+Shift+` opens a local shell; its temp kubeconfig
// (`kubeloupe-shell-<pid>-<n>.yaml` in the app's temp dir) is removed when
// the tab closes.
// Checks (#116): with the strip overflowing, every tab and its ✕ take
// clicks on their whole height (no overlay scrollbar over them).
//
// The app gets a kubeconfig with a second context on the same cluster
// (lib/dock.mjs `aliasKubeconfig`) and its own TMPDIR.

import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { CONTEXT } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, kubectl, loggerPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import {
  activateTab,
  aliasKubeconfig,
  closeTab,
  dockControl,
  dockHeight,
  dockTabs,
  dragDock,
  logLines,
  openPodLogs,
  pane,
  paneTerminal,
  panelButton,
  pressCtrl,
  shellKubeconfigs,
  stripHitTest,
} from "../lib/dock.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";
import { selectContext } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";
const LOGGERS = Array.from({ length: 10 }, (_, i) => `qa-area4-log-${i + 1}`);

let ns;
let kc;
let tmp;
let shellTab;
let localTitle;
let shellsBefore = 0;
let shellsAtSwitch = 0;

/** `/bin/sh` exec sessions running in the shell pod (its main process is httpd). */
function execShells() {
  const out = kubectl(["-n", ns, "exec", "shell", "--", "ps", "-o", "pid,args"]);
  return out.split("\n").filter((l) => /\s\/bin\/sh$/.test(l)).length;
}

/** `execShells()` once it is `want`, or what it still is after 15 s (closing
 *  a tab ends its shell within about 2 s). */
async function settledShells(app, want) {
  let now = execShells();
  await app
    .waitFor(() => (now = execShells()) === want, { timeout: 15_000, interval: 1000, message: `${want} /bin/sh` })
    .catch(() => {});
  return now;
}

describe("area 4: dock with terminals and logs", { timeout: 30 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-area4-dock", [httpPodYaml("shell"), loggerPodYaml("chatty"), ...LOGGERS.map((n) => loggerPodYaml(n, 2))].join("\n---\n"));
    for (const p of ["shell", "chatty", ...LOGGERS]) waitPodReady(ns, p);
  });
  after(() => {
    deleteNamespace(ns);
    kc?.remove();
  });
  const s = appSession("area-4-dock", () => {
    kc = aliasKubeconfig();
    // The profile's HOME is made in launch(); a TMPDIR of our own is enough.
    tmp = join(kc.path, "..", "tmp");
    mkdirSync(tmp);
    return { kubeconfig: kc.path, env: { SHELL, TMPDIR: tmp } };
  });

  it("two terminals and a log tab at once", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.openDetail("Pods", ns, "shell");
    await panelButton(app, "Open terminal");
    shellTab = `shell:${ns}/shell`;
    const pod = terminal(app, paneTerminal(shellTab));
    await pod.waitForPrompt();
    assert.equal(await pod.run("echo pod-$((40+2))"), "pod-42");

    await dockControl(app, "New local terminal");
    const local = terminal(app);
    await local.waitFor(`kubectl uses context ${CONTEXT}`);
    await local.waitForPrompt();
    assert.equal(await local.run("echo local-$((6*7))"), "local-42");
    assert.equal(await local.run("kubectl config current-context"), CONTEXT);
    localTitle = (await dockTabs(app)).find((t) => t.active).title;
    assert.equal(shellKubeconfigs(tmp).length, 1, `one temp kubeconfig in ${tmp}`);

    const logs = await openPodLogs(app, ns, "chatty");
    await app.waitFor(async () => (await logLines(app, logs)).some((l) => l.startsWith("qa line")), { message: "log lines" });

    const tabs = await dockTabs(app);
    console.log(`tabs: ${JSON.stringify(tabs)}`);
    assert.equal(tabs.length, 3);
    // Each tab kept its session and scrollback.
    await activateTab(app, "Shell: shell");
    await pod.waitFor("pod-42");
    await activateTab(app, localTitle);
    await terminal(app).waitFor("local-42");
    assert.equal(await terminal(app).run("echo still-$((1+1))"), "still-2");
    await activateTab(app, "Shell: shell");
  });

  it("at the default dock height the shell's last row is fully visible (#181)", T, async () => {
    const { app } = s;
    const root = paneTerminal(shellTab);
    const pod = terminal(app, root);
    const [rows] = await pod.size();
    // Fill the screen and put a marker on the last row, where vim's status
    // line and htop's key bar go (split, so the command line never matches).
    await pod.type(`clear; i=1; while [ $i -lt ${rows} ]; do echo row-$i; i=$((i+1)); done; printf '%s%s' LAST-ROW '-MARK'`);
    const screen = await pod.waitFor(/LAST-ROW-MARK/, { message: "the marker on the last row" });
    const lines = screen.split("\n");
    const g = await app.js(
      `const box = document.querySelector(arguments[0]);
       const st = getComputedStyle(box);
       const b = box.getBoundingClientRect();
       const sc = box.querySelector('.xterm-screen').getBoundingClientRect();
       const rows = box.querySelector('.xterm-rows').children;
       const last = rows[rows.length - 1].getBoundingClientRect();
       return { rendered: rows.length, contentBottom: b.bottom - parseFloat(st.paddingBottom) - parseFloat(st.borderBottomWidth),
                screenBottom: sc.bottom, lastTop: last.top, lastBottom: last.bottom, boxBottom: b.bottom };`,
      root,
    );
    console.log(`default dock: stty ${rows} rows; geometry ${JSON.stringify(g)}; last line ${JSON.stringify(lines.at(-1))}`);
    await app.shot("dock-default-last-row");
    assert.equal(g.rendered, rows, "xterm draws as many rows as the PTY has");
    assert.match(lines[rows - 1] ?? "", /LAST-ROW-MARK/, "the marker is on the last row");
    assert.ok(g.lastBottom <= g.contentBottom + 0.5, `the last row ends inside the dock (${g.lastBottom} > ${g.contentBottom})`);
    assert.ok(g.screenBottom <= g.contentBottom + 0.5, `the screen ends inside the dock (${g.screenBottom} > ${g.contentBottom})`);
    await pressCtrl(app, "c");
    await pod.type("clear");
    await pod.waitForPrompt();
  });

  it("resizing and maximizing the dock refits xterm and the PTY", T, async () => {
    const { app } = s;
    const pod = terminal(app, paneTerminal(shellTab));
    const h0 = await dockHeight(app);
    const [r0, c0] = await pod.size();
    const h1 = await dragDock(app, -200);
    assert.ok(h1 > h0 + 150, `dragging up grows the dock (${h0} -> ${h1})`);
    const [r1, c1] = await app.waitFor(
      async () => {
        const sz = await pod.size();
        return sz[0] > r0 ? sz : null;
      },
      { message: `more than ${r0} rows after dragging the dock up` },
    );
    await app.shot("dock-dragged");
    await dockControl(app, "Maximize dock");
    const [r2] = await app.waitFor(
      async () => {
        const sz = await pod.size();
        return sz[0] > r1 ? sz : null;
      },
      { message: `more than ${r1} rows maximized` },
    );
    // xterm fills the pane: its rows reach the pane's bottom.
    const fill = await app.js(
      `const p = document.querySelector(arguments[0]).getBoundingClientRect();
       const x = document.querySelector(arguments[0] + ' .xterm-screen').getBoundingClientRect();
       return { pane: p.height, screen: x.height, gap: p.bottom - x.bottom };`,
      paneTerminal(shellTab),
    );
    console.log(`stty size: ${r0}x${c0} -> dragged ${r1}x${c1} -> maximized ${r2}; maximized fill ${JSON.stringify(fill)}`);
    assert.ok(fill.gap < 40, `xterm fills the maximized pane (gap ${fill.gap}px)`);
    await app.shot("dock-maximized");
    await dockControl(app, "Restore dock");
    await app.waitFor(async () => (await pod.size())[0] === r1, { message: `back to ${r1} rows after restoring` });
    await dragDock(app, 200);
    await app.waitFor(async () => (await pod.size())[0] < r1, { message: "fewer rows after dragging down" });
  });

  it("Ctrl+` inside the shell toggles the dock and sends nothing to it", T, async () => {
    const { app } = s;
    const pod = terminal(app, paneTerminal(shellTab));
    await pod.type("cat -v");
    await sleep(500);
    await pressCtrl(app, "`");
    await app.waitFor(() => app.js(`return document.querySelector('[data-testid="dock"]').classList.contains('collapsed')`), {
      message: "the dock to collapse",
    });
    await app.shot("dock-collapsed");
    await pressCtrl(app, "`");
    await app.waitFor(() => app.js(`return !document.querySelector('[data-testid="dock"]').classList.contains('collapsed')`), {
      message: "the dock to expand",
    });
    // #175: Ctrl+the Backquote key on layouts where it is a dead key (key
    // "Dead", code "Backquote"; WebDriver can only synthesise it).
    const collapsed = () => app.js(`return document.querySelector('[data-testid="dock"]').classList.contains('collapsed')`);
    const deadKey = `const init = { key: "Dead", code: "Backquote", ctrlKey: true, bubbles: true, cancelable: true };
       (document.activeElement || document.body).dispatchEvent(new KeyboardEvent("keydown", init));`;
    await app.js(deadKey);
    await app.waitFor(collapsed, { message: "Ctrl+(dead Backquote) to collapse the dock" });
    await app.js(deadKey);
    await app.waitFor(async () => !(await collapsed()), { message: "Ctrl+(dead Backquote) to expand the dock" });
    // Ctrl+J toggles the dock only outside the terminal (on Linux and
    // Windows): inside it is LF, which fzf, vim and emacs use.
    await pod.type("jj", { enter: false });
    await pressCtrl(app, "j");
    await pod.waitFor(/^jj\s*\njj\s*$/m, { message: "Ctrl+J reaching cat -v as a newline" });
    assert.equal(await collapsed(), false, "Ctrl+J in the terminal leaves the dock open");
    await app.shot("ctrl-j-in-shell");
    await app.js("document.activeElement?.blur()");
    await pressCtrl(app, "j");
    await app.waitFor(collapsed, { message: "Ctrl+J outside the terminal to collapse the dock" });
    await pressCtrl(app, "j");
    await app.waitFor(async () => !(await collapsed()), { message: "Ctrl+J outside the terminal to expand the dock" });
    await pod.type("zz");
    const screen = await pod.waitFor(/^zz\s*$/m, { message: "cat -v echoing zz" });
    assert.ok(!/\^@/.test(screen), "no NUL (^@) reached the shell");
    // End cat (Ctrl+C reaches the shell).
    await pressCtrl(app, "c");
    await pod.waitForPrompt();
    assert.equal(await pod.run("echo after-cat"), "after-cat");
  });

  it("close a terminal tab, then Open terminal starts a new one", T, async () => {
    const { app } = s;
    shellsBefore = execShells();
    assert.ok(shellsBefore >= 1, "an exec shell while the tab is open");
    await closeTab(app, "Shell: shell");
    await app.waitFor(async () => !(await dockTabs(app)).some((t) => t.title === "Shell: shell"), { message: "tab closed" });
    await app.openDetail("Pods", ns, "shell");
    await panelButton(app, "Open terminal");
    const pod = terminal(app, paneTerminal(shellTab));
    await pod.waitForPrompt();
    assert.equal(await pod.run("echo reopened"), "reopened");
  });

  it("closing a terminal tab ends its /bin/sh in the pod", T, async () => {
    // One shell per open tab: the closed tab's shell is gone (#114).
    const now = await settledShells(s.app, 1);
    console.log(`exec shells: ${shellsBefore} with one tab open, ${now} after close + reopen`);
    assert.equal(now, 1, `${now} /bin/sh in the pod with one terminal tab open`);
  });

  it("switching views keeps the dock and its tabs", T, async () => {
    const { app } = s;
    const before = await dockTabs(app);
    await app.nav("Deployments");
    await sleep(1000);
    assert.deepEqual((await dockTabs(app)).map((t) => t.title), before.map((t) => t.title));
    await app.nav("Pods");
  });

  it("an 11th log tab shows the cap message", { timeout: 300_000 }, async (t) => {
    const { app } = s;
    // chatty is the first log stream; nine more make ten.
    const ids = [`logs:${ns}/chatty`];
    for (const name of LOGGERS.slice(0, 9)) {
      const id = await openPodLogs(app, ns, name);
      ids.push(id);
      await app.waitFor(async () => (await logLines(app, id)).some((l) => l.startsWith("qa line")), { message: `${name} lines` });
    }
    // A stream the kubelet ended frees its slot. On a host short of inotify
    // instances (fs.inotify.max_user_instances, shared by every kind node),
    // the kubelet ends follows with "failed to create fsnotify watcher".
    const ended = [];
    for (const id of ids) {
      const l = await logLines(app, id);
      if (l.includes("[stream ended]")) ended.push(`${id}: ${l.filter((x) => !x.startsWith("qa line")).join(" | ")}`);
    }
    if (ended.length > 0) {
      t.skip(`the kubelet ended ${ended.length} of the 10 streams, so the cap is not reached: ${ended.join("; ")}`);
      return;
    }
    const eleventh = await openPodLogs(app, ns, LOGGERS[9]);
    const msg = await app.waitFor(async () => (await logLines(app, eleventh)).find((l) => /Too many log streams/.test(l)), {
      message: "the cap message in the 11th log tab",
    });
    console.log(`11th tab: ${msg}`);
    assert.match(msg, /10 are already open\. Close a log tab to open another\./);
    await app.shot("log-cap");
    // Closing one frees a slot: restarting the 11th's stream works.
    await closeTab(app, "Logs: chatty");
    await sleep(500);
    await app.js(
      `const s = document.querySelector(arguments[0] + ' select[title="Tail lines"]');
       s.value = "100"; s.dispatchEvent(new Event("change", { bubbles: true }));`,
      pane(eleventh),
    );
    await app.waitFor(async () => (await logLines(app, eleventh)).some((l) => l.startsWith("qa line")), {
      message: "the 11th tab streams after one was closed",
    });
  });

  it("with the strip overflowing, a tab takes clicks on its whole height (#116)", T, async () => {
    const { app } = s;
    const hit = await stripHitTest(app);
    console.log(`strip hit test: ${JSON.stringify(hit)}`);
    assert.ok(hit.overflows, `the strip overflows with ${hit.tabs} tabs`);
    assert.ok(hit.scrollbar > 0, "the strip's scrollbar takes its own room below the tabs");
    assert.equal(hit.vertical, 0, "no vertical scrollbar at the strip's end");
    assert.deepEqual(hit.misses, [], "every tab label and ✕ takes clicks at its centre and its lower edge");
    // Real WebDriver clicks on the first tab (no click from the page).
    const first = (await dockTabs(app))[0].title;
    await activateTab(app, first);
    await app.waitFor(async () => (await dockTabs(app))[0].active, { message: `${first} active` });
    await setTheme(app, "dark");
    await app.shot("overflowing-strip-dark");
    await setTheme(app, "light");
    await app.shot("overflowing-strip-light");
    await setTheme(app, null);
  });

  it("Ctrl+Shift+` opens another local shell; closing it removes its temp kubeconfig", T, async () => {
    const { app } = s;
    const before = (await dockTabs(app)).length;
    // From inside a terminal, where the shortcut must work too.
    await activateTab(app, localTitle);
    const [input] = await app.driver.findElements(By.css('[data-testid="dock-pane"]:not(.hidden) .xterm-helper-textarea'));
    assert.ok(input, "the local shell's xterm input");
    await input.sendKeys(Key.chord(Key.CONTROL, Key.SHIFT, "`"));
    const tabs = await app.waitFor(
      async () => {
        const t = await dockTabs(app);
        return t.length === before + 1 ? t : null;
      },
      { message: "a new local shell tab" },
    );
    const title = tabs.find((t) => t.active).title;
    await terminal(app).waitForPrompt();
    assert.equal(shellKubeconfigs(tmp).length, 2, "two temp kubeconfigs with two local shells");
    await closeTab(app, title);
    await app.waitFor(() => shellKubeconfigs(tmp).length === 1, { message: "the closed shell's temp kubeconfig removed" });
  });

  it("switching context closes every tab and stops every stream and session", { timeout: 300_000 }, async () => {
    const { app } = s;
    assert.equal(shellKubeconfigs(tmp).length, 1);
    shellsAtSwitch = execShells();
    console.log(`tabs before the switch: ${(await dockTabs(app)).length}; exec shells in the pod: ${shellsAtSwitch}`);
    await selectContext(app, kc.alias);
    await app.waitFor(async () => (await dockTabs(app)).length === 0, { message: "no dock tabs after the context switch" });
    await waitLive(app);
    await app.waitFor(() => shellKubeconfigs(tmp).length === 0, { message: "the local shell's temp kubeconfig removed" });
    await app.shot("after-context-switch");
    // Ten new log streams fit: the old ten were stopped.
    for (const name of ["chatty", ...LOGGERS.slice(0, 9)]) {
      const id = await openPodLogs(app, ns, name);
      await app.waitFor(
        async () => {
          const l = await logLines(app, id);
          if (l.some((x) => /Too many log streams/.test(x))) throw new Error(`cap hit at ${name}: old streams still counted`);
          return l.some((x) => x.startsWith("qa line"));
        },
        { message: `${name} lines on ${kc.alias}` },
      );
    }
    await app.shot("ten-tabs-after-switch");
    await selectContext(app, CONTEXT);
    await app.waitFor(async () => (await dockTabs(app)).length === 0, { message: "no dock tabs after switching back" });
  });

  it("after the context switch no terminal's /bin/sh is left in the pod", T, async () => {
    assert.ok(shellsAtSwitch >= 1, "a terminal was open at the switch");
    const now = await settledShells(s.app, 0);
    console.log(`exec shells: ${shellsAtSwitch} before the switch, ${now} after`);
    assert.equal(now, 0);
  });
});

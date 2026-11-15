// QA area 4 (#83): Attach (#88) and Debug… (#72) in dock terminals.
// Checks (#88): Attach to a container with stdin and a TTY: typing works,
// the TTY follows a dock resize, closing the tab leaves the process running
// and a second Attach reaches the same process; a container without stdin
// gives the plain error; `kubeloupe attach` in a real TTY detaches on
// Ctrl-P Ctrl-Q, also from an ephemeral debug container whose tab was
// closed.
// Checks (#72): Debug… on a pod: the dialog, typing in the attached shell
// (it sees the target's processes), resizing the dock, closing the tab.
// Debug containers only go on pods in this scenario's temp namespace
// (ephemeral containers cannot be removed).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, REPO, byTestId } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { closeTab, dockTabs, dragDock, paneTerminal, panelButton } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const target = process.env.CARGO_TARGET_DIR || join(REPO, "target");
const CLI = process.env.KUBELOUPE_CLI || join(target, "debug", "kubeloupe");
const noCli = existsSync(CLI) ? false : `no CLI at ${CLI} (cargo build -p kubeloupe)`;
const noScript = existsSync("/usr/bin/script") ? false : "no script(1) to give the CLI a real TTY";

const PODS = `
apiVersion: v1
kind: Pod
metadata:
  name: tty
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: main
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh"]
      stdin: true
      tty: true
---
apiVersion: v1
kind: Pod
metadata:
  name: nostdin
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sleep", "3600"]
`;

let ns;

function restarts(pod) {
  return Number(kubectl(["-n", ns, "get", "pod", pod, "-o", "jsonpath={.status.containerStatuses[0].restartCount}"]));
}

/**
 * Run the CLI under script(1), so it has a real TTY. Returns helpers to
 * write to it and wait for its output and exit.
 */
function cliInTty(args) {
  const cmd = [CLI, "--context", CONTEXT, ...args].map((a) => `'${a}'`).join(" ");
  const p = spawn("script", ["-qfec", cmd, "/dev/null"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, TERM: "xterm" } });
  let out = "";
  p.stdout.on("data", (d) => (out += d));
  p.stderr.on("data", (d) => (out += d));
  const exited = new Promise((r) => p.once("exit", (code) => r(code)));
  return {
    write: (s) => p.stdin.write(s),
    output: () => out,
    async waitFor(re, ms = 30_000) {
      const end = Date.now() + ms;
      while (!re.test(out)) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${re} in CLI output:\n${out}`);
        await sleep(200);
      }
    },
    async exit(ms = 15_000) {
      return Promise.race([exited, sleep(ms).then(() => (p.kill("SIGKILL"), "timeout"))]);
    },
  };
}

describe("area 4: attach and debug containers", { timeout: 20 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-area4-attach", [PODS, httpPodYaml("web")].join("\n---\n"));
    for (const p of ["tty", "nostdin", "web"]) waitPodReady(ns, p);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("area-4-attach-debug");

  it("Attach to a TTY container: typing, resize, close leaves it running", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.openDetail("Pods", ns, "tty");
    await panelButton(app, "Attach");
    const id = `attach:${ns}/tty/`;
    const term = terminal(app, paneTerminal(id));
    await sleep(1500);
    console.log(`attach screen:\n${await term.screen()}`);
    await term.type("");
    await term.waitForPrompt();
    assert.equal(await term.run("echo attached-$((40+2))"), "attached-42");
    // Same process as PID 1 of the container.
    assert.equal(await term.run("echo pid-$$"), "pid-1");
    const [r0] = await term.size();
    await dragDock(app, -200);
    const [r1] = await app.waitFor(
      async () => {
        const sz = await term.size();
        return sz[0] > r0 ? sz : null;
      },
      { message: `more than ${r0} rows after a dock resize` },
    );
    console.log(`attach stty size rows ${r0} -> ${r1}`);
    await term.type("export QA_MARK=still-here");
    await app.shot("attached");
    await closeTab(app, "Attach: tty");
    await sleep(3000);
    assert.equal(kubectl(["-n", ns, "get", "pod", "tty", "-o", "jsonpath={.status.phase}"]), "Running");
    assert.equal(restarts("tty"), 0, "the process was not restarted by closing the tab");
    // Attach again: the same shell, with the variable set before.
    await panelButton(app, "Attach");
    const again = terminal(app, paneTerminal(id));
    await again.type("");
    await again.waitForPrompt();
    assert.equal(await again.run("echo $QA_MARK"), "still-here");
    await closeTab(app, "Attach: tty");
  });

  it("Attach to a container without stdin explains why not", T, async () => {
    const { app } = s;
    await app.openDetail("Pods", ns, "nostdin");
    await panelButton(app, "Attach");
    const term = terminal(app, paneTerminal(`attach:${ns}/nostdin/`));
    const screen = await term.waitFor(/stdin/);
    console.log(`no stdin:\n${screen}`);
    assert.match(screen.replace(/\n/g, ""), /was not started with stdin open/);
    await app.shot("attach-no-stdin");
    await closeTab(app, "Attach: nostdin");
  });

  it("Debug…: the dialog, a shell that sees the target's processes, resize, close", T, async () => {
    const { app } = s;
    await app.openDetail("Pods", ns, "web");
    await panelButton(app, "Debug…");
    // (WebKitWebDriver cannot check the displayedness of this dialog: no app.find.)
    const dialog = await app.waitFor(async () => (await app.driver.findElements(byTestId("debug-dialog")))[0], {
      message: "the Debug pod dialog",
    });
    await app.waitFor(
      async () => (await dialog.findElement(By.css('select[aria-label="Target container"]')).getAttribute("value")) === "web",
      { message: "target container web" },
    );
    assert.equal(await dialog.findElement(By.css('input[aria-label="Debug image"]')).getAttribute("value"), "busybox:1.37");
    const text = await app.js("return arguments[0].innerText", dialog);
    console.log(`debug dialog: ${text.replace(/\n/g, " | ")}`);
    await app.shot("debug-dialog");
    await (await app.driver.findElement(byTestId("debug-confirm"))).click();
    const id = `debug:${ns}/web/web`;
    const term = terminal(app, paneTerminal(id));
    await term.waitFor(/Attached to/, { timeout: 90_000 });
    await term.type("");
    await term.waitForPrompt();
    const ps = await term.run("ps -o pid,args");
    assert.match(ps, /httpd/, "the debug shell sees the target's httpd");
    const [r0] = await term.size();
    await dragDock(app, 150);
    await app.waitFor(async () => (await term.size())[0] < r0, { message: `fewer than ${r0} rows after a dock resize` });
    await app.shot("debug-shell");
    const tab = (await dockTabs(app)).find((t) => t.active).title;
    await closeTab(app, tab);
    assert.equal((await dockTabs(app)).length, 0);
    const names = kubectl(["-n", ns, "get", "pod", "web", "-o", "jsonpath={.spec.ephemeralContainers[*].name}"]);
    console.log(`ephemeral containers: ${names}`);
    assert.ok(names.length > 0);
  });

  it("kubeloupe attach: Ctrl-P Ctrl-Q detaches in a real TTY, the process keeps running", { ...T, skip: noCli || noScript }, async () => {
    const cli = cliInTty(["attach", "tty", "-n", ns]);
    await cli.waitFor(/Ctrl-P Ctrl-Q/);
    cli.write("\r");
    await sleep(500);
    cli.write("echo cli-$((1+1))\r");
    await cli.waitFor(/cli-2/);
    cli.write("\x10\x11");
    const code = await cli.exit();
    console.log(`CLI output:\n${cli.output()}\nexit: ${code}`);
    assert.equal(code, 0, "exits after Ctrl-P Ctrl-Q");
    assert.match(cli.output(), /Detached; the process keeps running/);
    assert.equal(kubectl(["-n", ns, "get", "pod", "tty", "-o", "jsonpath={.status.phase}"]), "Running");
    assert.equal(restarts("tty"), 0);
  });

  it("kubeloupe attach to the debug container after its tab was closed", { ...T, skip: noCli || noScript }, async () => {
    const name = kubectl(["-n", ns, "get", "pod", "web", "-o", "jsonpath={.spec.ephemeralContainers[0].name}"]);
    assert.ok(name, "the Debug… test added a debug container");
    const state = kubectl(["-n", ns, "get", "pod", "web", "-o", "jsonpath={.status.ephemeralContainerStatuses[0].state}"]);
    console.log(`debug container ${name}: ${state}`);
    const cli = cliInTty(["attach", "web", "-n", ns, "-c", name]);
    await cli.waitFor(/Ctrl-P Ctrl-Q|not running|no process/);
    if (/not running/.test(cli.output())) {
      // Closing the tab ended the debug shell: nothing left to attach to.
      console.log(`CLI: ${cli.output()}`);
      assert.match(cli.output(), /container \S+ is not running/);
      await cli.exit();
      return;
    }
    cli.write("\r");
    await sleep(500);
    cli.write("echo dbg-$((2+3))\r");
    await cli.waitFor(/dbg-5/);
    cli.write("\x10\x11");
    assert.equal(await cli.exit(), 0);
  });
});

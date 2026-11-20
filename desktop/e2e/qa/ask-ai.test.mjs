// Ask AI (#376): the user's AI CLI in a dock terminal, with nauvi mcp.
//
// A fake `claude` on PATH records what it was started with (its arguments,
// KUBECONFIG, the MCP config file and that file's mode), then talks MCP to
// the server in that config, as Claude Code would: it lists the tools and
// lists the pods of a temp namespace. Then it waits for "done" and exits, and
// the tab must be the user's shell. The real `nauvi` CLI serves MCP
// (target/debug/nauvi; CI builds it); without it those checks are skipped.
//
// Helpers: `terminal`, `paneTerminal`, `closeTab`, `setTheme`.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId, CONTEXT, REPO, xq } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { closeTab, dockTabs } from "../lib/dock.mjs";
import { setTheme } from "../lib/panels.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";

const T = { timeout: 180_000 };
const target = process.env.CARGO_TARGET_DIR || join(REPO, "target");
const CLI = process.env.NAUVI_CLI || join(target, "debug", "nauvi");
const noCli = existsSync(CLI) ? false : `no nauvi CLI at ${CLI} (cargo build -p nauvi)`;
const noPython = existsSync("/usr/bin/python3") ? false : "no /usr/bin/python3 for the fake AI CLI";
const AI_NAMES = ["claude", "codex", "gemini"];
// What the fake CLI scales through nauvi mcp when writes are on.
const SCALED = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: scaled
spec:
  replicas: 1
  selector:
    matchLabels: { app: scaled }
  template:
    metadata:
      labels: { app: scaled }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: main
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sleep", "3600"]
`;

// The fake AI CLI. It records, prints a summary, speaks MCP if it can, then
// waits for "done" on its terminal.
const FAKE_CLAUDE = String.raw`#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv[1:]
rec = {"args": args, "kubeconfig": os.environ.get("KUBECONFIG", ""), "cwd": os.getcwd(), "isatty": sys.stdin.isatty()}
config = next((a.split("=", 1)[1] for a in args if a.startswith("--mcp-config=")), None)
if config:
    rec["config_path"] = config
    rec["config_mode"] = oct(os.stat(config).st_mode & 0o777)
    with open(config) as f:
        rec["config"] = json.load(f)
    ns = os.environ.get("ASK_AI_NS", "")
    server = rec["config"]["mcpServers"]["nauvi"]
    env = dict(os.environ, **server.get("env", {}))
    try:
        p = subprocess.Popen([server["command"]] + server["args"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env, text=True)
        def call(i, method, params=None):
            msg = {"jsonrpc": "2.0", "id": i, "method": method}
            if params is not None:
                msg["params"] = params
            p.stdin.write(json.dumps(msg) + "\n"); p.stdin.flush()
            while True:
                line = p.stdout.readline()
                if not line:
                    return None
                r = json.loads(line)
                if r.get("id") == i:
                    return r
        call(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "fake-claude", "version": "0"}})
        p.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n"); p.stdin.flush()
        tools = call(2, "tools/list") or {}
        rec["tools"] = [t["name"] for t in tools.get("result", {}).get("tools", [])]
        pods = call(3, "tools/call", {"name": "list", "arguments": {"kind": "pods", "namespace": ns}}) or {}
        rec["pods"] = "".join(c.get("text", "") for c in pods.get("result", {}).get("content", []))
        scale = call(4, "tools/call", {"name": "scale", "arguments": {"kind": "deploy", "name": "scaled", "namespace": ns, "replicas": 2}}) or {}
        rec["scale"] = json.dumps(scale)[:400]
        rec["scale_error"] = bool(scale.get("error")) or bool(scale.get("result", {}).get("isError"))
        p.stdin.close(); p.wait(timeout=10)
    except Exception as e:
        rec["mcp_error"] = repr(e)
with open(os.environ["ASK_AI_RECORD"], "a") as f:
    f.write(json.dumps(rec) + "\n")
print("FAKE-AI started with %d arguments" % len(args))
for a in args:
    print("ARG " + a.replace("\n", " | ")[:150])
print("MCP tools: " + ", ".join(rec.get("tools", [])))
print("Type done to exit")
for line in sys.stdin:
    if line.strip() == "done":
        break
print("FAKE-AI bye")
`;

/** PATH without the directories that hold a real AI CLI. */
function pathWithoutAiClis(extra = []) {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((d) => d && !AI_NAMES.some((n) => existsSync(join(d, n))));
  return [...extra, ...dirs].join(delimiter);
}

function records(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const dialogText = (app) => app.js(`return document.querySelector('[data-testid="ask-ai-dialog"]')?.innerText ?? ""`);

async function waitDialog(app) {
  await app.find(byTestId("ask-ai-dialog"));
  await app.waitFor(async () => !(await dialogText(app)).includes("Looking for AI CLIs"), { message: "the AI setup" });
  // Past the dialog's fade-in (180 ms), so screenshots show it settled.
  await new Promise((r) => setTimeout(r, 400));
}

async function closeDialog(app) {
  const cancel = await app.driver.findElements(By.xpath("//*[@data-testid='ask-ai-dialog']//button[normalize-space()='Cancel' or normalize-space()='Close']"));
  if (cancel.length) await cancel[0].click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("ask-ai-dialog"))).length === 0, {
    message: "the Ask AI dialog to close",
  });
}

describe("Ask AI with a fake claude on PATH", { timeout: 15 * 60_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), "nauvi-qa-ask-ai-"));
  const bin = join(work, "bin");
  const tmp = join(work, "tmp");
  const record = join(work, "record.jsonl");
  mkdirSync(bin);
  mkdirSync(tmp);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);
  if (!noCli) symlinkSync(CLI, join(bin, "nauvi"));
  let ns = "";

  before(() => {
    ns = tempNamespace("qa-ask-ai", `${httpPodYaml("asked")}\n---\n${SCALED}`);
    waitPodReady(ns, "asked");
  });
  // Our own profile: PATH is set here, and must keep its xdg-open recorder.
  const profile = createProfile();
  const s = appSession("ask-ai", () => ({
    profile,
    env: { PATH: pathWithoutAiClis([profile.bin, bin]), TMPDIR: tmp, ASK_AI_RECORD: record, ASK_AI_NS: ns },
  }));
  after(() => {
    profile.remove();
    deleteNamespace(ns);
    rmSync(work, { recursive: true, force: true });
  });

  it("the header offers Ask AI; the dialog lists the CLI and says the tools are read-only (light)", T, async () => {
    const { app } = s;
    await waitLive(app);
    await setTheme(app, "light");
    await (await app.find(byTestId("ask-ai-header"))).click();
    await waitDialog(app);
    const text = await dialogText(app);
    assert.match(text, new RegExp(`Ask AI about the cluster\\s+on\\s+${CONTEXT}`));
    assert.match(text, /Claude Code/);
    if (!noCli) assert.match(text, /nauvi MCP tools .* read-only/s);
    else assert.match(text, /nauvi CLI is not on PATH/);
  });

  it("the dialog in the dark theme, with writes ticked and the warning", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    const box = await app.driver.findElements(byTestId("ask-ai-writes"));
    if (!noCli) {
      await box[0].click();
      await app.find(byTestId("ask-ai-writes-warning"));
      assert.match(await dialogText(app), /can change .* as you/s);
      await app.shot("dark-writes-ticked");
      await box[0].click();
    }
  });

  it("Ask AI about a pod starts the fake claude with the MCP config and the pod in its prompt", T, async () => {
    const { app } = s;
    await closeDialog(app);
    await setTheme(app, "light");
    await app.openDetail("Pods", ns, "asked");
    await (await app.find(By.css('[data-testid="detail-panel"] [role="toolbar"] button[data-action="askAi"]'))).click();
    await waitDialog(app);
    const prompt = await app.js(`return document.querySelector('[data-testid="ask-ai-prompt"]').value`);
    assert.match(prompt, new RegExp(`^Look at Pod ${ns}/asked in context ${CONTEXT}`));
    await app.shot("dialog-about-the-pod");
    await (await app.find(byTestId("ask-ai-start"))).click();

    const term = terminal(app);
    await term.waitFor("Type done to exit", { timeout: 60_000 });
    assert.deepEqual(
      (await dockTabs(app)).map((t) => t.title),
      ["AI: asked"],
    );
    const [rec] = records(record);
    assert.ok(rec, "the fake CLI recorded its start");
    assert.ok(rec.isatty, "the CLI runs on the terminal");
    // The prompt is one argument, after `--`, never split or run by a shell.
    const dash = rec.args.indexOf("--");
    assert.ok(dash >= 0, JSON.stringify(rec.args));
    assert.equal(rec.args.length, dash + 2, JSON.stringify(rec.args));
    assert.equal(rec.args[dash + 1], prompt);
    // The same kubeconfig as a local terminal: the per-terminal file first.
    assert.match(rec.kubeconfig, /nauvi-shell-\d+-\d+\.yaml/);
    assert.ok(rec.kubeconfig.startsWith(tmp), rec.kubeconfig);
    if (noCli) return;
    assert.match(rec.config_path, new RegExp(`^${tmp}/nauvi-shell-\\d+-\\d+\\.json$`));
    assert.equal(rec.config_mode, "0o600");
    const server = rec.config.mcpServers.nauvi;
    assert.deepEqual([server.args[0], server.args[1]], [`--context=${CONTEXT}`, "mcp"]);
    assert.match(server.args[2] ?? "", /^--mode-file=\//, server.args.join(" "));
    assert.equal(server.args.length, 3, "read-only: no --allow-writes");
    assert.equal(server.env.KUBECONFIG, rec.kubeconfig);
    // No credentials on any command line: only paths and the context name.
    assert.ok(!JSON.stringify(rec.args).includes("token"), JSON.stringify(rec.args));
  });

  it("the CLI reaches the nauvi tools for that context, read-only", { ...T, skip: noCli || noPython }, async () => {
    const [rec] = records(record);
    assert.equal(rec.mcp_error, undefined, rec.mcp_error);
    assert.ok(rec.tools.includes("list") && rec.tools.includes("describe"), rec.tools.join(","));
    assert.ok(!rec.tools.includes("scale") && !rec.tools.includes("delete"), rec.tools.join(","));
    assert.match(rec.pods, /asked/);
    assert.match(rec.scale, /writes|allow-writes|not offered|read-only/i);
  });

  it("when the CLI exits, the tab is the user's shell at the same context", T, async () => {
    const { app } = s;
    const term = terminal(app);
    await term.type("done");
    await term.waitFor("This is your shell", { timeout: 30_000 });
    await term.waitForPrompt();
    assert.equal(await term.run("kubectl config current-context"), CONTEXT);
    assert.equal(await term.run("kubectl config view --minify -o jsonpath='{..namespace}'"), ns);
  });

  it("closing the tab deletes its MCP config and kubeconfig; the CLI's own config is untouched", T, async () => {
    const { app } = s;
    const [rec] = records(record);
    await closeTab(app, "AI: asked");
    // The session's files go one after the other when it is dropped.
    await app.waitFor(async () => readdirSync(tmp).every((f) => !f.startsWith("nauvi-shell-")), {
      message: "the tab's temp files to go",
    });
    assert.ok(!existsSync(rec.kubeconfig.split(":")[0]), "the temp kubeconfig was deleted");
    if (rec.config_path) assert.ok(!existsSync(rec.config_path), "the MCP config was deleted");
    assert.deepEqual(
      readdirSync(tmp).filter((f) => f.startsWith("nauvi-shell-")),
      [],
    );
    const home = app.profile.home;
    for (const f of [".claude.json", ".claude", ".codex", ".gemini"]) {
      assert.ok(!existsSync(join(home, f)), `${f} in HOME`);
    }
  });

  it("writes are passed only when ticked", { ...T, skip: noCli }, async () => {
    const { app } = s;
    await app.palette("ask ai", "Ask AI");
    await waitDialog(app);
    await (await app.find(byTestId("ask-ai-writes"))).click();
    await app.find(byTestId("ask-ai-writes-warning"));
    await (await app.find(byTestId("ask-ai-start"))).click();
    const term = terminal(app);
    await term.waitFor("Type done to exit", { timeout: 60_000 });
    await term.waitFor("nauvi tools that can change the cluster");
    const recs = records(record);
    const last = recs[recs.length - 1];
    const args = last.config.mcpServers.nauvi.args;
    assert.deepEqual([args[0], args[1], args[args.length - 1]], [`--context=${CONTEXT}`, "mcp", "--allow-writes"]);
    assert.match(args[2], /^--mode-file=\//, args.join(" "));
    assert.ok(last.tools.includes("scale"), last.tools.join(","));
    // On a normal context the write goes through: nauvi mcp finds the
    // context's mode from the file the app knows it from.
    assert.equal(last.scale_error, false, last.scale);
    assert.equal(kubectl(["-n", ns, "get", "deploy", "scaled", "-o", "jsonpath={.spec.replicas}"]).trim(), "2");
    await term.type("done");
    await term.waitFor("This is your shell", { timeout: 30_000 });
    await app.shot("after-the-cli-exited");
    const tab = (await dockTabs(app)).find((t) => t.title.startsWith("AI: "));
    await closeTab(app, tab.title);
  });

  it("turning the context read-only closes the Ask AI terminal, and Ask AI then opens none", T, async () => {
    const { app } = s;
    await app.palette("ask ai", "Ask AI");
    await waitDialog(app);
    await (await app.find(byTestId("ask-ai-start"))).click();
    const term = terminal(app);
    await term.waitFor("Type done to exit", { timeout: 60_000 });

    await setMode(app, "Read-only");
    await closeClusterSettings(app);
    await term.waitFor("is now read-only: this terminal was closed", { timeout: 30_000 });
    await app.shot("closed-on-read-only");

    await app.palette("ask ai", "Ask AI");
    await waitDialog(app);
    assert.match(await dialogText(app), /read-only, so nauvi opens no terminals/);
    assert.equal((await app.driver.findElements(byTestId("ask-ai-start"))).length, 0);
    await app.shot("blocked-on-read-only");
    await closeDialog(app);

    await setMode(app, "Normal");
    await closeClusterSettings(app);
    const tab = (await dockTabs(app)).find((t) => t.title.startsWith("AI: "));
    if (tab) await closeTab(app, tab.title);
  });
});

/** Pick a mode on this cluster's settings page (as context-mode.test.mjs). */
async function setMode(app, label) {
  if ((await app.driver.findElements(byTestId("cluster-settings"))).length === 0) {
    await app.palette("cluster settings", "Cluster settings");
  }
  const dialog = await app.find(byTestId("cluster-settings"));
  const radio = await dialog.findElement(
    By.xpath(`.//label[contains(@class,'mode-choice')][.//strong[normalize-space()=${xq(label)}]]/input`),
  );
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", radio);
  await radio.click();
  await app.waitFor(async () => radio.isSelected(), { message: `${label} selected` });
}

async function closeClusterSettings(app) {
  if ((await app.driver.findElements(byTestId("cluster-settings"))).length === 0) return;
  const dialog = await app.find(byTestId("cluster-settings"));
  await (await dialog.findElement(By.xpath(".//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("cluster-settings"))).length === 0, {
    message: "the cluster settings to close",
  });
}

describe("Ask AI without an AI CLI on PATH", { timeout: 10 * 60_000 }, () => {
  const profile = createProfile();
  const s = appSession("ask-ai-none", () => ({ profile, env: { PATH: pathWithoutAiClis([profile.bin]) } }));
  after(() => profile.remove());

  it("no header button; the palette entry says what to install", T, async () => {
    const { app } = s;
    await waitLive(app);
    assert.equal((await app.driver.findElements(byTestId("ask-ai-header"))).length, 0);
    await app.palette("ask ai", "Ask AI");
    await waitDialog(app);
    const text = await dialogText(app);
    assert.match(text, /No AI CLI was found on PATH/);
    assert.match(text, /nauvi installs nothing/);
    assert.match(text, /npm install -g @anthropic-ai\/claude-code/);
  });

  it("the help link opens the README's MCP section", T, async () => {
    const { app } = s;
    await (await app.find(By.xpath("//*[@data-testid='ask-ai-dialog']//button[normalize-space()='AI assistants and nauvi mcp']"))).click();
    await app.waitFor(async () => app.profile.opened().some((u) => u.includes("#use-nauvi-from-an-ai-assistant-mcp")), {
      message: "the README link",
    });
  });
});

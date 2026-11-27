// Ask AI (#376, #466): the user's AI CLI in a dock terminal, with the nauvi
// agent skill and no MCP server.
//
// A fake `claude` on PATH records what it was started with (its arguments,
// KUBECONFIG, any MCP config it was given, the skill in its HOME and that
// file's mode), then does what the skill says first for "what is wrong":
// it runs `nauvi problems -n <ns>` in its terminal. Then it waits for "done"
// and exits, and the tab must be the user's shell. The real `nauvi` CLI
// (target/debug/nauvi; CI builds it) is on PATH; without it those checks are
// skipped. Settings, AI shows the skill (not installed, installed) and
// removes it; a skill from another version is updated in place.
// It runs in its own folder in the app's data folder, never HOME (#532: on
// macOS a CLI scanning HOME makes macOS ask for nauvi to access Photos),
// unless the cluster's settings set a working directory.
// #548: the fake CLI also prints the `nauvi link` of a pod (plain and as an
// OSC 8 link) and runs `nauvi show` (at start, and for "show <target>"
// typed in its terminal). A click on the link opens the pod in the same
// window; the same link in a pod shell does nothing. With "Let Ask AI open
// views" off `nauvi show` prints the link; on, it opens the view with
// "Opened by Ask AI", Back returns, a second view within 3 s is dropped,
// and a wrong, missing or closed session's token opens nothing.
//
// Helpers: `terminal`, `closeTab`, `setTheme`.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId, CONTEXT, REPO, xq } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { closeTab, dockTabs, panelButton } from "../lib/dock.mjs";
import { setTheme } from "../lib/panels.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { cannotLaunchTwice, startBus } from "../lib/second-launch.mjs";
import { terminal } from "../lib/terminal.mjs";

const T = { timeout: 180_000 };
const target = process.env.CARGO_TARGET_DIR || join(REPO, "target");
const CLI = process.env.NAUVI_CLI || join(target, "debug", "nauvi");
const noCli = existsSync(CLI) ? false : `no nauvi CLI at ${CLI} (cargo build -p nauvi)`;
const noBus = cannotLaunchTwice();
const noPython = existsSync("/usr/bin/python3") ? false : "no /usr/bin/python3 for the fake AI CLI";
const AI_NAMES = ["claude", "codex", "gemini"];
// A pod that keeps failing, for `nauvi problems` to find.
const BROKEN = `apiVersion: v1
kind: Pod
metadata:
  name: broken
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: main
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "echo boom; exit 3"]
`;

// The fake AI CLI. It records, runs `nauvi problems` as the skill says,
// prints a summary, then waits for "done" on its terminal.
const FAKE_CLAUDE = String.raw`#!/usr/bin/python3
import json, os, subprocess, sys
args = sys.argv[1:]
home = os.environ.get("HOME", "")
skill = os.path.join(home, ".claude", "skills", "nauvi", "SKILL.md")
rec = {
    "args": args,
    "kubeconfig": os.environ.get("KUBECONFIG", ""),
    "cwd": os.getcwd(),
    "isatty": sys.stdin.isatty(),
    "mcp_flags": [a for a in args if "mcp" in a.lower()],
    "mcp_env": sorted(k for k in os.environ if k in ("NAUVI_MCP_CONFIG", "GEMINI_CLI_SYSTEM_DEFAULTS_PATH")),
    "skill_exists": os.path.isfile(skill),
    "ask_ai_env": os.environ.get("NAUVI_ASK_AI", ""),
}
if rec["skill_exists"]:
    rec["skill_mode"] = oct(os.stat(skill).st_mode & 0o777)
    rec["skill_dir_mode"] = oct(os.stat(os.path.dirname(skill)).st_mode & 0o777)
    with open(skill) as f:
        rec["skill"] = f.read()
ns = os.environ.get("ASK_AI_NS", "")
try:
    p = subprocess.run(["nauvi", "problems", "-n", ns], capture_output=True, text=True, timeout=60)
    rec["problems"] = p.stdout
    rec["problems_err"] = p.stderr[-400:]
    rec["problems_code"] = p.returncode
except Exception as e:
    rec["problems_error"] = repr(e)
# #548: what nauvi show needs, and the link the skill says to print.
rec["show_token"] = os.environ.get("NAUVI_ASK_AI_SESSION", "")
rec["show_app"] = os.environ.get("NAUVI_APP", "")
rec["link_context"] = os.environ.get("NAUVI_LINK_CONTEXT", "")
def nauvi(*a):
    p = subprocess.run(["nauvi", *a], capture_output=True, text=True, timeout=60)
    return p.stdout, p.stderr[-400:], p.returncode
try:
    rec["link"], rec["link_err"], rec["link_code"] = nauvi("link", "pod/broken", "-n", ns)
    rec["link"] = rec["link"].strip()
    rec["show_first"], _, _ = nauvi("show", "pod/broken", "-n", ns)
except Exception as e:
    rec["link_error"] = repr(e)
with open(os.environ["ASK_AI_RECORD"], "a") as f:
    f.write(json.dumps(rec) + "\n")
print("FAKE-AI started with %d arguments" % len(args))
print("skill: " + ("found" if rec["skill_exists"] else "missing"))
for line in rec.get("problems", "").splitlines()[:6]:
    print("| " + line[:110])
print("Type done to exit")
for line in sys.stdin:
    cmd = line.strip()
    if cmd == "done":
        break
    # "links": the answer the skill asks for, a pod and its link.
    if cmd == "links" and rec.get("link"):
        print("Pod %s/broken keeps failing:" % ns)
        print(rec["link"])
        print("\x1b]8;;%s\x07OSC-BROKEN\x1b]8;;\x07" % rec["link"])
    # "show pod/x": what the skill does when the user asks to see something.
    if cmd.startswith("show "):
        out, err, _ = nauvi("show", *cmd.split()[1:], "-n", ns)
        for l in (out + err).splitlines():
            print("SHOW| " + l[:150])
        print("SHOW-DONE")
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

async function openAiSettings(app) {
  await app.js("document.activeElement?.blur()");
  await app.driver.actions().keyDown(Key.CONTROL).sendKeys(",").keyUp(Key.CONTROL).perform();
  await app.find(byTestId("settings"));
  await app.find(byTestId("ask-ai-skills"));
  await app.js(`document.querySelector('[data-testid="ask-ai-settings"]').scrollIntoView({ block: "center" })`);
  await new Promise((r) => setTimeout(r, 300));
}

async function closeSettings(app) {
  await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("settings"))).length === 0, {
    message: "the settings to close",
  });
}

const skillState = (app, id) =>
  app.js(`return document.querySelector('[data-testid="ask-ai-skill-${id}"]')?.dataset.state ?? ""`);
const skillRowText = (app, id) =>
  app.js(`return document.querySelector('[data-testid="ask-ai-skill-${id}"]')?.innerText ?? ""`);

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
    ns = tempNamespace("qa-ask-ai", `${httpPodYaml("asked")}\n---\n${BROKEN}`);
    waitPodReady(ns, "asked");
  });
  // Our own profile: PATH is set here, and must keep its xdg-open recorder.
  const profile = createProfile();
  const skillDir = join(profile.home, ".claude", "skills", "nauvi");
  const skillFile = join(skillDir, "SKILL.md");
  const askAiDir = join(profile.home, ".local", "share", "com.nauvi.app", "ask-ai");
  // A private session bus, so `nauvi show` reaches this app through the
  // single-instance hand-over (as single-instance.test.mjs).
  let bus = null;
  const s = appSession("ask-ai", async () => {
    if (!noBus) bus = await startBus();
    return {
      profile,
      env: {
        PATH: pathWithoutAiClis([profile.bin, bin]),
        TMPDIR: tmp,
        ASK_AI_RECORD: record,
        ASK_AI_NS: ns,
        CLAUDE_CONFIG_DIR: "",
        ...(bus ? { DBUS_SESSION_BUS_ADDRESS: bus.address } : {}),
      },
    };
  });
  after(() => {
    bus?.stop();
    profile.remove();
    deleteNamespace(ns);
    rmSync(work, { recursive: true, force: true });
  });

  it("Settings, AI before the first Ask AI: the skill is not installed (light and dark)", T, async () => {
    const { app } = s;
    await waitLive(app);
    await setTheme(app, "light");
    await openAiSettings(app);
    assert.equal(await skillState(app, "claude"), "missing");
    const row = await skillRowText(app, "claude");
    assert.match(row, /Claude Code/);
    assert.ok(row.includes(skillDir), row);
    assert.match(row, /Not installed: Ask AI installs it/);
    assert.match(await skillRowText(app, "agents"), /Codex and Gemini CLI/);
    await app.shot("settings-skill-not-installed-light");
    await setTheme(app, "dark");
    await app.shot("settings-skill-not-installed-dark");
    await closeSettings(app);
    assert.ok(!existsSync(skillDir), "opening Settings writes nothing");
  });

  it("the dialog says starting installs the skill; no writes checkbox, no MCP (light and dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await (await app.find(byTestId("ask-ai-header"))).click();
    await waitDialog(app);
    const text = await dialogText(app);
    assert.match(text, new RegExp(`Ask AI about the cluster\\s+on\\s+${CONTEXT}`));
    assert.match(text, /Claude Code/);
    assert.ok(text.includes(`Starting installs the nauvi skill for Claude Code in ${skillDir}`), text);
    assert.match(text, /no MCP server/);
    assert.match(text, /the skill is not read-only/);
    if (noCli) assert.match(text, /nauvi CLI is not on PATH/);
    assert.equal((await app.driver.findElements(By.css('[data-testid="ask-ai-dialog"] input[type="checkbox"]'))).length, 0);
    await app.shot("dialog-skill-not-installed-light");
    await setTheme(app, "dark");
    await app.shot("dialog-skill-not-installed-dark");
    await setTheme(app, "light");
  });

  it("Ask AI about a pod writes the skill and starts the fake claude without MCP", T, async () => {
    const { app } = s;
    await closeDialog(app);
    await app.openDetail("Pods", ns, "asked");
    await (await app.find(By.css('[data-testid="detail-panel"] [role="toolbar"] button[data-action="askAi"]'))).click();
    await waitDialog(app);
    const prompt = await app.js(`return document.querySelector('[data-testid="ask-ai-prompt"]').value`);
    assert.match(prompt, new RegExp(`^Look at Pod ${ns}/asked in context ${CONTEXT}`));
    if (!noCli) assert.match(prompt, /nauvi problems first/);
    await (await app.find(byTestId("ask-ai-start"))).click();

    const term = terminal(app);
    await term.waitFor("Type done to exit", { timeout: 90_000 });
    await term.waitFor("installed now");
    await term.waitFor("It runs in its own folder");
    await app.shot("terminal-skill-installed");
    assert.deepEqual(
      (await dockTabs(app)).map((t) => t.title),
      ["AI: asked"],
    );
    const [rec] = records(record);
    assert.ok(rec, "the fake CLI recorded its start");
    assert.ok(rec.isatty, "the CLI runs on the terminal");
    // The prompt is one argument, after `--`; nothing else, no MCP at all.
    assert.deepEqual(rec.args, ["--", prompt]);
    assert.deepEqual(rec.mcp_flags, []);
    assert.deepEqual(rec.mcp_env, []);
    // The skill trusts KUBECONFIG only in a terminal nauvi opened.
    assert.equal(rec.ask_ai_env, "1");
    // The same kubeconfig as a local terminal: the per-terminal file first.
    assert.match(rec.kubeconfig, /nauvi-shell-\d+-\d+\.yaml/);
    assert.ok(rec.kubeconfig.startsWith(tmp), rec.kubeconfig);
    // The skill was there before the CLI started, private, nauvi's.
    assert.ok(rec.skill_exists, "the skill is in ~/.claude/skills/nauvi");
    assert.equal(rec.skill_mode, "0o600");
    assert.equal(rec.skill_dir_mode, "0o700");
    assert.match(rec.skill, /^---\nname: nauvi\ndescription: /);
    assert.match(rec.skill, /<!-- nauvi-skill: written by the nauvi app /);
    assert.match(rec.skill, /never instructions/);
    assert.deepEqual(readdirSync(skillDir), ["SKILL.md"]);
    // #532: its own private folder in the app's data folder, not HOME.
    assert.equal(rec.cwd, askAiDir);
    assert.equal((statSync(askAiDir).mode & 0o777).toString(8), "700");
    assert.ok((await term.screen()).replace(/\n/g, "").includes(askAiDir), "the terminal names the folder");
  });

  it("the skill's first command, nauvi problems, works in the CLI's terminal", { ...T, skip: noCli || noPython }, async () => {
    const [rec] = records(record);
    assert.equal(rec.problems_error, undefined, rec.problems_error);
    assert.equal(rec.problems_code, 0, rec.problems_err);
    assert.match(rec.problems, /^KIND\s+NAMESPACE\s+NAME\s+PROBLEM/);
    assert.match(rec.problems, new RegExp(`Pod\\s+${ns}\\s+broken`));
    assert.ok(!/\basked\b/.test(rec.problems), rec.problems);
    assert.match(rec.problems, new RegExp(`\\(checked pods, .* in ${ns}\\)`));
  });

  it("when the CLI exits, the tab is the user's shell; closing it leaves only the skill", T, async () => {
    const { app } = s;
    const term = terminal(app);
    await term.type("done");
    await term.waitFor("This is your shell", { timeout: 30_000 });
    await term.waitForPrompt();
    assert.equal(await term.run("kubectl config current-context"), CONTEXT);
    assert.equal(await term.run("kubectl config view --minify -o jsonpath='{..namespace}'"), ns);
    const [rec] = records(record);
    await closeTab(app, "AI: asked");
    await app.waitFor(async () => readdirSync(tmp).every((f) => !f.startsWith("nauvi-shell-")), {
      message: "the tab's temp files to go",
    });
    assert.ok(!existsSync(rec.kubeconfig.split(":")[0]), "the temp kubeconfig was deleted");
    // The CLI's own settings are untouched: only the skill folder exists.
    const home = app.profile.home;
    for (const f of [".claude.json", ".codex", ".gemini", ".agents"]) {
      assert.ok(!existsSync(join(home, f)), `${f} in HOME`);
    }
    assert.deepEqual(readdirSync(join(home, ".claude")), ["skills"]);
    assert.ok(existsSync(skillFile), "the skill stays for the next session");
  });

  it("Settings, AI shows the skill installed (dark), and Remove deletes it", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await openAiSettings(app);
    assert.equal(await skillState(app, "claude"), "current");
    assert.match(await skillRowText(app, "claude"), /Installed/);
    await app.shot("settings-skill-installed-dark");
    await setTheme(app, "light");
    await app.shot("settings-skill-installed-light");
    await (await app.find(By.css('[data-testid="ask-ai-skill-claude"] button'))).click();
    await app.waitFor(async () => (await skillState(app, "claude")) === "missing", { message: "the skill removed" });
    assert.ok(!existsSync(skillDir), "the skill folder is gone");
    assert.ok(existsSync(join(app.profile.home, ".claude", "skills")), "the skills folder stays");
    await app.shot("settings-skill-removed");
    await closeSettings(app);
  });

  it("a skill from another version is updated in place, never duplicated", T, async () => {
    const { app } = s;
    // Written again by the next Ask AI, then made to look older.
    await app.palette("ask ai", "Ask AI");
    await waitDialog(app);
    await (await app.find(byTestId("ask-ai-start"))).click();
    const term = terminal(app);
    await term.waitFor("Type done to exit", { timeout: 90_000 });
    await term.type("done");
    await term.waitFor("This is your shell", { timeout: 30_000 });
    const current = readFileSync(skillFile, "utf8");
    writeFileSync(skillFile, current.replace(/written by the nauvi app [^.\s]+(\.[0-9]+)*/, "written by the nauvi app 0.0.1"));
    assert.notEqual(readFileSync(skillFile, "utf8"), current);

    await app.palette("ask ai", "Ask AI");
    await waitDialog(app);
    assert.match(await dialogText(app), /Starting updates the nauvi skill in .* to this version of nauvi/s);
    await app.shot("dialog-skill-outdated");
    await (await app.find(byTestId("ask-ai-start"))).click();
    await terminal(app).waitFor("updated in", { timeout: 60_000 });
    await app.waitFor(async () => readFileSync(skillFile, "utf8") === current, { message: "the skill updated" });
    assert.deepEqual(readdirSync(skillDir), ["SKILL.md"]);
    assert.equal((statSync(skillFile).mode & 0o777).toString(8), "600");
    for (const tab of await dockTabs(app)) if (tab.title.startsWith("AI: ")) await closeTab(app, tab.title);
  });

  it("with a working directory set for the cluster, Ask AI runs there (#532)", T, async () => {
    const { app } = s;
    const dir = join(work, "project");
    mkdirSync(dir);
    const setCwd = async (value) => {
      await app.palette("cluster settings", "Cluster settings");
      const dialog = await app.find(byTestId("cluster-settings"));
      await app.setValue(await dialog.findElement(By.css('input[aria-label="Working directory"]')), value);
      await app.waitFor(
        () => {
          const cwds = Object.values(app.profile.settings()?.contexts ?? {}).map((c) => c.shell_cwd ?? "");
          return value ? cwds.includes(value) : cwds.every((c) => !c);
        },
        { message: `the working directory "${value}" saved` },
      );
      await closeClusterSettings(app);
    };
    await setCwd(dir);
    const before = records(record).length;
    await app.palette("ask ai", "Ask AI");
    await waitDialog(app);
    await (await app.find(byTestId("ask-ai-start"))).click();
    const term = terminal(app);
    await term.waitFor("the working directory set for this cluster", { timeout: 60_000 });
    await term.waitFor("Type done to exit", { timeout: 60_000 });
    await app.waitFor(() => records(record).length > before, { message: "the fake CLI recorded its start" });
    assert.equal(records(record).at(-1).cwd, dir);
    await app.shot("terminal-cluster-working-directory");
    await term.type("done");
    await term.waitFor("This is your shell", { timeout: 30_000 });
    for (const tab of await dockTabs(app)) if (tab.title.startsWith("AI: ")) await closeTab(app, tab.title);
    await setCwd("");
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

  // #548: links the AI prints, and `nauvi show`.
  const brokenLink = () => `nauvi://${CONTEXT}/core/v1/Pod/${ns}/broken`;

  it("the AI's nauvi:// links open the pod in this window (light and dark)", { ...T, skip: noCli || noPython }, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await app.openDetail("Pods", ns, "asked");
    const before = records(record).length;
    await app.palette("ask ai", "Ask AI");
    await waitDialog(app);
    await (await app.find(byTestId("ask-ai-start"))).click();
    const term = terminal(app);
    await term.waitFor("Type done to exit", { timeout: 90_000 });
    await app.waitFor(() => records(record).length > before, { message: "the fake CLI recorded its start" });
    const rec = records(record).at(-1);
    // `nauvi link` prints what Copy link copies, for this context's catalog id.
    assert.equal(rec.link_code, 0, rec.link_err);
    assert.equal(rec.link, brokenLink());
    assert.equal(rec.link_context, CONTEXT);
    await term.type("links");
    await term.waitFor("OSC-BROKEN");
    // The setting is off: no token, and `nauvi show` gives the link instead.
    assert.equal(rec.show_token, "");
    assert.match(rec.show_first, /Let Ask AI open views/);
    assert.ok(rec.show_first.includes(brokenLink()), rec.show_first);
    assert.match(await panelText(app), /\basked\b/, "nauvi show opened nothing");
    await app.shot("links-printed");

    await clickText(app, brokenLink());
    assert.equal(await screenTitle(app), `Open Pod ${ns}/broken (${CONTEXT}) in nauvi`);
    await app.waitFor(async () => /\bbroken\b/.test(await panelText(app)), { message: "the clicked link's pod in the panel" });
    assert.equal((await app.driver.findElements(byTestId("opened-by-ai"))).length, 0, "a click is the user's, not Ask AI's");
    await app.shot("link-opened-light");
    await setTheme(app, "dark");
    await app.shot("link-opened-dark");
    await setTheme(app, "light");

    // The OSC 8 link too.
    await app.openDetail("Pods", ns, "asked");
    await clickText(app, "OSC-BROKEN");
    await app.waitFor(async () => /\bbroken\b/.test(await panelText(app)), { message: "the OSC 8 link's pod in the panel" });
    await term.type("done");
    await term.waitFor("This is your shell", { timeout: 30_000 });
  });

  it("the same links printed in a pod shell do nothing", { ...T, skip: noCli || noPython }, async () => {
    const { app } = s;
    for (const tab of await dockTabs(app)) if (tab.title.startsWith("AI: ")) await closeTab(app, tab.title);
    await app.openDetail("Pods", ns, "asked");
    await panelButton(app, "Shell");
    const term = terminal(app);
    await term.waitForPrompt();
    await term.type("clear");
    await term.type(`printf '%s\\n' '${brokenLink()}'`);
    await term.type(`printf '\\033]8;;${brokenLink()}\\007OSC-SHELL\\033]8;;\\007\\n'`);
    await term.waitFor(/^OSC-SHELL$/m);
    await clickText(app, brokenLink());
    await clickText(app, "OSC-SHELL");
    await new Promise((r) => setTimeout(r, 1500));
    assert.doesNotMatch(await screenTitle(app), /in nauvi/);
    assert.match(await panelText(app), /\basked\b/);
    assert.doesNotMatch(await panelText(app), /\bbroken\b/);
    await app.shot("pod-shell-link-ignored");
    for (const tab of await dockTabs(app)) await closeTab(app, tab.title);
  });

  it("with Let Ask AI open views on, nauvi show opens the pod; Back returns; one per 3 s (light and dark)", { ...T, skip: noCli || noPython || noBus }, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await openAiSettings(app);
    const box = await app.find(byTestId("ask-ai-open-views"));
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", box);
    assert.equal(await box.isSelected(), false, "off by default");
    await app.shot("settings-open-views-off");
    await box.click();
    await app.waitFor(() => app.profile.settings()?.ask_ai_open_views === true, { message: "the setting saved" });
    await closeSettings(app);

    await app.nav("Deployments");
    const before = records(record).length;
    await app.palette("ask ai", "Ask AI");
    await waitDialog(app);
    await (await app.find(byTestId("ask-ai-start"))).click();
    const term = terminal(app);
    await term.waitFor("Type done to exit", { timeout: 90_000 });
    await app.waitFor(() => records(record).length > before, { message: "the fake CLI recorded its start" });
    const rec = records(record).at(-1);
    assert.match(rec.show_token, /^[0-9a-f]{64}$/, "a token for this session");
    assert.ok(existsSync(rec.show_app), rec.show_app);
    // Its first `nauvi show` (at start) opened the broken pod.
    await app.waitFor(async () => /\bbroken\b/.test(await panelText(app)), { timeout: 30_000, message: "nauvi show's pod" });
    await app.find(byTestId("opened-by-ai"));
    assert.match(rec.show_first, /Asked the nauvi app to show Pod .*\/broken/);
    await app.shot("show-opened-light");
    await setTheme(app, "dark");
    await app.shot("show-opened-dark");
    await setTheme(app, "light");

    // Again within 3 s: dropped, with a line in the terminal.
    await new Promise((r) => setTimeout(r, 3200));
    await term.type("show pod/asked");
    await term.waitFor("SHOW| Asked the nauvi app to show Pod", { timeout: 30_000 });
    await term.type("show pod/broken");
    await term.waitFor("asked again within 3 seconds", { timeout: 30_000 });
    await app.waitFor(async () => /\basked\b/.test(await panelText(app)), { message: "the second request's pod" });
    await app.shot("show-rate-limited");

    // Back returns to where the user was before Ask AI opened it.
    const back = await app.find(By.xpath("//*[@data-testid='opened-by-ai']//button[normalize-space()='Back']"));
    await back.click();
    await app.waitFor(async () => /\bbroken\b/.test(await panelText(app)), { message: "Back to the previous view" });

    // A kind's table.
    await new Promise((r) => setTimeout(r, 3200));
    await term.type("show pods");
    await app.waitFor(
      async () => (await app.js("return document.body.innerText")).includes(`Opened by Ask AI: the Pod table in ${ns}`),
      { timeout: 30_000, message: "the table notice" },
    );
    await app.shot("show-table");

    // From the user's shell after the CLI: a wrong token never opens anything.
    await term.type("done");
    await term.waitFor("This is your shell", { timeout: 30_000 });
    await term.waitForPrompt();
    await app.openDetail("Pods", ns, "asked");
    await new Promise((r) => setTimeout(r, 3200));
    const wrong = await term.run(`NAUVI_ASK_AI_SESSION=${"0".repeat(64)} nauvi show pod/broken -n ${ns}`, { timeout: 60_000 });
    assert.match(wrong, /Asked the nauvi app/);
    const none = await term.run(`env -u NAUVI_ASK_AI_SESSION nauvi show pod/broken -n ${ns}`, { timeout: 60_000 });
    assert.match(none, /opens views only from the Ask AI terminal/);
    await new Promise((r) => setTimeout(r, 2000));
    assert.doesNotMatch(await panelText(app), /\bbroken\b/, "no view from a wrong or missing token");

    // The session's token goes with its terminal.
    for (const tab of await dockTabs(app)) await closeTab(app, tab.title);
    await app.palette("local term", "New local terminal");
    const local = terminal(app);
    await local.waitForPrompt();
    await local.run(
      `NAUVI_ASK_AI_SESSION=${rec.show_token} NAUVI_APP='${rec.show_app}' nauvi show pod/broken -n ${ns}`,
      { timeout: 60_000 },
    );
    await new Promise((r) => setTimeout(r, 2000));
    assert.doesNotMatch(await panelText(app), /\bbroken\b/, "a closed session's token opens nothing");
    for (const tab of await dockTabs(app)) await closeTab(app, tab.title);
  });
});

const panelText = (app) => app.js(`return document.querySelector('[data-testid="detail-panel"]')?.innerText ?? ""`);

/** The tooltip of the visible terminal: where the hovered link goes. */
const screenTitle = (app) =>
  app.js(
    `const term = Array.from(document.querySelectorAll('[data-testid="terminal"]')).find((el) => el.offsetParent !== null);
     return term?.querySelector('.screen')?.title ?? "";`,
  );

/** Hover, then click `text` on the row that reads just `text` (as terminal-links.test.mjs). */
async function clickText(app, text) {
  const rect = await app.waitFor(
    () =>
      app.js(
        `const text = arguments[0];
         const term = Array.from(document.querySelectorAll('[data-testid="terminal"]')).find((el) => el.offsetParent !== null);
         const rows = Array.from(term?.querySelector('.xterm-rows')?.children ?? []);
         const row = rows.find((r) => r.textContent.replace(/\\u00a0/g, ' ').trim() === text);
         if (!row) return null;
         const r = row.getBoundingClientRect();
         const ch = r.width / Math.max(1, row.textContent.length);
         return [r.x, r.y, Math.min(r.width, ch * text.length), r.height];`,
        text,
      ),
    { message: `${text} on the terminal's screen` },
  );
  const [x, y, w, h] = rect;
  const cx = Math.round(x + Math.min(w / 2, 60));
  const cy = Math.round(y + h / 2);
  await app.driver
    .actions()
    .move({ origin: "viewport", x: cx - 3, y: cy })
    .pause(100)
    .move({ origin: "viewport", x: cx, y: cy })
    .pause(400)
    .click()
    .perform();
}

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
    await app.shot("no-cli");
  });

  it("the help link opens the docs' AI page", T, async () => {
    const { app } = s;
    await (await app.find(By.xpath("//*[@data-testid='ask-ai-dialog']//button[normalize-space()='AI assistants and nauvi']"))).click();
    await app.waitFor(async () => app.profile.opened().some((u) => /^https:\/\/nexburst\.github\.io\/nauvi\/docs\/[^/]+\/reference\/app\/ask-ai\.html$/.test(u)), {
      message: "the docs link (#468)",
    });
  });
});

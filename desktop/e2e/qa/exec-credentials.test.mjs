// Helpers: appSession, waitLive (lib/qa.mjs), setTheme (lib/panels.mjs),
// resizeWindow (lib/window.mjs), terminal (lib/terminal.mjs).
// Checks (#201): an added kubeconfig whose user logs in with an exec plugin
// (a stand-in script that counts its runs and prints a ServiceAccount token
// with an expirationTimestamp) is not run when it is added: the catalog
// shows the exact command and asks. "Don't run" leaves it not run and says
// so; Check asks again; "Allow and check" runs it once and connects.
// Opening the context in the window reuses that credential (still one run),
// and lists pods through it. A file swapped after Allow (#242): kubectl in a
// local shell still runs the allowed command (the shell gets a copy, never
// the file), and Check asks about the new one. Screenshots of the prompt
// (light, dark), of the refused and connected rows and of the swap at
// 1280x800.
// #243: a second plugin that fails, with a secret in its kubeconfig `env`
// and a token on stdout: the row shows its exit code and stderr, and
// neither secret appears in the page or the app log.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { ARTIFACTS, CONTEXT } from "../lib/app.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 120_000 };
const ID = "qa-exec-201";
const suffix = Date.now().toString(36);
const NS = `qa-exec-${suffix}`;
const BINDING = `qa-exec-201-${suffix}`;
const dir = mkdtempSync(join(tmpdir(), "kubeloupe-qa-exec-"));
const plugin = join(dir, "count-and-login.sh");
const runsFile = join(dir, "runs");
const swappedPlugin = join(dir, "swapped.sh");
const swappedRuns = join(dir, "swapped-runs");
const file = join(dir, "eks-like.yaml");

const kubectl = (args) => execFileSync("kubectl", ["--context", CONTEXT, ...args], { encoding: "utf8" });

// A ServiceAccount that can view the cluster, and a token for it.
kubectl(["create", "namespace", NS]);
kubectl(["-n", NS, "create", "serviceaccount", "counted"]);
kubectl(["create", "clusterrolebinding", BINDING, "--clusterrole=view", `--serviceaccount=${NS}:counted`]);
const token = kubectl(["-n", NS, "create", "token", "counted", "--duration=1h"]).trim();

// The stand-in plugin: one line in `runs` per run, then the credential.
const expires = new Date(Date.now() + 30 * 60_000).toISOString().replace(/\.\d+Z$/, "Z");
writeFileSync(
  plugin,
  `#!/bin/sh\necho run >> '${runsFile}'\n` +
    `printf '%s\\n' '{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"${token}","expirationTimestamp":"${expires}"}}'\n`,
);
chmodSync(plugin, 0o755);
const count = (path) => {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
  } catch {
    return 0;
  }
};
const runs = () => count(runsFile);
const swappedRunCount = () => count(swappedRuns);

// The test cluster (server and CA) with a user that logs in with the plugin.
const real = JSON.parse(kubectl(["config", "view", "--minify", "--flatten", "-o", "json"]));
const kubeconfig = {
  apiVersion: "v1",
  kind: "Config",
  clusters: [{ name: "c", cluster: real.clusters[0].cluster }],
  users: [
    {
      name: "plugin",
      user: {
        exec: {
          apiVersion: "client.authentication.k8s.io/v1",
          command: plugin,
          args: ["--cluster-name", "qa"],
          // Shown and part of what is allowed: it can change what runs.
          env: [{ name: "QA_PROFILE", value: "team a" }],
          interactiveMode: "Never",
        },
      },
    },
  ],
  contexts: [{ name: ID, context: { cluster: "c", user: "plugin" } }],
};
writeFileSync(file, JSON.stringify(kubeconfig, null, 2), { mode: 0o600 });
const COMMAND = `env QA_PROFILE='team a' ${plugin} --cluster-name qa`;
const SWAPPED_COMMAND = `env QA_PROFILE='team a' ${swappedPlugin} --cluster-name qa`;

// #243: a plugin that prints a token, then fails, with a secret env value.
const FAIL_ID = "qa-exec-243";
const SECRET = `s3cret-env-${suffix}`;
const STDOUT_SECRET = `s3cret-stdout-${suffix}`;
const failing = join(dir, "fail-login.sh");
const failFile = join(dir, "failing.yaml");
writeFileSync(
  failing,
  `#!/bin/sh\nprintf '%s\\n' '{"token":"${STDOUT_SECRET}"}'\n` +
    `echo 'Error: session expired. Run qa login' >&2\nexit 3\n`,
);
chmodSync(failing, 0o755);
const failingUser = {
  apiVersion: "client.authentication.k8s.io/v1",
  command: failing,
  env: [{ name: "QA_VAULT_TOKEN", value: SECRET }],
  interactiveMode: "Never",
};
writeFileSync(
  failFile,
  JSON.stringify({
    ...kubeconfig,
    users: [{ name: "failing", user: { exec: failingUser } }],
    contexts: [{ name: FAIL_ID, context: { cluster: "c", user: "failing" } }],
  }),
  { mode: 0o600 },
);

const row = (id) => `[data-testid="catalog-row"][data-context=${JSON.stringify(id)}]`;
const statusOf = (app, id) =>
  app.js(
    `return document.querySelector(arguments[0])?.querySelector('[data-testid="catalog-status"]')?.innerText.trim() ?? ""`,
    row(id),
  );
const click = (app, css) =>
  app.js(
    `const el = document.querySelector(arguments[0]); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true;`,
    css,
  );
const clickText = (app, scope, text) =>
  app.js(
    `const b = Array.from(document.querySelectorAll(arguments[0] + " button")).find((b) => b.textContent.trim() === arguments[1]);
     b?.click();
     return !!b;`,
    scope,
    text,
  );
const PROMPT = '[data-testid="exec-prompt"]';
const promptText = (app) => app.js(`return document.querySelector(arguments[0])?.innerText ?? ""`, PROMPT);

describe("exec credential plugins in the catalog", { timeout: 10 * 60_000 }, () => {
  const s = appSession("exec-credentials");
  after(() => {
    try {
      kubectl(["delete", "clusterrolebinding", BINDING, "--ignore-not-found"]);
      kubectl(["delete", "namespace", NS, "--wait=false", "--ignore-not-found"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("adding the kubeconfig shows its command and runs nothing", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    await click(app, 'button[aria-label="Cluster catalog"]');
    await app.find(By.css('[data-testid="catalog"]'));
    await app.waitFor(async () => (await statusOf(app, CONTEXT)) === "Connected", {
      timeout: 30_000,
      message: `${CONTEXT} connected`,
    });
    await app.waitFor(() => clickText(app, '[data-testid="catalog"]', "Add kubeconfig…"), {
      message: "the Add kubeconfig… button",
    });
    const input = await app.find(By.css('input[aria-label="Kubeconfig file or folder"]'));
    await app.setValue(input, file);
    await click(app, 'form[aria-label="Add kubeconfig"] button[type="submit"]');

    await app.find(By.css(PROMPT));
    const text = await promptText(app);
    console.log(`prompt: ${JSON.stringify(text)}`);
    const shown = await app.js(`return document.querySelector('[data-testid="exec-command"]').textContent`);
    assert.equal(shown, COMMAND, "the exact command line");
    assert.ok(text.includes(file), "names the source");
    assert.ok(text.includes(`Used by ${ID}`), "names the context");
    assert.equal(await statusOf(app, ID), "Check", "the new context waits with a Check button");
    assert.equal(runs(), 0, "the plugin did not run");
    const focused = await app.js(`return document.activeElement?.textContent.trim() ?? ""`);
    assert.equal(focused, "Don't run", "the safe answer has the focus");
    await setTheme(app, "light");
    await app.shot("exec-prompt-light");
    await setTheme(app, "dark");
    await app.shot("exec-prompt-dark");
    await setTheme(app, "light");
  });

  it("Don't run keeps it from running; the row says why", T, async () => {
    const { app } = s;
    assert.ok(await clickText(app, PROMPT, "Don't run"));
    await app.waitFor(async () => (await statusOf(app, ID)).startsWith("Not allowed"), {
      message: `${ID} not allowed`,
    });
    const status = await statusOf(app, ID);
    console.log(`refused: ${JSON.stringify(status)}`);
    assert.ok(status.includes("you chose not to run it"), status);
    assert.equal(runs(), 0, "still not run");
    await app.shot("exec-refused-light");
  });

  it("Check asks again; allowed, it runs once and connects", T, async () => {
    const { app } = s;
    await click(app, `${row(ID)} button[aria-label=${JSON.stringify(`Check ${ID}`)}]`);
    await app.find(By.css(PROMPT));
    assert.ok(await clickText(app, PROMPT, "Allow and check"));
    await app.waitFor(async () => (await statusOf(app, ID)) === "Connected", {
      timeout: 30_000,
      message: `${ID} connected`,
    });
    assert.equal(runs(), 1, "one plugin run for the check");
    await app.shot("exec-connected-light");
    await setTheme(app, "dark");
    await app.shot("exec-connected-dark");
    await setTheme(app, null);
  });

  it("opening the context reuses the credential and lists pods", T, async () => {
    const { app } = s;
    await click(app, `${row(ID)} button[aria-label=${JSON.stringify(`Open ${ID}`)}]`);
    await app.waitFor(
      async () => (await app.js(`return document.querySelector('select[aria-label="Cluster context"]').value`)) === ID,
      { message: `context select on ${ID}` },
    );
    await waitLive(app);
    await app.nav("Pods");
    await app.filter("web-");
    await app.waitFor(async () => (await app.rows()).some(([n, ns]) => ns === "demo" && n.startsWith("web-")), {
      timeout: 40_000,
      message: "demo/web pods through the plugin's token",
    });
    console.log(`plugin runs: ${runs()}`);
    assert.equal(runs(), 1, "check and connect share one plugin run");
    await app.shot("exec-pods-light");
  });

  it("a file swapped after Allow runs nothing new in a local shell or a Check (#242)", T, async () => {
    const { app } = s;
    await app.palette("local term", "New local terminal");
    const term = terminal(app);
    await term.waitFor(`kubectl uses context ${ID}`);
    await term.waitForPrompt();
    const before = runs();
    // Same context, another login command (it would work too).
    writeFileSync(swappedPlugin, `#!/bin/sh\necho run >> '${swappedRuns}'\nexec '${plugin}' "$@"\n`);
    chmodSync(swappedPlugin, 0o755);
    const swapped = structuredClone(kubeconfig);
    swapped.users[0].user.exec.command = swappedPlugin;
    writeFileSync(file, JSON.stringify(swapped, null, 2), { mode: 0o600 });

    const env = await term.run("echo $KUBECONFIG");
    console.log(`shell KUBECONFIG: ${env}`);
    assert.ok(!env.includes(file), "the shell never reads the added file");
    assert.match(await term.run("kubectl get ns demo -o name"), /^namespace\/demo$/);
    assert.equal(swappedRunCount(), 0, "kubectl did not run the swapped command");
    assert.ok(runs() > before, "kubectl ran the allowed command");
    await app.shot("exec-swapped-shell-light");

    // The catalog asks about the new command instead of running it.
    await click(app, 'button[aria-label="Cluster catalog"]');
    await app.find(By.css('[data-testid="catalog"]'));
    // Connected: Check is in the row's More menu.
    await click(app, `${row(ID)} button[aria-label=${JSON.stringify(`More actions for ${ID}`)}]`);
    await app.find(By.css('[role="menu"]'));
    assert.ok(await clickText(app, '[role="menu"]', "Check connection"));
    await app.find(By.css(PROMPT));
    const shown = await app.js(`return document.querySelector('[data-testid="exec-command"]').textContent`);
    assert.equal(shown, SWAPPED_COMMAND, "the swapped command is asked about");
    await app.shot("exec-swapped-prompt-light");
    assert.ok(await clickText(app, PROMPT, "Don't run"));
    await app.waitFor(async () => (await statusOf(app, ID)).startsWith("Not allowed"), {
      message: `${ID} not allowed after the swap`,
    });
    assert.equal(swappedRunCount(), 0, "the swapped command never ran");
    await app.shot("exec-swapped-refused-light");
  });

  it("the answer is kept across a restart", T, async () => {
    const { app } = s;
    await app.restart();
    await app.find(By.css("nav"));
    const saved = JSON.parse(readFileSync(join(app.profile.configDir, "exec-approvals.json"), "utf8"));
    console.log(`approvals: ${JSON.stringify(saved)}`);
    assert.deepEqual(saved.answers, [
      { source: file, command: COMMAND, allowed: true },
      { source: file, command: SWAPPED_COMMAND, allowed: false },
    ]);
  });

  it("a failing plugin shows its stderr, not its env or stdout", T, async () => {
    const { app } = s;
    // Not Live: after the restart the window reopens qa-exec-201, whose
    // swapped command was refused (#242).
    await app.find(By.css('button[aria-label="Cluster catalog"]'));
    await resizeWindow(app, 1280, 800);
    await click(app, 'button[aria-label="Cluster catalog"]');
    await app.find(By.css('[data-testid="catalog"]'));
    await app.waitFor(() => clickText(app, '[data-testid="catalog"]', "Add kubeconfig…"), {
      message: "the Add kubeconfig… button",
    });
    const input = await app.find(By.css('input[aria-label="Kubeconfig file or folder"]'));
    await app.setValue(input, failFile);
    await click(app, 'form[aria-label="Add kubeconfig"] button[type="submit"]');
    await app.find(By.css(PROMPT));
    assert.ok(await clickText(app, PROMPT, "Allow and check"));
    await app.waitFor(async () => (await statusOf(app, FAIL_ID)).includes("Run qa login"), {
      timeout: 30_000,
      message: `${FAIL_ID} shows the plugin's stderr`,
    });
    const status = await statusOf(app, FAIL_ID);
    console.log(`failed: ${JSON.stringify(status)}`);
    assert.ok(status.includes("exit code 3"), status);
    const page = await app.js("return document.body.innerText");
    assert.ok(!page.includes(SECRET), "no env value in the page");
    assert.ok(!page.includes(STDOUT_SECRET), "no plugin stdout in the page");
    await app.shot("exec-failed-light");
    await setTheme(app, "dark");
    await app.shot("exec-failed-dark");
    await setTheme(app, null);
    const log = readFileSync(join(ARTIFACTS, "exec-credentials-app.log"), "utf8");
    assert.ok(!log.includes(SECRET), "no env value in the app log");
    assert.ok(!log.includes(STDOUT_SECRET), "no plugin stdout in the app log");
  });
});

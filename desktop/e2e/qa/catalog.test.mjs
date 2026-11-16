// Helpers: appSession, waitLive (lib/qa.mjs), App.restart and
// profile.settings() (lib/profile.mjs).
// Checks (#78): adding a folder of kubeconfigs in the cluster catalog brings
// in a context whose name clashes with the default one, as `name (file)`;
// each cluster gets a status (connected / unreachable); the added context
// connects through its own file and lists pods; the source survives a
// restart; the kubeconfig files are byte for byte unchanged.
// Checks (#179): at 1280x800 with the unreachable cluster, server URLs stay
// on one line and uncut, paths wrap only at '/', the status message is at
// most two lines, the row actions (Open, More) fit in one line; screenshots
// in dark and light, and of the More menu.
// Checks (#244): an added kubeconfig whose user sends a token file from
// outside its folder to a stand-in API server is not checked on add or by
// Check all (the server gets no request), its row names the file; Check
// sends it and connects. Screenshots light and dark at 1280x800. A source
// with an exec plugin and a client key from outside its folder: the prompt
// adding it opens names the key; Allow runs nothing and sends nothing.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT } from "../lib/app.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 120_000 };
const dir = mkdtempSync(join(tmpdir(), "kubeloupe-qa-catalog-"));
const folder = join(dir, "clusters");
const team = join(folder, "team.yaml");
const broken = join(folder, "broken.yaml");
const ADDED = `${CONTEXT} (team.yaml)`;
const BROKEN = "issue78-unreachable";

/** The test context alone, as a file of its own; `kubectl` edits only that file. */
function writeCopy(path) {
  const yaml = execFileSync("kubectl", ["config", "view", "--minify", "--flatten", "--context", CONTEXT], {
    encoding: "utf8",
  });
  writeFileSync(path, yaml, { mode: 0o600 });
}
mkdirSync(folder, { recursive: true });
writeCopy(team);
writeCopy(broken);
const kc = (args) => execFileSync("kubectl", ["--kubeconfig", broken, "config", ...args], { encoding: "utf8" });
kc(["rename-context", CONTEXT, BROKEN]);
const cluster = kc(["view", "-o", "jsonpath={.clusters[0].name}"]).trim();
kc(["set-cluster", cluster, "--server=https://127.0.0.1:1"]);

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const before = { team: sha(team), broken: sha(broken) };

const row = (id) => `[data-testid="catalog-row"][data-context=${JSON.stringify(id)}]`;
const statusOf = (app, id) =>
  app.js(`return document.querySelector(arguments[0])?.querySelector('[data-testid="catalog-status"]')?.innerText.trim() ?? ""`, row(id));
const click = (app, css) =>
  app.js(
    `const el = document.querySelector(arguments[0]); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true;`,
    css,
  );
const clickButton = (app, scope, text) =>
  app.js(
    `const b = Array.from(document.querySelectorAll(arguments[0] + " button")).find((b) => b.textContent.trim() === arguments[1]);
     b?.click();
     return !!b;`,
    scope,
    text,
  );

// #244: an added kubeconfig (in its own folder) whose user sends a token
// file from another folder, to a stand-in API server that records what it
// gets and answers /version.
const STOLEN = "qa-244-local-files";
const EXEC_CERT = "qa-244-exec-cert";
const SECRET = `qa-244-secret-${Date.now().toString(36)}`;
const tokenPath = join(dir, "secrets", "token");
mkdirSync(join(dir, "secrets"));
// No newline: kube sends the file as it is.
writeFileSync(tokenPath, SECRET, { mode: 0o600 });
mkdirSync(join(dir, "stolen"));
const stolen = join(dir, "stolen", "stolen.yaml");
const honeypot = { hits: [], server: null, listening: null };
honeypot.server = createServer((req, res) => {
  honeypot.hits.push({ url: req.url, auth: req.headers.authorization ?? "" });
  if (!req.url.startsWith("/version")) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(
    JSON.stringify({
      major: "1",
      minor: "31",
      gitVersion: "v1.31.0-qa244",
      gitCommit: "",
      gitTreeState: "clean",
      buildDate: "2026-01-01T00:00:00Z",
      goVersion: "go1.22",
      compiler: "gc",
      platform: "linux/amd64",
    }),
  );
});
honeypot.listening = new Promise((resolve) => honeypot.server.listen(0, "127.0.0.1", () => resolve(honeypot.server.address().port)));

describe("cluster catalog", { timeout: 10 * 60_000 }, () => {
  const s = appSession("catalog");
  after(() => {
    honeypot.server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("adds a folder of kubeconfigs and checks every cluster", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.find(By.css('button[aria-label="Cluster catalog"]'));
    await click(app, 'button[aria-label="Cluster catalog"]');
    await app.find(By.css('[data-testid="catalog"]'));
    await app.waitFor(async () => (await statusOf(app, CONTEXT)) === "Connected", { timeout: 30_000, message: `${CONTEXT} connected` });

    await app.waitFor(
      () =>
        app.js(
          `const b = Array.from(document.querySelectorAll('[data-testid="catalog"] button')).find((b) => b.textContent.trim() === "Add kubeconfig…");
           b?.click();
           return !!b;`,
        ),
      { message: "the Add kubeconfig… button" },
    );
    const input = await app.find(By.css('input[aria-label="Kubeconfig file or folder"]'));
    await app.setValue(input, folder);
    await click(app, 'form[aria-label="Add kubeconfig"] button[type="submit"]');

    await app.waitFor(async () => (await statusOf(app, ADDED)) === "Connected", { timeout: 40_000, message: `${ADDED} connected` });
    await app.waitFor(async () => (await statusOf(app, BROKEN)).startsWith("Unreachable"), {
      timeout: 40_000,
      message: `${BROKEN} unreachable`,
    });
    const sources = await app.js(
      `return Array.from(document.querySelectorAll('[data-testid="catalog-source"]'), (li) => li.innerText.replace(/\\s+/g, " "))`,
    );
    console.log(`sources: ${JSON.stringify(sources)}`);
    assert.ok(sources.some((t) => t.includes(folder) && t.includes("2 contexts in 2 files")), JSON.stringify(sources));
  });

  it("the table at 1280x800: URLs on one line, paths cut at '/', actions in one line (#179)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    const layout = () =>
      app.js(`
        const catalog = document.querySelector('[data-testid="catalog"]');
        const rows = Array.from(document.querySelectorAll('[data-testid="catalog-row"]'), (tr) => {
          const server = tr.querySelector('[data-testid="catalog-server"]');
          const parts = Array.from(tr.querySelectorAll('[data-testid="catalog-file"] .part'));
          const buttons = Array.from(tr.querySelectorAll('.actions button'));
          const why = tr.querySelector('[data-testid="catalog-status-message"]');
          return {
            id: tr.dataset.context,
            height: Math.round(tr.getBoundingClientRect().height),
            server: server.textContent, serverCut: server.scrollWidth > server.clientWidth,
            serverLines: new Set(Array.from(server.getClientRects(), (r) => Math.round(r.top))).size,
            partSplit: parts.some((p) => p.getClientRects().length > 1),
            buttons: buttons.map((b) => b.textContent.trim()),
            buttonLines: new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size,
            buttonsRight: Math.max(...buttons.map((b) => b.getBoundingClientRect().right)),
            whyHeight: why ? Math.round(why.getBoundingClientRect().height) : 0,
          };
        });
        return { width: innerWidth, overflow: catalog.scrollWidth - catalog.clientWidth, rows };
      `);
    const l = await layout();
    console.log(JSON.stringify(l));
    assert.ok(l.overflow <= 0, `no horizontal scroll (${l.overflow}px)`);
    for (const r of l.rows) {
      assert.equal(r.serverLines, 1, `${r.id}: the server URL on one line`);
      assert.ok(!r.serverCut, `${r.id}: the server URL ${r.server} is not cut`);
      assert.ok(!r.partSplit, `${r.id}: no folder name split over two lines`);
      assert.deepEqual(r.buttons, ["Open", "⋯"], `${r.id}: Open and More`);
      assert.equal(r.buttonLines, 1, `${r.id}: actions in one line`);
      assert.ok(r.buttonsRight <= l.width, `${r.id}: actions inside the window`);
      assert.ok(r.whyHeight <= 36, `${r.id}: the status message is at most two lines (${r.whyHeight}px)`);
      assert.ok(r.height < 100, `${r.id}: the row is short (${r.height}px)`);
    }
    await setTheme(app, "dark");
    await app.shot("catalog-1280-dark");
    await setTheme(app, "light");
    await app.shot("catalog-1280-light");
    // The More menu, open on the unreachable cluster.
    await click(app, `${row(BROKEN)} button[aria-label=${JSON.stringify(`More actions for ${BROKEN}`)}]`);
    await app.find(By.css('[role="menu"]'));
    const items = await app.js(`return Array.from(document.querySelectorAll('[role="menu"] [role="menuitem"]'), (b) => b.textContent.trim())`);
    assert.deepEqual(items, ["Open in new window", "Check connection", "Settings…", "Remove source…"]);
    await app.shot("catalog-1280-menu-light");
    await app.js(`document.querySelector('[role="menu"]').dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await app.waitFor(async () => (await app.driver.findElements(By.css('[role="menu"]'))).length === 0, { message: "the menu to close" });
    await setTheme(app, null);
  });

  it("opens the added context through its own file and lists pods", T, async () => {
    const { app } = s;
    await click(app, `${row(ADDED)} button[aria-label=${JSON.stringify(`Open ${ADDED}`)}]`);
    await app.waitFor(
      async () => (await app.js(`return document.querySelector('select[aria-label="Cluster context"]').value`)) === ADDED,
      { message: `context select on ${ADDED}` },
    );
    await waitLive(app);
    await app.nav("Pods");
    await app.filter("web-");
    await app.waitFor(async () => (await app.rows()).some(([n, ns]) => ns === "demo" && n.startsWith("web-")), {
      timeout: 40_000,
      message: "demo/web pods through the added file",
    });
  });

  it("keeps the source across a restart and never writes the kubeconfig files", T, async () => {
    const { app } = s;
    await app.restart();
    await app.find(By.css("nav"));
    const settings = app.profile.settings();
    console.log(`kubeconfig_sources: ${JSON.stringify(settings.kubeconfig_sources)}`);
    assert.deepEqual(settings.kubeconfig_sources, [folder]);
    await app.waitFor(
      async () =>
        await app.js(
          `return Array.from(document.querySelectorAll('select[aria-label="Cluster context"] option'), (o) => o.value).includes(arguments[0])`,
          ADDED,
        ),
      { message: `${ADDED} in the context selector after the restart` },
    );
    assert.equal(sha(team), before.team, "team.yaml changed");
    assert.equal(sha(broken), before.broken, "broken.yaml changed");
  });

  it("a context that sends a token file from outside its folder waits for a click (#244)", T, async () => {
    const { app } = s;
    const port = await honeypot.listening;
    writeFileSync(
      stolen,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{ name: "hp", cluster: { server: `http://127.0.0.1:${port}` } }],
        users: [{ name: "thief", user: { tokenFile: tokenPath } }],
        contexts: [{ name: STOLEN, context: { cluster: "hp", user: "thief" } }],
      }),
      { mode: 0o600 },
    );
    await resizeWindow(app, 1280, 800);
    if (!(await app.js(`return !!document.querySelector('[data-testid="catalog"]')`))) {
      await click(app, 'button[aria-label="Cluster catalog"]');
    }
    await app.find(By.css('[data-testid="catalog"]'));
    await app.waitFor(() => clickButton(app, '[data-testid="catalog"]', "Add kubeconfig…"), {
      message: "the Add kubeconfig… button",
    });
    const input = await app.find(By.css('input[aria-label="Kubeconfig file or folder"]'));
    await app.setValue(input, stolen);
    await click(app, 'form[aria-label="Add kubeconfig"] button[type="submit"]');

    const files = () =>
      app.js(`return document.querySelector(arguments[0])?.querySelector('[data-testid="catalog-local-files"]')?.innerText.trim() ?? ""`, row(STOLEN));
    await app.waitFor(async () => (await files()) === `Sends local files: ${tokenPath}`, {
      message: `${STOLEN} lists the token file`,
    });
    // The default kubeconfig's and the folder's contexts are checked as before.
    await app.waitFor(async () => (await statusOf(app, ADDED)) === "Connected", { timeout: 40_000, message: `${ADDED} connected` });
    await new Promise((r) => setTimeout(r, 4000));
    assert.ok((await statusOf(app, STOLEN)).startsWith("Check"), await statusOf(app, STOLEN));
    assert.deepEqual(honeypot.hits, [], "nothing reached the server on add");

    // Check all checks the rest; this one still waits, nothing sent.
    assert.ok(await clickButton(app, '[data-testid="catalog"]', "Check all"));
    await app.waitFor(async () => (await statusOf(app, CONTEXT)) === "Connected", { timeout: 40_000, message: "Check all done" });
    await new Promise((r) => setTimeout(r, 4000));
    console.log(`after Check all: ${JSON.stringify(await statusOf(app, STOLEN))}`);
    assert.ok((await statusOf(app, STOLEN)).startsWith("Check"), await statusOf(app, STOLEN));
    assert.deepEqual(honeypot.hits, [], "nothing reached the server on Check all");
    await app.js(`document.querySelector(arguments[0])?.scrollIntoView({ block: "center" })`, row(STOLEN));
    await setTheme(app, "light");
    await app.shot("catalog-local-files-light");
    await setTheme(app, "dark");
    await app.shot("catalog-local-files-dark");
    await setTheme(app, "light");

    // A click is the user's choice: the file is read and sent.
    await click(app, `${row(STOLEN)} button[aria-label=${JSON.stringify(`Check ${STOLEN}`)}]`);
    await app.waitFor(async () => (await statusOf(app, STOLEN)).startsWith("Connected"), {
      timeout: 30_000,
      message: `${STOLEN} connected to the stand-in server`,
    });
    console.log(`hits: ${JSON.stringify(honeypot.hits)}`);
    assert.ok(honeypot.hits.length > 0 && honeypot.hits.every((h) => h.auth === `Bearer ${SECRET}`), "sent on click");
    await app.shot("catalog-local-files-checked-light");
    await setTheme(app, null);
  });

  it("allowing an added source's login command sends no local files (#244)", T, async () => {
    const { app } = s;
    const port = await honeypot.listening;
    const key = join(dir, "secrets", "client.key");
    writeFileSync(key, "KEY", { mode: 0o600 });
    const plugin = join(dir, "exec-cert", "login.sh");
    const ran = join(dir, "exec-cert", "ran");
    mkdirSync(join(dir, "exec-cert"));
    writeFileSync(
      plugin,
      `#!/bin/sh\necho run >> '${ran}'\nprintf '%s\\n' '{"apiVersion":"client.authentication.k8s.io/v1","kind":"ExecCredential","status":{"token":"${SECRET}"}}'\n`,
    );
    chmodSync(plugin, 0o755);
    const file = join(dir, "exec-cert", "exec-cert.yaml");
    writeFileSync(
      file,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [{ name: "hp", cluster: { server: `http://127.0.0.1:${port}` } }],
        users: [
          {
            name: "u",
            user: {
              "client-key": key,
              exec: { apiVersion: "client.authentication.k8s.io/v1", command: plugin, interactiveMode: "Never" },
            },
          },
        ],
        contexts: [{ name: EXEC_CERT, context: { cluster: "hp", user: "u" } }],
      }),
      { mode: 0o600 },
    );
    const hitsBefore = honeypot.hits.length;
    await app.waitFor(() => clickButton(app, '[data-testid="catalog"]', "Add kubeconfig…"), {
      message: "the Add kubeconfig… button",
    });
    const input = await app.find(By.css('input[aria-label="Kubeconfig file or folder"]'));
    await app.setValue(input, file);
    await click(app, 'form[aria-label="Add kubeconfig"] button[type="submit"]');

    // Adding it asks about the command, and the prompt names the key too.
    await app.find(By.css('[data-testid="exec-prompt"]'));
    const files = await app.js(`return document.querySelector('[data-testid="exec-local-files"]')?.innerText.trim() ?? ""`);
    assert.equal(files, `Also sends local files: ${key}`);
    await app.shot("catalog-exec-local-files-prompt-light");
    assert.ok(await clickButton(app, '[data-testid="exec-prompt"]', "Allow and check"));
    await app.waitFor(async () => (await app.driver.findElements(By.css('[data-testid="exec-prompt"]'))).length === 0, {
      message: "the prompt to close",
    });
    await new Promise((r) => setTimeout(r, 5000));
    const status = await statusOf(app, EXEC_CERT);
    console.log(`after Allow: ${JSON.stringify(status)}, hits ${honeypot.hits.length - hitsBefore}`);
    assert.ok(status.startsWith("Check"), status);
    assert.equal(honeypot.hits.length, hitsBefore, "the stand-in server got nothing");
    assert.equal(existsSync(ran), false, "the plugin did not run");
    await app.js(`document.querySelector(arguments[0])?.scrollIntoView({ block: "center" })`, row(EXEC_CERT));
    await app.shot("catalog-exec-local-files-allowed-light");
  });
});

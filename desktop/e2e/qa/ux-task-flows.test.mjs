// UX task flows (#486): the eight everyday tasks of someone moving from Lens,
// walked with the mouse the way a newcomer would (the panel's icons, the ⋮
// menu, the berths and the drawer; no shortcuts), at 1280x800, with a
// screenshot after each step. Each test adds its clicks and typed fields to
// `ux-task-flows-clicks.md` in the artifacts, the table of tasks x clicks
// that #486 asks for. Rerun it after a UX change and compare.
//
//   1. connect, then switch to a second context (catalog) and back (chip)
//   2. find a pod by name across namespaces
//   3. its logs: follow, search, the previous container
//   4. a shell in it
//   5. a Deployment: edit its YAML and save, scale, restart
//   6. port-forward a Service and open it
//   7. why a pod is failing (status line, container, events)
//   8. install and upgrade a Helm release (skipped without helm)
//
// The second context is an alias of the test context. Everything it changes
// lives in two temporary ux486-* namespaces; the chart repository is
// demo-chart served from 127.0.0.1 with the app's own helm homes.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { ARTIFACTS, CONTEXT, REPO, byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { aliasKubeconfig, dockPaneIds, logLines, pane, paneTerminal } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const STAGING = "staging-eu";
const CHART = `${REPO}/scripts/test-cluster/charts/demo-chart`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let noHelm = false;
try {
  execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
} catch {
  noHelm = "helm is not on PATH";
}

const SHOP = `
apiVersion: apps/v1
kind: Deployment
metadata: {name: checkout}
spec:
  replicas: 2
  selector: {matchLabels: {app: checkout}}
  template:
    metadata: {labels: {app: checkout}}
    spec:
      terminationGracePeriodSeconds: 0
      containers:
      - name: web
        image: busybox:1.36
        imagePullPolicy: IfNotPresent
        command: ["sh","-c","mkdir -p /www && echo hello-checkout > /www/index.html && i=0; while true; do echo \\"GET /cart 200 req=$i\\"; [ $((i%7)) = 0 ] && echo \\"ERROR payment timeout req=$i\\"; i=$((i+1)); sleep 1; done & exec httpd -f -p 8080 -h /www"]
        ports: [{containerPort: 8080, name: http}]
        readinessProbe: {tcpSocket: {port: 8080}, periodSeconds: 2}
---
apiVersion: v1
kind: Service
metadata: {name: checkout}
spec:
  selector: {app: checkout}
  ports: [{name: http, port: 80, targetPort: 8080}]
---
apiVersion: v1
kind: Pod
metadata: {name: payments-worker, labels: {app: payments}}
spec:
  terminationGracePeriodSeconds: 0
  containers:
  - name: worker
    image: busybox:1.36
    imagePullPolicy: IfNotPresent
    command: ["sh","-c","echo starting payments worker; sleep 3; echo 'FATAL: could not connect to database' >&2; exit 1"]
---
apiVersion: v1
kind: Pod
metadata: {name: inventory-api, labels: {app: inventory}}
spec:
  terminationGracePeriodSeconds: 0
  containers:
  - name: api
    image: registry.invalid/inventory-api:1.2.3
`;
const OPS = `
apiVersion: v1
kind: Pod
metadata: {name: payments-worker-canary, labels: {app: payments}}
spec:
  terminationGracePeriodSeconds: 0
  containers:
  - {name: worker, image: busybox:1.36, imagePullPolicy: IfNotPresent, command: ["sh","-c","while true; do echo canary ok; sleep 5; done"]}
`;

let shop;
let ops;
let kc;
let dir;
let server;
let url;

/** helm's homes for the app and for the clean-up, never the developer's. */
const helmEnv = () => ({
  HELM_CONFIG_HOME: join(dir, "config"),
  HELM_CACHE_HOME: join(dir, "cache"),
  HELM_DATA_HOME: join(dir, "data"),
});

// --- The tasks x clicks table ------------------------------------------------

const TABLE = join(ARTIFACTS, "ux-task-flows-clicks.md");
const tally = new Map();
/** Count one step of a task: `clicks` mouse clicks, `typed` fields typed into. */
function step(task, clicks, typed = 0) {
  const t = tally.get(task) ?? { clicks: 0, typed: 0 };
  tally.set(task, { clicks: t.clicks + clicks, typed: t.typed + typed });
}
function writeTable() {
  const rows = [...tally].map(([task, t]) => `| ${task} | ${t.clicks} | ${t.typed} |`);
  writeFileSync(TABLE, ["| Task | Clicks | Fields typed |", "| --- | --- | --- |", ...rows, ""].join("\n"));
}

describe("UX task flows (#486)", { timeout: 30 * 60_000 }, () => {
  before(async () => {
    const alias = aliasKubeconfig(STAGING);
    kc = alias;
    dir = mkdtempSync(join(tmpdir(), "nauvi-qa-ux486-"));
    shop = tempNamespace("ux486-shop", SHOP);
    ops = tempNamespace("ux486-ops", OPS);
    if (!noHelm) {
      const repo = join(dir, "repo");
      mkdirSync(repo);
      execFileSync("helm", ["package", CHART, "--version", "0.2.0", "-d", repo], { stdio: "pipe" });
      server = createServer((req, res) => {
        try {
          const body = readFileSync(join(repo, basename(decodeURIComponent(req.url ?? "/"))));
          res.writeHead(200, { "Content-Length": body.length });
          res.end(body);
        } catch {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      url = `http://127.0.0.1:${server.address().port}`;
      execFileSync("helm", ["repo", "index", repo, "--url", url], { stdio: "pipe" });
    }
    kubectl(["-n", shop, "rollout", "status", "deploy/checkout", "--timeout=180s"]);
    // Task 3 reads the previous run of payments-worker: wait for its first restart.
    for (let i = 0; i < 120; i++) {
      if (Number(kubectl(["-n", shop, "get", "pod", "payments-worker", "-o", "jsonpath={.status.containerStatuses[0].restartCount}"]) || 0) >= 1) break;
      await sleep(1000);
    }
  });
  after(() => {
    writeTable();
    try {
      if (!noHelm) execFileSync("helm", ["uninstall", "demo-chart", "-n", shop, "--kube-context", CONTEXT], { env: { ...process.env, ...helmEnv() }, stdio: "ignore" });
    } catch {
      // Not installed: the namespace goes anyway.
    }
    deleteNamespace(shop);
    deleteNamespace(ops);
    server?.close();
    kc?.remove();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const s = appSession("ux-task-flows", () => ({ kubeconfig: kc.path, env: noHelm ? {} : helmEnv() }));

  const click = (css) => s.app.find(By.css(css)).then((e) => e.click());
  /** Click the first visible button whose text is `text` inside `scope` (CSS). */
  const clickText = (scope, text) =>
    s.app.waitFor(
      () =>
        s.app.js(
          `const b = [...document.querySelectorAll(arguments[0] + ' button')].find(
             (b) => b.textContent.trim() === arguments[1] && b.offsetParent !== null && !b.disabled);
           b?.scrollIntoView({ block: 'center' }); b?.click(); return !!b;`,
          scope || "body",
          text,
        ),
      { message: `button ${text}`, timeout: 60_000 },
    );
  const panelAction = (id) => click(`[data-testid=detail-panel] button[data-action="${id}"]`);
  const menuItem = async (text) => {
    await s.app.waitFor(() =>
      s.app.js(
        `const i = [...document.querySelectorAll('[data-testid="context-menu"] [role=menuitem]')].find((e) => e.textContent.trim() === arguments[0]);
         i?.click(); return !!i;`,
        text,
      ),
    { message: `menu item ${text}` });
  };
  /** Click a berth (the left column) by its short name. */
  const berth = (short) =>
    s.app.waitFor(() =>
      s.app.js(
        `const b = [...document.querySelectorAll('[data-testid="berths"] button')].find((b) => new RegExp('\\\\b' + arguments[0] + '\\\\b').test(b.innerText));
         b?.click(); return !!b;`,
        short,
      ),
    { message: `berth ${short}` });
  /** Close what an earlier step left open: a menu, a dialog, the detail panel. */
  const tidy = async () => {
    await s.app.driver.actions().sendKeys(Key.ESCAPE).perform();
    await s.app.js(`document.querySelector('button[aria-label="Close details"]')?.click()`);
    await sleep(300);
  };
  /**
   * The row of `name` (or, with `prefix`, a Running pod whose name starts
   * with it) in the shop namespace, so a terminating `checkout` pod of
   * another scenario never sorts first.
   */
  const shopRow = ({ name, prefix }) => {
    // A cut cell (#482) by its name, the whole value.
    const cell = (cond) => `[*[@role='gridcell'][${cond}]]`;
    const is = (v) => `normalize-space()=${xq(v)} or @aria-label=${xq(v)}`;
    const nameCell = name ? cell(is(name)) : cell(`starts-with(normalize-space(), ${xq(prefix)}) or starts-with(@aria-label, ${xq(prefix)})`) + cell("normalize-space()='Running'");
    return By.xpath(`//*[@data-testid='resource-row']${cell(is(shop))}${nameCell}`);
  };
  const clickShopRow = async (which) => (await s.app.find(shopRow(which), { timeout: 60_000 })).findElement(By.xpath("./*[@role='gridcell'][2]")).then((c) => c.click());
  const shopRowMenu = async (which) => (await s.app.find(shopRow(which), { timeout: 60_000 })).findElement(By.css('[data-testid="row-menu"]')).then((b) => b.click());
  const typeFilter = async (text) => {
    const f = await s.app.find(By.css('input[aria-label="Filter"]'));
    await s.app.setValue(f, "");
    await f.click();
    await f.sendKeys(text);
  };

  it("1. connects, switches to a second cluster and back", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    // The layout a new user gets: the kinds float in a drawer (G), not a column.
    await app.js(`document.querySelector('[data-testid="chart-unpin"]')?.click()`);
    await setTheme(app, "dark");
    await click('button[aria-label="Cluster catalog"]');
    step("1. Switch cluster", 1);
    await app.waitFor(() => app.js(`return [...document.querySelectorAll('tr, [role=row]')].some((r) => r.innerText.includes(arguments[0]))`, STAGING), { message: "the catalog's rows" });
    await app.shot("1-catalog");
    await app.waitFor(() =>
      app.js(
        `const row = [...document.querySelectorAll('tr, [role=row]')].filter((r) => r.innerText.includes(arguments[0])).at(-1);
         const b = row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Open');
         b?.click(); return !!b;`,
        STAGING,
      ),
    );
    step("1. Switch cluster", 1);
    await app.waitFor(async () => (await app.js(`return document.querySelector('select[aria-label="Cluster context"]').value`)) === STAGING);
    await waitLive(app);
    await app.shot("1-on-staging");
    await click(".chip-go");
    step("1. Switch cluster", 1);
    await app.waitFor(async () => (await app.js(`return document.querySelector('select[aria-label="Cluster context"]').value`)) === CONTEXT);
  });

  it("2. finds a pod by name across namespaces", T, async () => {
    const { app } = s;
    await berth("po");
    await typeFilter("payments");
    step("2. Find a pod across namespaces", 2, 1);
    await app.waitFor(async () => (await app.rows()).length === 2, { message: "both payments pods" });
    const ns = (await app.rows()).map((r) => r[1]).sort();
    assert.deepEqual(ns, [ops, shop].sort());
  });

  it("3. reads its logs: previous container, follow, search", T, async () => {
    const { app } = s;
    await (await app.find(app.row("payments-worker", shop))).click();
    await panelAction("logs");
    step("3. Logs: open, previous, search", 2);
    const id = `logs:${shop}/payments-worker`;
    await app.find(By.css(pane(id)));
    await (await app.find(By.xpath(`//*[@data-testid='dock']//label[contains(normalize-space(),'Previous')]`))).click();
    step("3. Logs: open, previous, search", 1);
    // The crashed run's lines, or (#486) the raw "unable to retrieve container
    // logs" when the runtime has already dropped them.
    await app.waitFor(async () => (await logLines(app, id)).some((l) => /FATAL|unable to retrieve/.test(l)), { message: "the previous run's logs" });
    await app.shot("3-previous");
    // A live log to follow and search.
    await typeFilter("checkout");
    await clickShopRow({ prefix: "checkout-" });
    await panelAction("logs");
    const live = await app.waitFor(async () => (await dockPaneIds(app)).find((p) => p.startsWith(`logs:${shop}/checkout-`)), {
      message: "a log tab for a checkout pod",
    });
    const search = await app.find(By.css(`${pane(live)} input[placeholder^="Filter logs"]`));
    await search.click();
    await search.sendKeys("ERROR");
    step("3. Logs: open, previous, search", 1, 1);
    await app.waitFor(async () => {
      const lines = await logLines(app, live);
      return lines.length > 0 && lines.every((l) => l.includes("ERROR"));
    }, { message: "only the ERROR lines" });
  });

  it("4. opens a shell in it", T, async () => {
    const { app } = s;
    if (!(await app.js(`return document.querySelector('[data-testid=detail-panel] .title')?.textContent ?? ""`)).includes(`${shop}/checkout-`)) {
      await berth("po");
      await typeFilter("checkout");
      await clickShopRow({ prefix: "checkout-" });
    }
    await panelAction("shell");
    step("4. Shell", 1);
    const id = (await app.waitFor(async () => (await dockPaneIds(app)).find((p) => p.startsWith(`shell:${shop}/checkout-`)))) ?? "";
    const t = terminal(app, paneTerminal(id));
    await t.waitFor(/[#$] $/m).catch(() => {});
    await t.type("cat /www/index.html\n");
    await t.waitFor(/hello-checkout/);
  });

  it("5. edits a Deployment's YAML, scales and restarts it", T, async () => {
    const { app } = s;
    await tidy();
    await berth("dep");
    await typeFilter("checkout");
    step("5. Deployment: YAML, scale, restart", 1, 1);
    // Scale from the row's ⋮ menu.
    await shopRowMenu({ name: "checkout" });
    await app.shot("5-row-menu");
    const items = await app.js(`return [...document.querySelectorAll('[data-testid="context-menu"] [role=menuitem]')].map((e) => e.textContent.trim())`);
    await menuItem("Scale…");
    const n = await app.find(By.css("input[type=number]"));
    await n.sendKeys(Key.BACK_SPACE, "3");
    await clickText("", "Scale to 3");
    step("5. Deployment: YAML, scale, restart", 3, 1);
    await app.waitFor(() => kubectl(["-n", shop, "get", "deploy", "checkout", "-o", "jsonpath={.spec.replicas}"]) === "3");
    // Restart from the same menu.
    await shopRowMenu({ name: "checkout" });
    await menuItem("Rollout restart");
    // It asks first, as Shift+R does (#494).
    await (await app.find(byTestId("action-confirm"))).click();
    step("5. Deployment: YAML, scale, restart", 3);
    await app.shot("5-restarted");
    // Editing during the rollout ends in "This object changed on the server
    // since you loaded it" (#486): let the rollout finish first.
    // First the restart itself (its restartedAt annotation), then the rollout.
    await app.waitFor(
      () =>
        kubectl(["-n", shop, "get", "deploy", "checkout", "-o", "jsonpath={.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}"]) !== "",
      { timeout: 30_000, message: "the restartedAt annotation" },
    );
    kubectl(["-n", shop, "rollout", "status", "deploy/checkout", "--timeout=180s"]);
    await sleep(2000);
    // Edit: from the row menu (#494).
    assert.ok(items.includes("Edit YAML"), "the row menu offers Edit YAML");
    await shopRowMenu({ name: "checkout" });
    await menuItem("Edit YAML");
    step("5. Deployment: YAML, scale, restart", 2);
    const editor = await app.find(byTestId("yaml-editor"));
    await app.waitFor(() => app.js("return !!arguments[0].nauviEditor", editor));
    const yaml = await app.js("return arguments[0].nauviEditor.getValue()", editor);
    await app.js("arguments[0].nauviEditor.setValue(arguments[1])", editor, yaml.replace(/\n {2}replicas: \d+\n/, "\n  replicas: 2\n"));
    step("5. Deployment: YAML, scale, restart", 0, 1);
    await clickText("[data-testid=detail-panel]", "Review");
    await app.find(By.xpath(`//*[@data-testid='detail-panel']//button[normalize-space()='Save']`));
    await app.shot("5-review");
    await clickText("[data-testid=detail-panel]", "Save");
    step("5. Deployment: YAML, scale, restart", 2);
    await app.waitFor(() => kubectl(["-n", shop, "get", "deploy", "checkout", "-o", "jsonpath={.spec.replicas}"]) === "2");
  });

  it("6. port-forwards a Service and opens it", T, async () => {
    const { app } = s;
    await tidy();
    await berth("svc");
    await typeFilter("checkout");
    await shopRowMenu({ name: "checkout" });
    await menuItem("Port forward…");
    step("6. Port-forward a Service", 3, 1);
    await app.shot("6-dialog");
    await clickText("[role=dialog]", "Start");
    await clickText("", "Open");
    step("6. Port-forward a Service", 2);
    const opened = await app.waitFor(() => app.profile.opened().find((u) => u.startsWith("http://127.0.0.1:")), { message: "the browser opened" });
    const body = execFileSync("curl", ["-s", opened], { encoding: "utf8" });
    assert.match(body, /hello-checkout/);
  });

  it("7. sees why a pod is failing", T, async () => {
    const { app } = s;
    await tidy();
    await setTheme(app, "light");
    await berth("ov");
    await app.waitFor(() =>
      app.js(
        `const a = [...document.querySelectorAll('a, button')].find((e) => e.textContent.trim() === arguments[0]);
         a?.click(); return !!a;`,
        `${shop}/inventory-api`,
      ),
    { message: "the problem pod on the Overview", timeout: 90_000 });
    step("7. Why is a pod failing", 2);
    await app.waitFor(async () => (await app.js(`return document.querySelector('[data-testid=detail-panel]')?.innerText ?? ""`)).includes("ImagePullBackOff"));
    await app.shot("7-panel-top");
    // The events are at the foot of the panel: scroll to them.
    await app.js(
      `const h = [...document.querySelectorAll('[data-testid=detail-panel] h3, [data-testid=detail-panel] h4, [data-testid=detail-panel] summary')].find((e) => /^Events/.test(e.textContent.trim()));
       h?.scrollIntoView({ block: 'start' });`,
    );
    step("7. Why is a pod failing", 1);
    const text = await app.js(`return document.querySelector('[data-testid=detail-panel]').innerText`);
    assert.match(text, /no such host/);
  });

  it("8. installs and upgrades a Helm release", { ...T, skip: noHelm }, async () => {
    const { app } = s;
    await tidy();
    await setTheme(app, "dark");
    const summary = () => app.js(`return document.querySelector('[data-testid="deploy-summary"]')?.innerText ?? ""`);
    const result = () => app.js(`return document.querySelector('[data-testid="deploy-result"]')?.innerText ?? ""`);
    const values = () => app.js(`return document.querySelector('[data-testid="deploy-values"]')?.nauviEditor?.getValue() ?? ""`);
    await click('[data-testid="chart-toggle"]');
    const find = await app.find(By.css("nav input"));
    await find.sendKeys("helm");
    await clickText("nav", "Charts");
    step("8. Helm install and upgrade", 2, 1);
    await (await app.find(By.css('input[aria-label="Repository name"]'))).sendKeys("local");
    await (await app.find(By.css('input[aria-label="Repository URL"]'))).sendKeys(url);
    await clickText("", "Add");
    step("8. Helm install and upgrade (first repository)", 1, 2);
    await (await app.find(By.xpath("//*[normalize-space(text())='local/demo-chart']"), { timeout: 60_000 })).click();
    await clickText("", "Install…");
    await app.setValue(await app.find(By.css('[role=dialog] input[aria-label="Namespace"]')), shop);
    await app.waitFor(async () => (await values()).includes("greeting: hello"), { message: "the chart's values" });
    await click('[data-testid="deploy-preview"]');
    await app.waitFor(async () => /Dry run of/.test(await summary()), { timeout: 120_000, message: "the install dry run" });
    await app.shot("8-install-dry-run");
    await click('[data-testid="deploy-confirm"]');
    step("8. Helm install and upgrade", 4, 1);
    await app.waitFor(async () => /Installed .*revision 1/.test(await result()), { timeout: 120_000, message: "the install" });
    await app.shot("8-installed");
    await clickText("[role=dialog]", "Open release");
    await clickText("", "Upgrade…");
    await app.waitFor(async () => (await values()).includes("greeting: hello"), { message: "the release's values" });
    await app.js(
      `const e = document.querySelector('[data-testid="deploy-values"]').nauviEditor;
       e.setValue(e.getValue().replace('greeting: hello', 'greeting: hola'));`,
    );
    await click('[data-testid="deploy-preview"]');
    await app.waitFor(async () => /Dry run of/.test(await summary()), { timeout: 120_000, message: "the upgrade dry run" });
    // #497: the headline says "nothing changed" above a diff that changes greeting.
    await app.shot("8-upgrade-dry-run");
    await click('[data-testid="deploy-confirm"]');
    step("8. Helm install and upgrade", 4, 1);
    await app.waitFor(async () => /revision 2/.test(await result()), { timeout: 120_000, message: "the upgrade" });
  });

  it("writes the tasks x clicks table", () => {
    writeTable();
    appendFileSync(TABLE, `\nCounted by qa/ux-task-flows.test.mjs, mouse only, after the first launch (#486).\n`);
  });
});

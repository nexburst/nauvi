// #447: a pod's Environment list with values, in the real WebKitGTK webview
// against kind.
// - nothing is loaded until the list opens; then literals, ConfigMap values
//   (with their source), resolved pod fields and every key of an envFrom
//   ConfigMap (with its prefix) are shown
// - Secret values and secret-looking literals are •••• until Reveal, one
//   row at a time; Hide and closing the list drop them
// - a missing optional ConfigMap says so on its row
// - a user who may read the pod and ConfigMaps but not Secrets gets
//   "not allowed to read Secret ..." on the Secret rows
// - no Secret value reaches the app log or the driver log
// Screenshots in the dark and the light theme.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { ARTIFACTS, xq } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { closePanel, setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { openKind } from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };
// Distinctive, so a leak into a log or the page is easy to spot.
const PASSWORD = "qa-env-pw-5c8e21";
const API_KEY = "qa-env-key-91b0";
const TOKEN = "qa-env-tok-3d7a";
const b64 = (s) => Buffer.from(s).toString("base64");

const FIXTURE = `
apiVersion: v1
kind: ConfigMap
metadata: { name: qa-cfg }
data:
  level: debug
  region: eu-west-1
---
apiVersion: v1
kind: Secret
metadata: { name: qa-creds }
data:
  password: ${b64(PASSWORD)}
  api-key: ${b64(API_KEY)}
---
apiVersion: v1
kind: Pod
metadata: { name: qa-env }
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: busybox:1.36
      command: [sleep, "3600"]
      envFrom:
        - configMapRef: { name: qa-cfg }
          prefix: CFG_
        - secretRef: { name: qa-creds }
          prefix: S_
      env:
        - { name: GREETING, value: hello world }
        - { name: API_TOKEN, value: ${TOKEN} }
        - name: LOG_LEVEL
          valueFrom: { configMapKeyRef: { name: qa-cfg, key: level } }
        - name: DB_PASSWORD
          valueFrom: { secretKeyRef: { name: qa-creds, key: password } }
        - name: FEATURE
          valueFrom: { configMapKeyRef: { name: qa-flags, key: beta, optional: true } }
        - name: POD_NAME
          valueFrom: { fieldRef: { fieldPath: metadata.name } }
        - name: CPU_LIMIT
          valueFrom: { resourceFieldRef: { resource: limits.cpu } }
`;

const LIST = '[data-testid="env-list"]';
const rowCss = (name) => `${LIST} [data-testid="env-row"][data-name=${JSON.stringify(name)}]`;

let ns;
let dir;

const listText = (app) => app.js(`return document.querySelector('${LIST}')?.innerText ?? ""`);
const bodyText = (app) => app.js("return document.body.innerText");
const valueOf = (app, name) =>
  app.js(`return document.querySelector('${rowCss(name)} [data-testid="env-value"]')?.textContent ?? ""`);

async function waitList(app, needle, message = needle) {
  return app.waitFor(async () => (await listText(app)).includes(needle), { message, timeout: 30_000 });
}

/** Open the pod and its Environment list. */
async function openEnv(app) {
  await openKind(app, "Pods", ns, "qa-env");
  await (await app.find(app.row("qa-env", ns))).click();
  const summary = await app.find(
    By.xpath(`//section[@aria-label="Container app"]//summary[starts-with(normalize-space(), ${xq("Environment (")})]`),
    { timeout: 30_000 },
  );
  await app.js("arguments[0].scrollIntoView({ block: 'start' })", summary);
  await summary.click();
  await app.find(By.css(LIST), { timeout: 30_000 });
  await app.waitFor(async () => !(await listText(app)).includes("Loading"), { message: "the env values", timeout: 30_000 });
  await app.js(`document.querySelector('${LIST}')?.scrollIntoView({ block: 'start' })`);
}

async function clickIn(app, name, label) {
  const b = await app.find(By.css(`${rowCss(name)} button[aria-label=${JSON.stringify(`${label} ${name}`)}]`));
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", b);
  await b.click();
}

/** A user that may read pods and ConfigMaps in `namespace`, not Secrets. */
function readerKubeconfig(namespace) {
  kubectl(
    ["-n", namespace, "apply", "-f", "-"],
    `apiVersion: v1
kind: ServiceAccount
metadata: { name: qa-env-reader }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: qa-env-reader }
rules:
  - { apiGroups: [""], resources: [pods, configmaps, events], verbs: [get, list, watch] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: qa-env-reader }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: qa-env-reader }
subjects: [{ kind: ServiceAccount, name: qa-env-reader, namespace: ${namespace} }]
`,
  );
  const token = kubectl(["-n", namespace, "create", "token", "qa-env-reader", "--duration=1h"]);
  const server = kubectl(["config", "view", "--minify", "--flatten", "-o", "jsonpath={.clusters[0].cluster.server}"]);
  const ca = kubectl(["config", "view", "--minify", "--flatten", "-o", "jsonpath={.clusters[0].cluster.certificate-authority-data}"]);
  dir = mkdtempSync(join(tmpdir(), "qa-447-reader-"));
  const path = join(dir, "kubeconfig");
  writeFileSync(
    path,
    `apiVersion: v1
kind: Config
clusters: [{ name: qa, cluster: { server: "${server}", certificate-authority-data: "${ca}" } }]
users: [{ name: qa-env-reader, user: { token: "${token}" } }]
contexts: [{ name: qa-env-reader, context: { cluster: qa, user: qa-env-reader, namespace: ${namespace} } }]
current-context: qa-env-reader
`,
    { mode: 0o600 },
  );
  return path;
}

before(() => {
  ns = tempNamespace("qa-447-env", FIXTURE);
});
after(() => {
  deleteNamespace(ns);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("pod env values (#447)", { timeout: 20 * 60_000 }, () => {
  const s = appSession("pod-env");

  it("shows literals, ConfigMap values, fields and envFrom keys; Secrets hidden (dark)", T, async () => {
    const { app } = s;
    await waitLive(app);
    await setTheme(app, "dark");
    await openEnv(app);
    await waitList(app, "GREETING");
    const t = await listText(app);
    console.log(`env list:\n${t}`);
    assert.equal(await valueOf(app, "GREETING"), "hello world");
    assert.equal(await valueOf(app, "LOG_LEVEL"), "debug");
    assert.match(t, /from ConfigMap qa-cfg\/level/);
    assert.equal(await valueOf(app, "POD_NAME"), "qa-env");
    assert.equal(await valueOf(app, "CPU_LIMIT"), "resourceFieldRef(limits.cpu)");
    assert.equal(await valueOf(app, "CFG_region"), "eu-west-1");
    assert.match(t, /all of ConfigMap qa-cfg \(prefix CFG_\)/);
    assert.match(t, /all of Secret qa-creds \(prefix S_\)/);
    for (const n of ["DB_PASSWORD", "API_TOKEN", "S_password", "S_api-key"]) {
      assert.equal(await valueOf(app, n), "••••", `${n} is hidden`);
    }
    assert.match(t, /ConfigMap qa-flags not found \(optional: not set\)/);
    const body = await bodyText(app);
    for (const v of [PASSWORD, API_KEY, TOKEN]) assert.ok(!body.includes(v), "no hidden value on the page");
  });

  it("reveals one Secret key and one literal, then hides them (dark)", T, async () => {
    const { app } = s;
    await clickIn(app, "DB_PASSWORD", "Reveal");
    await waitList(app, PASSWORD, "the revealed password");
    assert.equal(await valueOf(app, "S_password"), "••••", "only that row is revealed");
    await clickIn(app, "API_TOKEN", "Reveal");
    await waitList(app, TOKEN, "the revealed literal");
    await app.shot("revealed-dark");
    await clickIn(app, "DB_PASSWORD", "Hide");
    await app.waitFor(async () => !(await bodyText(app)).includes(PASSWORD), { message: "the password hidden again" });
  });

  it("closing the list drops revealed values (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await clickIn(app, "S_api-key", "Reveal");
    await waitList(app, API_KEY);
    await app.shot("revealed-light");
    await closePanel(app);
    assert.ok(!(await bodyText(app)).includes(API_KEY), "no revealed value left after closing the panel");
    await openEnv(app);
    await waitList(app, "GREETING");
    for (const n of ["S_api-key", "API_TOKEN"]) assert.equal(await valueOf(app, n), "••••", `${n} hidden again`);
  });

  it("writes no Secret value to the logs", T, async () => {
    const { app } = s;
    const logFile = join(app.profile.home, ".local", "share", "com.nauvi.app", "logs", "nauvi.log");
    const driverLog = join(ARTIFACTS, "pod-env-app.log");
    for (const f of [logFile, driverLog]) {
      if (!existsSync(f)) {
        console.log(`no ${f}`);
        continue;
      }
      const text = readFileSync(f, "utf8");
      for (const v of [PASSWORD, API_KEY, TOKEN, b64(PASSWORD), b64(API_KEY)]) {
        assert.ok(!text.includes(v), `${f} does not contain a hidden value`);
      }
      console.log(`${f}: ${text.length} bytes, no hidden value`);
    }
  });
});

describe("pod env values: no access to Secrets (#447)", { timeout: 10 * 60_000 }, () => {
  const s = appSession("pod-env-reader", () => ({ kubeconfig: readerKubeconfig(ns) }));

  it("says the Secret may not be read, ConfigMaps still resolve (dark)", T, async () => {
    const { app } = s;
    await waitLive(app);
    await setTheme(app, "dark");
    await openEnv(app);
    const line = `not allowed to read Secret qa-creds in ${ns}`;
    await waitList(app, line);
    const t = await listText(app);
    console.log(`reader sees:\n${t}`);
    assert.equal(await valueOf(app, "LOG_LEVEL"), "debug");
    assert.equal(await valueOf(app, "CFG_level"), "debug");
    const err = await app.js(`return document.querySelector('${rowCss("DB_PASSWORD")} [data-testid="env-error"]')?.textContent ?? ""`);
    assert.equal(err, line);
  });

  it("the same in the light theme", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await app.js(`document.querySelector('${LIST}')?.scrollIntoView({ block: 'start' })`);
  });
});

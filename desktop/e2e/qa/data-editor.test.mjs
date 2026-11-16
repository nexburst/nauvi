// #224: the Secret / ConfigMap data editor in the detail panel, in the real
// WebKitGTK webview against kind.
// - a Secret's keys are listed with every value hidden; Reveal shows one key
//   only; a binary value shows as base64, read-only until "Edit as base64"
// - Copy puts the value on the clipboard on the click, and it stays hidden
// - Edit + Save changes only that key (kubectl sees the other keys as they
//   were); the saved value is hidden again
// - a ConfigMap: edit, add and remove keys in one save; a kubectl write
//   meanwhile gives the conflict banner, "Save my keys over it" keeps it
// - closing the panel asks about unsaved edits; revealed values are gone
//   from the page after it closes
// - no Secret value reaches the app log or the driver log
// - a user who may read but not patch Secrets sees the data greyed out
// - the limited user (`edit` in team-a) can edit there
// Screenshots in the dark and the light theme.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { ARTIFACTS, byTestId, xq } from "../lib/app.mjs";
import { hookClipboard, waitForClipboard } from "../lib/clipboard.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { closePanel, setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { answerDiscard, openKind } from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };
// Distinctive, so a leak into a log or the page is easy to spot.
const PASSWORD = "qa-pw-7f3a91";
const NEW_PASSWORD = "qa-new-pw-c41d";
const b64 = (s) => Buffer.from(s).toString("base64");

const FIXTURE = `
apiVersion: v1
kind: Secret
metadata: { name: qa-creds }
data:
  password: ${b64(PASSWORD)}
  username: ${b64("admin")}
  tls.key: /w==
---
apiVersion: v1
kind: ConfigMap
metadata: { name: qa-settings }
data:
  mode: dev
  app.conf: |
    a=1
    b=2
  old: remove-me
`;

const EDITOR = '[data-testid="data-editor"]';
const entryCss = (key) => `${EDITOR} li[data-key=${JSON.stringify(key)}]`;

let ns;
let dir;

const editorText = (app) => app.js(`return document.querySelector('${EDITOR}')?.innerText ?? ""`);
const bodyText = (app) => app.js("return document.body.innerText");

/** A button of the data editor (or of one key's row) by its text. */
async function button(app, label, key) {
  const scope = key ? entryCss(key) : EDITOR;
  return app.waitFor(
    async () => {
      const root = await app.driver.findElements(By.css(scope));
      if (!root.length) return null;
      const found = await root[0].findElements(By.xpath(`.//button[normalize-space()=${xq(label)}]`));
      return found[0] ?? null;
    },
    { message: `the ${label} button${key ? ` of ${key}` : ""}` },
  );
}

async function click(app, label, key) {
  const b = await button(app, label, key);
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", b);
  await b.click();
}

async function waitEditorText(app, needle, message = needle) {
  return app.waitFor(async () => (await editorText(app)).includes(needle), { message, timeout: 30_000 });
}

async function openObject(app, label, namespace, name) {
  await openKind(app, label, namespace, name);
  await (await app.find(app.row(name, namespace))).click();
  await app.find(By.css(`${EDITOR} li`), { timeout: 30_000 });
}

async function valueBox(app, key) {
  return app.find(By.css(`${entryCss(key)} textarea`));
}

const secretValue = (namespace, name, key) =>
  Buffer.from(
    kubectl(["-n", namespace, "get", "secret", name, "-o", `jsonpath={.data.${key.replace(/\./g, "\\.")}}`]),
    "base64",
  ).toString();

/** A user that may read ConfigMaps and Secrets in `namespace` but not change them. */
function readerKubeconfig(namespace) {
  kubectl(
    ["-n", namespace, "apply", "-f", "-"],
    `apiVersion: v1
kind: ServiceAccount
metadata: { name: qa-reader }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: qa-reader }
rules:
  - { apiGroups: [""], resources: [configmaps, secrets, events], verbs: [get, list, watch] }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: qa-reader }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: qa-reader }
subjects: [{ kind: ServiceAccount, name: qa-reader, namespace: ${namespace} }]
`,
  );
  const token = kubectl(["-n", namespace, "create", "token", "qa-reader", "--duration=1h"]);
  const server = kubectl(["config", "view", "--minify", "--flatten", "-o", "jsonpath={.clusters[0].cluster.server}"]);
  const ca = kubectl(["config", "view", "--minify", "--flatten", "-o", "jsonpath={.clusters[0].cluster.certificate-authority-data}"]);
  dir = mkdtempSync(join(tmpdir(), "qa-224-reader-"));
  const path = join(dir, "kubeconfig");
  writeFileSync(
    path,
    `apiVersion: v1
kind: Config
clusters: [{ name: qa, cluster: { server: "${server}", certificate-authority-data: "${ca}" } }]
users: [{ name: qa-reader, user: { token: "${token}" } }]
contexts: [{ name: qa-reader, context: { cluster: qa, user: qa-reader, namespace: ${namespace} } }]
current-context: qa-reader
`,
    { mode: 0o600 },
  );
  return path;
}

before(() => {
  ns = tempNamespace("qa-224-data", FIXTURE);
});
after(() => {
  deleteNamespace(ns);
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("data editor (#224)", { timeout: 20 * 60_000 }, () => {
  const s = appSession("data-editor");

  it("lists a Secret's keys with the values hidden (dark)", T, async () => {
    const { app } = s;
    await waitLive(app);
    await setTheme(app, "dark");
    await openObject(app, "Secrets", ns, "qa-creds");
    await waitEditorText(app, "password");
    const t = await editorText(app);
    console.log(`data editor:\n${t}`);
    for (const k of ["password", "username", "tls.key"]) assert.match(t, new RegExp(k.replace(".", "\\.")));
    assert.match(t, /Values are hidden until you reveal them/);
    assert.match(t, /12 bytes/, "the decoded size of the password");
    assert.match(t, /binary/, "tls.key is marked binary");
    assert.ok(!(await bodyText(app)).includes(PASSWORD), "no value on the page before Reveal");
  });

  it("reveals one key; a binary value shows as base64, read-only", T, async () => {
    const { app } = s;
    await click(app, "Reveal", "password");
    await waitEditorText(app, PASSWORD, "the revealed password");
    assert.ok(!(await editorText(app)).includes("admin"), "only the revealed key is shown");
    await click(app, "Reveal", "tls.key");
    await waitEditorText(app, "Binary value, shown as base64.");
    const bin = await app.js(`return document.querySelector('${entryCss("tls.key")} pre')?.textContent`);
    assert.equal(bin, "/w==");
    assert.equal(await app.js(`return document.querySelectorAll('${entryCss("tls.key")} textarea').length`), 0);
    await button(app, "Edit as base64", "tls.key");
  });

  it("copies a hidden value on the click only", T, async () => {
    const { app } = s;
    await click(app, "Hide all");
    await app.waitFor(async () => !(await bodyText(app)).includes(PASSWORD), { message: "values hidden again" });
    await hookClipboard(app);
    await click(app, "Copy", "password");
    const got = await waitForClipboard(app, PASSWORD);
    console.log(`clipboard (${got.source}) has the password`);
    await waitEditorText(app, 'Copied the value of "password".');
    assert.ok(!(await bodyText(app)).includes(PASSWORD), "copying did not show the value");
  });

  it("edits one Secret key and saves only that key", T, async () => {
    const { app } = s;
    await click(app, "Edit", "password");
    const box = await valueBox(app, "password");
    await app.waitFor(async () => (await app.js("return arguments[0].value", box)) === PASSWORD, {
      message: "the textarea holds the current value",
    });
    await app.setValue(box, "");
    await box.sendKeys(NEW_PASSWORD);
    await waitEditorText(app, "1 changed");
    await app.shot("secret-editing-dark");
    await click(app, "Save");
    await waitEditorText(app, "Saved.");
    assert.equal(secretValue(ns, "qa-creds", "password"), NEW_PASSWORD);
    assert.equal(secretValue(ns, "qa-creds", "username"), "admin", "the other keys are untouched");
    const managers = kubectl(["-n", ns, "get", "secret", "qa-creds", "--show-managed-fields", "-o", "jsonpath={.metadata.managedFields[*].manager}"]);
    console.log(`field managers: ${managers}`);
    assert.match(managers, /kubeloupe/);
    assert.ok(!(await bodyText(app)).includes(NEW_PASSWORD), "the saved value is hidden again");
  });

  it("guards unsaved edits and drops revealed values when the panel closes", T, async () => {
    const { app } = s;
    await click(app, "Reveal", "password");
    await waitEditorText(app, NEW_PASSWORD);
    await click(app, "Edit", "username");
    const box = await valueBox(app, "username");
    await box.sendKeys("-x");
    await waitEditorText(app, "1 changed");
    await (await app.find(By.css('[data-testid="detail-panel"] button[aria-label="Close details"]'))).click();
    await answerDiscard(app, "Discard changes");
    await app.waitFor(async () => (await app.driver.findElements(byTestId("detail-panel"))).length === 0, {
      message: "the panel to close",
    });
    assert.ok(!(await bodyText(app)).includes(NEW_PASSWORD), "no revealed value left on the page");
    assert.equal(secretValue(ns, "qa-creds", "username"), "admin", "the discarded edit was not saved");
    // Reopened: hidden again.
    await (await app.find(app.row("qa-creds", ns))).click();
    await waitEditorText(app, "password");
    assert.equal(await app.js(`return document.querySelectorAll('${EDITOR} [aria-label="Hidden value"]').length`), 3);
  });

  it("edits, adds and removes ConfigMap keys; a conflict can be saved over (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await closePanel(app);
    await openObject(app, "Config Maps", ns, "qa-settings");
    await waitEditorText(app, "remove-me");
    await click(app, "Edit", "mode");
    const box = await valueBox(app, "mode");
    await app.setValue(box, "prod");
    const remove = await app.find(By.css(`${entryCss("old")} button[aria-label="Remove old"]`));
    await remove.click();
    await click(app, "Add key");
    await app.setValue(await app.find(By.css(`${EDITOR} input[aria-label="New key"]`)), "level");
    await app.setValue(await app.find(By.css(`${EDITOR} textarea[aria-label="New value"]`)), "debug");
    await click(app, "Add");
    await waitEditorText(app, "1 changed, 1 added, 1 removed");
    await app.shot("configmap-editing-light");
    // Someone else writes meanwhile.
    kubectl(["-n", ns, "patch", "configmap", "qa-settings", "--type=merge", "-p", '{"data":{"other":"from-kubectl"}}']);
    await click(app, "Save");
    await waitEditorText(app, "This ConfigMap changed on the server since you loaded it.");
    await app.shot("configmap-conflict-light");
    await click(app, "Save my keys over it");
    await waitEditorText(app, "Saved.");
    const data = JSON.parse(kubectl(["-n", ns, "get", "configmap", "qa-settings", "-o", "jsonpath={.data}"]));
    console.log(`configmap data: ${JSON.stringify(data)}`);
    assert.equal(data.mode, "prod");
    assert.equal(data.level, "debug");
    assert.equal(data.other, "from-kubectl", "the other writer's key stays");
    assert.equal(data.old, undefined);
    assert.match(data["app.conf"], /a=1/);
  });

  it("shows a revealed Secret in the light theme", T, async () => {
    const { app } = s;
    await closePanel(app);
    await openObject(app, "Secrets", ns, "qa-creds");
    await click(app, "Reveal", "username");
    await click(app, "Reveal", "tls.key");
    await waitEditorText(app, "Binary value, shown as base64.");
    await app.js(`document.querySelector('${EDITOR}').scrollIntoView({ block: 'start' })`);
    await app.shot("secret-revealed-light");
    const overflow = await app.js(
      `const p = document.querySelector('[data-testid="detail-panel"]'); return p.scrollWidth - p.clientWidth;`,
    );
    assert.ok(overflow <= 1, `the panel does not scroll sideways (${overflow}px)`);
    await setTheme(app, "dark");
    await app.shot("secret-revealed-dark");
    await closePanel(app);
  });

  it("writes no Secret value to the logs", T, async () => {
    const { app } = s;
    const logFile = join(app.profile.home, ".local", "share", "com.kubeloupe.app", "logs", "kubeloupe.log");
    const driverLog = join(ARTIFACTS, "data-editor-app.log");
    for (const f of [logFile, driverLog]) {
      if (!existsSync(f)) {
        console.log(`no ${f}`);
        continue;
      }
      const text = readFileSync(f, "utf8");
      for (const v of [PASSWORD, NEW_PASSWORD, b64(PASSWORD), b64(NEW_PASSWORD)]) {
        assert.ok(!text.includes(v), `${f} does not contain a Secret value`);
      }
      console.log(`${f}: ${text.length} bytes, no Secret value`);
    }
  });
});

describe("data editor: read but not patch (#224)", { timeout: 10 * 60_000 }, () => {
  const s = appSession("data-editor-reader", () => ({ kubeconfig: readerKubeconfig(ns) }));

  it("greys out Edit, Remove and Add key, and still reveals", T, async () => {
    const { app } = s;
    await openObject(app, "Secrets", ns, "qa-creds");
    await waitEditorText(app, "Read-only:");
    const t = await editorText(app);
    console.log(`reader sees:\n${t}`);
    assert.ok(!(await (await button(app, "Edit", "username")).isEnabled()), "Edit is greyed");
    assert.ok(!(await (await button(app, "Add key")).isEnabled()), "Add key is greyed");
    await click(app, "Reveal", "username");
    await waitEditorText(app, "admin");
    await app.shot("reader-readonly-dark");
    await setTheme(app, "light");
    await app.shot("reader-readonly-light");
  });
});

const limited = process.env.KUBELOUPE_LIMITED_KUBECONFIG;
const skipLimited = limited && existsSync(limited) ? false : "set KUBELOUPE_LIMITED_KUBECONFIG (limited-user.sh)";
const LIMITED_NS = "team-a";
const LIMITED_SECRET = `qa-224-${Date.now().toString(36)}`;

describe("data editor: limited user in team-a (#224)", { timeout: 10 * 60_000, skip: skipLimited }, () => {
  before(() => {
    kubectl(["-n", LIMITED_NS, "create", "secret", "generic", LIMITED_SECRET, `--from-literal=token=${PASSWORD}`]);
  });
  after(() => {
    try {
      kubectl(["-n", LIMITED_NS, "delete", "secret", LIMITED_SECRET, "--ignore-not-found"]);
    } catch {
      /* best effort */
    }
  });
  const s = appSession("data-editor-limited", { kubeconfig: limited });

  it("edits a Secret in team-a", T, async () => {
    const { app } = s;
    await app.nav("Secrets");
    await app.filter(LIMITED_SECRET);
    await (await app.find(app.row(LIMITED_SECRET, LIMITED_NS), { timeout: 30_000 })).click();
    await app.find(By.css(`${EDITOR} li`), { timeout: 30_000 });
    // Allowed: nothing is greyed.
    await app.waitFor(async () => (await button(app, "Edit", "token")).isEnabled(), { message: "Edit enabled" });
    assert.ok(!(await editorText(app)).includes("Read-only:"));
    await click(app, "Edit", "token");
    const box = await valueBox(app, "token");
    await app.waitFor(async () => (await app.js("return arguments[0].value", box)) === PASSWORD, { message: "the value" });
    await app.setValue(box, NEW_PASSWORD);
    await click(app, "Save");
    await waitEditorText(app, "Saved.");
    assert.equal(secretValue(LIMITED_NS, LIMITED_SECRET, "token"), NEW_PASSWORD);
    await app.shot("limited-saved-dark");
  });
});

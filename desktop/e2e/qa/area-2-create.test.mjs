// Area 2 of #83, PR #62 (create from YAML), in the real app:
// - "+ Create" on Deployments in a namespace: the template, Validate (dry
//   run, nothing stored), Create, the row appears, the result opens it
// - a CRD and an instance in one paste: both created, the CRD's group and
//   kind show in the sidebar
// - a failing document blocks the batch; "Create the valid ones only"
// - Open file… (the button opens the file input; the file loads)
// - a .yaml file dropped on the dialog opens (an HTML5 drop event in
//   WebKitGTK; a drag from a real file manager is a maintainer check)
// - Escape (and Cancel) with edits asks first
// - the dialog in both themes

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { answerDiscard, editor, editorValue, openKind, setEditorValue, setTheme, waitDiscardDialog } from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };
const SUFFIX = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const GROUP = `qa${SUFFIX}.nauvi.test`;
const CRD = `gadgets.${GROUP}`;
let ns;
let dir;
const get = (args) => kubectl(["-n", ns, ...args]);

const dialog = (app) => app.find(byTestId("create-dialog"));
const results = (app) =>
  app.js(`return Array.from(document.querySelectorAll('[data-testid="create-result"]'), (r) => r.innerText.replace(/\\s+/g, " ").trim())`);
const summary = (app) => app.js(`return document.querySelector('[data-testid="create-summary"]')?.innerText.trim() ?? ""`);
async function button(app, label) {
  return app.find(By.xpath(`//*[@data-testid='create-dialog']//button[normalize-space()=${xq(label)}]`));
}
async function openCreate(app) {
  await (await app.find(By.xpath("//button[normalize-space()='+ Create']"))).click();
  await dialog(app);
  return editor(app, "create-editor");
}
async function closeCreate(app) {
  // "Cancel" while editing, "Close" once the edits are applied.
  await (
    await app.find(By.xpath("//*[@data-testid='create-dialog']//button[normalize-space()='Cancel' or normalize-space()='Close']"))
  ).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("create-dialog"))).length === 0, {
    message: "the create dialog to close",
  });
}
const waitSummary = (app, re) =>
  app.waitFor(async () => {
    const t = await summary(app);
    return re.test(t) ? t : null;
  }, { timeout: 60_000, message: `a summary matching ${re}` });

describe("area 2: create resources from YAML", { timeout: 20 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-area2-new");
    dir = mkdtempSync(join(tmpdir(), "qa-area2-create-"));
  });
  after(() => {
    try {
      kubectl(["delete", "crd", CRD, "--ignore-not-found", "--wait=false"]);
    } catch (e) {
      console.error(`could not delete ${CRD}: ${e.message}`);
    }
    deleteNamespace(ns);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const s = appSession("area-2-create");

  it("+ Create on Deployments: template, Validate, Create, the row appears and opens", T, async () => {
    const { app } = s;
    await waitLive(app);
    await openKind(app, "Deployments", ns);
    const el = await openCreate(app);
    const yaml = await editorValue(app, el);
    console.log(`template:\n${yaml}`);
    assert.match(yaml, /kind: Deployment/);
    assert.match(yaml, new RegExp(`namespace: ${ns}`));
    assert.match(await (await dialog(app)).getText(), new RegExp(`Objects without a namespace go to\\s+${ns}`));
    const name = yaml.match(/name: (\S+)/)[1];
    await app.shot("template-dark");
    await setTheme(app, "light");
    await app.shot("template-light");
    await setTheme(app, null);

    await (await button(app, "Validate")).click();
    const sum = await waitSummary(app, /Validation passed/);
    console.log(`validate: ${sum} / ${JSON.stringify(await results(app))}`);
    assert.equal(get(["get", "deploy", "--ignore-not-found", "-o", "name"]), "", "a dry run stores nothing");

    await (await button(app, "Create")).click();
    await waitSummary(app, /Applied 1 object/);
    const res = await results(app);
    console.log(`create: ${JSON.stringify(res)}`);
    assert.match(res[0], new RegExp(`^Created Deployment ${ns}/${name}`));
    await app.waitFor(async () => (await app.rows()).some(([n, n2]) => n === name && n2 === ns), { message: `${name} in the table` });
    await app.shot("created");
    await (await app.find(byTestId("create-result"))).click();
    await app.waitFor(async () => (await (await app.find(byTestId("detail-panel"))).getText()).includes(`${ns}/${name}`), {
      message: "the created Deployment's panel",
    });
  });

  it("a CRD and an instance in one paste: both created, the CRD shows in the sidebar", T, async () => {
    const { app } = s;
    await openKind(app, "Config Maps", ns);
    const el = await openCreate(app);
    await setEditorValue(
      app,
      el,
      `apiVersion: ${GROUP}/v1
kind: Gadget
metadata:
  name: qa-gadget
spec:
  size: 3
---
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: ${CRD}
spec:
  group: ${GROUP}
  scope: Namespaced
  names: { plural: gadgets, singular: gadget, kind: Gadget }
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec: { type: object, x-kubernetes-preserve-unknown-fields: true }
`,
    );
    await (await button(app, "Validate")).click();
    await waitSummary(app, /./);
    console.log(`validate: ${await summary(app)} / ${JSON.stringify(await results(app))}`);
    await (await button(app, "Create")).click();
    await waitSummary(app, /Applied 2 objects/);
    console.log(`create: ${JSON.stringify(await results(app))}`);
    assert.equal(get(["get", `gadgets.${GROUP}`, "qa-gadget", "-o", "jsonpath={.spec.size}"]), "3");
    await app.shot("crd-created");
    await closeCreate(app);
    // The sidebar lists the new group; its kind opens and lists the instance.
    const group = await app.find(By.xpath(`//nav//summary[contains(normalize-space(), ${xq(GROUP)})]`), { timeout: 30_000 });
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", group);
    await group.click();
    await app.nav("Gadgets");
    await app.waitFor(async () => (await app.rows()).some(([n]) => n === "qa-gadget"), { message: "qa-gadget listed" });
    await app.shot("crd-in-sidebar");
  });

  it("a failing document blocks the batch; Create the valid ones only applies the rest", T, async () => {
    const { app } = s;
    await openKind(app, "Config Maps", ns);
    const el = await openCreate(app);
    await setEditorValue(
      app,
      el,
      `apiVersion: v1
kind: ConfigMap
metadata:
  name: qa-good
data:
  k: v
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: qa-bad
data:
  k: [not, a, string]
`,
    );
    await (await button(app, "Validate")).click();
    const sum = await waitSummary(app, /Validation failed/);
    console.log(`validate: ${sum} / ${JSON.stringify(await results(app))}`);
    const marked = await app.js("return document.querySelector('[data-testid=\"create-dialog\"] .cm-errorLine')?.textContent ?? null");
    console.log(`marked line: ${JSON.stringify(marked)}`);
    await app.shot("validation-failed");
    await (await button(app, "Create")).click();
    await waitSummary(app, /Nothing was applied/);
    assert.equal(get(["get", "cm", "qa-good", "--ignore-not-found", "-o", "name"]), "", "nothing created");
    await (await button(app, "Create the valid ones only")).click();
    await app.waitFor(async () => (await results(app))[0]?.startsWith("Created"), { timeout: 60_000, message: "qa-good created" });
    console.log(`valid only: ${await summary(app)} / ${JSON.stringify(await results(app))}`);
    assert.equal(get(["get", "cm", "qa-good", "-o", "name"]), "configmap/qa-good");
    await app.shot("valid-only");
    await closeCreate(app);
  });

  it("Open file… opens the file input, and the chosen file loads", T, async () => {
    const { app } = s;
    const el = await openCreate(app);
    const path = join(dir, "qa-area2-from-file.yaml");
    writeFileSync(path, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: qa-from-file\ndata:\n  k: v\n");
    // The button clicks the hidden file input (which would open the GTK file
    // chooser): record the click instead, then give the input the file.
    await app.js(
      `const input = document.querySelector('[data-testid="create-file"]');
       window.__qaFileClicks = 0;
       input.click = () => { window.__qaFileClicks++; };`,
    );
    await (await button(app, "Open file…")).click();
    assert.equal(await app.js("return window.__qaFileClicks"), 1, "Open file… asks for a file");
    const input = await app.driver.findElement(byTestId("create-file"));
    await app.js("arguments[0].hidden = false", input);
    await input.sendKeys(path);
    await app.waitFor(async () => (await editorValue(app, el)).includes("qa-from-file"), { message: "the file in the editor" });
    assert.ok(await app.js("return !!document.querySelector('[data-testid=\"create-dialog\"] h2 .dirty')"), "marked unsaved");
    await app.shot("from-file");
  });

  it("a .yaml file dropped on the dialog opens (after asking about the edits)", T, async () => {
    const { app } = s;
    const el = await editor(app, "create-editor");
    await app.js(
      `const target = document.querySelector('[data-testid="create-dialog"]');
       const dt = new DataTransfer();
       dt.items.add(new File(["apiVersion: v1\\nkind: ConfigMap\\nmetadata:\\n  name: qa-dropped\\n"], "drop.yaml", { type: "application/yaml" }));
       target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
       window.__qaDropHint = document.querySelector('[data-testid="create-dialog"] .drop')?.textContent ?? "";
       target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));`,
    );
    console.log(`drop hint: ${await app.js("return window.__qaDropHint")}`);
    // The editor has the opened file (unsaved): dropping asks first.
    await answerDiscard(app, "Discard changes");
    await app.waitFor(async () => (await editorValue(app, el)).includes("qa-dropped"), { message: "the dropped file in the editor" });
    await app.shot("dropped");
  });

  it("Escape and Cancel with edits ask first", T, async () => {
    const { app } = s;
    const el = await editor(app, "create-editor");
    await app.driver.actions().sendKeys(Key.ESCAPE).perform();
    await waitDiscardDialog(app);
    await app.shot("escape-asks");
    await answerDiscard(app, "Keep editing");
    assert.ok((await editorValue(app, el)).includes("qa-dropped"), "the edit is kept");
    await (await button(app, "Cancel")).click();
    await answerDiscard(app, "Discard changes");
    await app.waitFor(async () => (await app.driver.findElements(byTestId("create-dialog"))).length === 0, { message: "closed" });
  });
});

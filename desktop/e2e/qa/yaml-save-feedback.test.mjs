// The YAML editor's save feedback and a rollout while editing (#495), at
// 1280x800 in both themes:
// - the review's messages and "Saved at …" are above the editor, in view;
//   the save is in the notifications
// - the take-over note names the tool in words ("kubectl scale"), not the
//   raw field manager
// - restart, then edit while the rollout updates the status: the save goes
//   through without a conflict
// - a restart after the YAML was loaded: the edit is re-applied on the
//   latest version, to review and save
// - a change to the same field by someone else: a conflict that names it
//
// The Deployment lives in a temporary qa-495-* namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";
import { editor, editorValue, openKind, setEditorValue, setTheme } from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const NAME = "qa-495-web";

// Two replicas with minReadySeconds: a restart's rollout runs for a while
// and updates the status several times.
const FIXTURE = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${NAME}
spec:
  replicas: 2
  minReadySeconds: 4
  selector:
    matchLabels:
      app: ${NAME}
  template:
    metadata:
      labels:
        app: ${NAME}
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: app
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "sleep 3600"]
`;

let ns;
const get = (args) => kubectl(["-n", ns, ...args]);
const rv = () => get(["get", "deploy", NAME, "-o", "jsonpath={.metadata.resourceVersion}"]);
const panel = (app) => app.find(byTestId("detail-panel"));
const statusText = (app) => app.js(`return document.querySelector('[data-testid="yaml-status"]')?.innerText ?? ""`);

async function button(app, label) {
  const p = await panel(app);
  return app.waitFor(async () => (await p.findElements(By.xpath(`.//button[normalize-space()=${JSON.stringify(label)}]`)))[0] ?? null, {
    message: `the ${label} button`,
  });
}

/** Open the Deployment's YAML tab; returns the loaded editor. */
async function openYaml(app) {
  await openKind(app, "Deployments", ns, NAME);
  await app.clickRow(NAME, ns);
  await app.waitFor(async () => (await (await panel(app)).getText()).includes(`${ns}/${NAME}`), { message: "the panel" });
  const p = await panel(app);
  await (await p.findElement(By.xpath(".//button[@role='tab'][normalize-space()='YAML']"))).click();
  const el = await editor(app, "yaml-editor");
  await app.waitFor(async () => (await editorValue(app, el)).includes(`name: ${NAME}`), { message: "the YAML" });
  return el;
}

/** Reload the YAML tab (nothing unsaved) and return the editor's text. */
async function reload(app) {
  await (await button(app, "Reload")).click();
  const el = await editor(app, "yaml-editor");
  await sleep(300);
  return { el, text: await editorValue(app, el) };
}

const loadedVersion = (text) => /resourceVersion: '?"?(\d+)/.exec(text)?.[1] ?? "";

/** Set spec.replicas in the editor text. */
async function setReplicas(app, el, n) {
  const v = await editorValue(app, el);
  const next = v.replace(/^ {2}replicas: \d+$/m, `  replicas: ${n}`);
  assert.notEqual(next, v, "spec.replicas is in the YAML");
  await setEditorValue(app, el, next);
}

/** Where `sel` is, relative to the editor pane and the window. */
function placement(app, sel) {
  return app.js(
    `const p = document.querySelector('[data-testid="detail-panel"]');
     const el = p?.querySelector(arguments[0]); const pane = p?.querySelector('.pane');
     if (!el || !pane) return null;
     const r = el.getBoundingClientRect();
     return { top: r.top, bottom: r.bottom, paneTop: pane.getBoundingClientRect().top, height: innerHeight };`,
    sel,
  );
}

async function assertInView(app, sel, what) {
  const at = await placement(app, sel);
  console.log(`${what}: ${JSON.stringify(at)}`);
  assert.ok(at, `${what} is shown`);
  assert.ok(at.bottom <= at.paneTop + 1, `${what} is above the editor`);
  assert.ok(at.top >= 0 && at.bottom <= at.height, `${what} is in the window`);
}

async function bothThemes(app, label) {
  await setTheme(app, "light");
  await app.shot(`${label}-light`);
  await setTheme(app, "dark");
  await app.shot(`${label}-dark`);
}

async function waitSaved(app) {
  return app.waitFor(
    async () => {
      const t = await statusText(app);
      const alert = await app.js(`return document.querySelector('[data-testid="yaml-status"] [role="alert"]')?.innerText ?? ""`);
      if (alert) throw new Error(`the save stopped: ${alert}`);
      return /Saved at/.test(t) ? t : null;
    },
    { message: "Saved at" },
  );
}

describe("YAML editor: save feedback and edits during a rollout (#495)", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-495", FIXTURE);
    get(["rollout", "status", `deploy/${NAME}`, "--timeout=120s"]);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("yaml-save-feedback");

  it("Review & save shows its messages above the editor; Saved is in view and in the notifications", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    // Someone scales with kubectl: the save takes spec.replicas over from it.
    get(["scale", `deploy/${NAME}`, "--replicas=3"]);
    await app.waitFor(() => get(["get", "deploy", NAME, "-o", "jsonpath={.spec.replicas}"]) === "3");
    const el = await openYaml(app);
    await app.waitFor(async () => (await editorValue(app, el)).includes("replicas: 3"), { message: "replicas: 3" });
    await setReplicas(app, el, 2);
    const review = await app.find(byTestId("yaml-review"));
    assert.equal((await review.getText()).trim(), "Review & save…");
    await review.click();
    await app.find(byTestId("yaml-save"));
    const status = await statusText(app);
    console.log(`review: ${JSON.stringify(status)}`);
    assert.match(status, /The server accepted these changes in a test run/);
    assert.match(status, /Saving takes over fields that kubectl \w+/, "the tool in words");
    assert.doesNotMatch(status, /another tool/);
    assert.doesNotMatch(status, /from nauvi/);
    await assertInView(app, '[role="note"]', "the take-over note");
    await bothThemes(app, "1-review-takeover");

    await (await app.find(byTestId("yaml-save"))).click();
    await waitSaved(app);
    await assertInView(app, '[data-testid="yaml-saved"]', "Saved");
    await bothThemes(app, "2-saved");
    assert.equal(get(["get", "deploy", NAME, "-o", "jsonpath={.spec.replicas}"]), "2");

    const bell = await app.find(byTestId("notification-bell"));
    await bell.click();
    const list = await app.find(byTestId("notifications-panel"));
    await app.waitFor(async () => /Saved the YAML of Deployment qa-495-web/.test(await list.getText()), {
      message: "the save in the notifications",
    });
    await app.shot("3-notifications");
    await bell.click();
  });

  it("restart, then edit while the rollout updates the status: saved without a conflict", T, async () => {
    const { app } = s;
    get(["rollout", "restart", `deploy/${NAME}`]);
    // Loaded after the restart, while the rollout runs.
    const { el, text } = await reload(app);
    const loaded = loadedVersion(text);
    assert.ok(loaded, "the YAML has a resourceVersion");
    await setReplicas(app, el, 3);
    // Wait for the rollout to write the object again (its status).
    const deadline = Date.now() + 30_000;
    while (rv() === loaded && Date.now() < deadline) await sleep(250);
    const now = rv();
    console.log(`loaded at ${loaded}, now ${now}`);
    assert.notEqual(now, loaded, "the rollout changed the object while editing");
    await (await app.find(byTestId("yaml-review"))).click();
    await app.find(byTestId("yaml-save"));
    assert.equal(await app.js(`return !!document.querySelector('[data-testid="yaml-rebased"]')`), false, "no re-apply note for a status change");
    await (await app.find(byTestId("yaml-save"))).click();
    const saved = await waitSaved(app);
    console.log(`after the save: ${JSON.stringify(saved)}`);
    await assertInView(app, '[data-testid="yaml-saved"]', "Saved");
    await bothThemes(app, "4-saved-during-rollout");
    assert.equal(get(["get", "deploy", NAME, "-o", "jsonpath={.spec.replicas}"]), "3");
  });

  it("a restart after the YAML was loaded: the edit is re-applied on the latest version", T, async () => {
    const { app } = s;
    get(["rollout", "status", `deploy/${NAME}`, "--timeout=120s"]);
    const { el } = await reload(app);
    await setReplicas(app, el, 2);
    get(["rollout", "restart", `deploy/${NAME}`]);
    const restartedAt = get(["get", "deploy", NAME, "-o", "jsonpath={.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}"]);
    await (await app.find(byTestId("yaml-review"))).click();
    const note = await app.find(byTestId("yaml-rebased"));
    const text = await note.getText();
    console.log(`re-applied: ${JSON.stringify(text)}`);
    assert.match(text, /restartedAt/);
    await assertInView(app, '[data-testid="yaml-rebased"]', "the re-apply note");
    const changed = await app.js("return Array.from(document.querySelectorAll('[data-testid=\"detail-panel\"] .cm-changedLine'), (l) => l.textContent)");
    console.log(`diff: ${JSON.stringify(changed)}`);
    assert.ok(changed.some((l) => /replicas: 2/.test(l)), "the diff shows the edit");
    assert.ok(!changed.some((l) => /restartedAt/.test(l)), "and not the restart, which is in both");
    await bothThemes(app, "5-rebased");
    await (await app.find(byTestId("yaml-save"))).click();
    await waitSaved(app);
    assert.equal(get(["get", "deploy", NAME, "-o", "jsonpath={.spec.replicas}"]), "2");
    const kept = get(["get", "deploy", NAME, "-o", "jsonpath={.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}"]);
    assert.equal(kept, restartedAt, "the restart is kept");
  });

  it("the same field changed by someone else: a conflict that names it", T, async () => {
    const { app } = s;
    const { el } = await reload(app);
    await setReplicas(app, el, 4);
    get(["scale", `deploy/${NAME}`, "--replicas=1"]);
    await (await app.find(byTestId("yaml-review"))).click();
    const alert = await app.find(By.css('[data-testid="yaml-status"] [role="alert"]'));
    const text = await alert.getText();
    console.log(`conflict: ${JSON.stringify(text)}`);
    assert.match(text, /You and someone else both changed \.spec\.replicas/);
    await assertInView(app, '[data-testid="yaml-status"] [role="alert"]', "the conflict");
    await bothThemes(app, "6-conflict");
    assert.equal(get(["get", "deploy", NAME, "-o", "jsonpath={.spec.replicas}"]), "1", "nothing was overwritten");
    await (await button(app, "Reload (lose my edits)")).click();
    await app.waitFor(async () => /^ {2}replicas: 1$/m.test(await editorValue(app, await editor(app, "yaml-editor"))), {
      message: "the server's replicas after Reload",
    });
    await setTheme(app, null);
  });
});

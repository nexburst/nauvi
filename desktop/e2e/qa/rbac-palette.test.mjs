// The command palette and the keyboard Delete follow RBAC (#349), as the
// namespace-scoped user from scripts/test-cluster/limited-user.sh (`edit`
// in team-a only). Like rbac-actions, the scenario gives that user `view`
// in a temp namespace (a RoleBinding made with the admin context):
// - in the view-only namespace the palette's actions for the focused row
//   are greyed, each with its "Not allowed: …" reason under it, and Enter
//   on Delete opens no dialog; Logs is offered;
// - the keyboard Delete on that row says why in a notice instead of
//   opening the confirm dialog;
// - in team-a the palette offers Delete and the keyboard Delete opens the
//   dialog (cancelled);
// - with the context made read-only, team-a's palette Delete and the
//   keyboard Delete give the read-only reason instead (#338).
// Light and dark theme at 1280x800. Skipped unless NAUVI_LIMITED_KUBECONFIG
// names that kubeconfig.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { closeNamespacePicker, openNamespacePicker } from "../lib/table.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const kubeconfig = process.env.NAUVI_LIMITED_KUBECONFIG;
const skip = kubeconfig && existsSync(kubeconfig) ? false : "set NAUVI_LIMITED_KUBECONFIG (limited-user.sh)";
const DEPLOYMENT = "qa-pal-dep";
const READ_ONLY = /is read-only: changes to this cluster are turned off/;
let ns;

const objects = () =>
  [
    `apiVersion: apps/v1
kind: Deployment
metadata: { name: ${DEPLOYMENT} }
spec:
  replicas: 0
  selector: { matchLabels: { app: ${DEPLOYMENT} } }
  template:
    metadata: { labels: { app: ${DEPLOYMENT} } }
    spec: { containers: [{ name: pause, image: registry.k8s.io/pause:3.10 }] }`,
    `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: qa-limited-view }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ kind: ServiceAccount, name: limited, namespace: team-a }]`,
  ].join("\n---\n");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const press = (app, ...keys) => app.driver.actions().sendKeys(...keys).perform();
const ctrl = (app, key) => app.driver.actions().keyDown(Key.CONTROL).sendKeys(key).keyUp(Key.CONTROL).perform();
const count = (app, css) => app.js(`return document.querySelectorAll(arguments[0]).length`, css);

/** The palette's options: label, whether refused, and the reason under it. */
const options = (app) =>
  app.js(`return Array.from(document.querySelectorAll('[data-testid="command-palette"] [role="option"]'), (o) => ({
    label: o.querySelector('.label')?.textContent.trim() ?? "",
    disabled: o.getAttribute("aria-disabled") === "true",
    reason: o.querySelector('[data-testid="palette-reason"]')?.textContent.trim() ?? "",
  }));`);

/** Type a namespace into the picker and add it (the user cannot list namespaces). */
async function addTyped(app, namespace) {
  const pop = await openNamespacePicker(app);
  await app.setValue(await pop.findElement(By.css('input[aria-label="Search namespaces"]')), namespace);
  await (await app.find(By.xpath(`//*[@aria-label='Namespaces']//button[starts-with(normalize-space(),'Add')]`))).click();
  await closeNamespacePicker(app);
}

/** Filter the table to `name` in `namespace` and give that row the keyboard focus. */
async function focusRow(app, name, namespace) {
  await app.filter(name);
  await app.find(app.row(name, namespace));
  await app.js(`document.querySelector('[role="grid"]').focus()`);
  await press(app, Key.ARROW_DOWN);
  await app.waitFor(
    () =>
      app.js(`const id = document.querySelector('[role="grid"]')?.getAttribute("aria-activedescendant");
        return id ? document.getElementById(id)?.querySelectorAll('[role="gridcell"]')[1]?.textContent.trim() === ${JSON.stringify(name)} : false;`),
    { message: `${name} focused` },
  );
}

/** Open the palette on the actions (`>` + `text`), wait for the access check to answer. */
async function paletteActions(app, text, settled) {
  await ctrl(app, "k");
  await app.find(byTestId("command-palette"));
  await app.setValue(await app.find(By.css('[data-testid="command-palette"] input')), `>${text}`);
  return app.waitFor(
    async () => {
      const o = await options(app);
      return settled(o) ? o : null;
    },
    { timeout: 20_000, message: "palette actions after the access check" },
  );
}

async function closePalette(app) {
  await press(app, Key.ESCAPE);
  await app.waitFor(async () => (await count(app, '[data-testid="command-palette"]')) === 0, { message: "palette closed" });
}

const noticeText = (app) => app.js(`return document.querySelector('.notice')?.innerText.trim() ?? ""`);

async function dismissNotice(app) {
  const close = await app.driver.findElements(By.css('.notice button'));
  if (close.length) await close[close.length - 1].click();
}

/** Pick a mode on this cluster's settings page, then close it. */
async function setMode(app, label) {
  await app.palette("cluster settings", "Cluster settings");
  const dialog = await app.find(byTestId("cluster-settings"));
  const radio = await dialog.findElement(
    By.xpath(`.//label[contains(@class,'mode-choice')][.//strong[normalize-space()=${xq(label)}]]/input`),
  );
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", radio);
  await radio.click();
  await app.waitFor(async () => radio.isSelected(), { message: `${label} selected` });
  await (await dialog.findElement(By.xpath(".//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await count(app, '[data-testid="cluster-settings"]')) === 0, {
    message: "cluster settings closed",
  });
}

describe("palette and keyboard Delete follow RBAC (limited user)", { timeout: 12 * 60_000, skip }, () => {
  before(() => {
    ns = tempNamespace("qa-rbac-palette");
    kubectl(["-n", ns, "apply", "-f", "-"], objects());
  });
  after(() => deleteNamespace(ns));
  const s = appSession("rbac-palette", { kubeconfig });

  it("in a view-only namespace the palette greys out what view can't do", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.nav("Deployments");
    await addTyped(app, ns);
    await focusRow(app, DEPLOYMENT, ns);
    const opts = await paletteActions(app, "", (o) => o.some((i) => i.disabled));
    console.log(`view-only palette: ${JSON.stringify(opts.filter((o) => o.label), null, 1)}`);
    const by = Object.fromEntries(opts.map((o) => [o.label, o]));
    assert.equal(by["Delete"]?.disabled, true, "Delete refused");
    assert.equal(by["Delete"].reason, `Not allowed: you can't delete deployments.apps in namespace ${ns}`);
    assert.equal(by["Scale…"]?.reason, `Not allowed: you can't patch deployments/scale.apps in namespace ${ns}`);
    assert.equal(by["Rollout restart"]?.disabled, true);
    assert.equal(by["Logs"]?.disabled, false, "view may read logs");

    // The refused ones in view; Enter on Delete runs nothing.
    await app.setValue(await app.find(By.css('[data-testid="command-palette"] input')), ">de");
    await app.waitFor(async () => (await options(app)).some((o) => o.disabled), { message: "refused actions listed" });
    await app.shot("palette-view-only-light");
    await setTheme(app, "dark");
    await app.shot("palette-view-only-dark");
    await setTheme(app, "light");
    await app.setValue(await app.find(By.css('[data-testid="command-palette"] input')), ">delete");
    await app.waitFor(async () => (await options(app))[0]?.disabled === true, { message: "Delete first, refused" });
    await press(app, Key.ENTER);
    await sleep(500);
    assert.equal(await count(app, '[role="alertdialog"]'), 0, "no confirm dialog");
    assert.equal(await count(app, '[data-testid="command-palette"]'), 1, "the palette stays open");
    await closePalette(app);
  });

  it("the keyboard Delete says why instead of opening the dialog", T, async () => {
    const { app } = s;
    await focusRow(app, DEPLOYMENT, ns);
    await press(app, Key.DELETE);
    const text = await app.waitFor(async () => (await noticeText(app)) || null, { message: "a notice" });
    console.log(`notice: ${text}`);
    assert.match(text, new RegExp(`Not allowed: you can't delete deployments.apps in namespace ${ns}`));
    assert.equal(await count(app, '[role="alertdialog"]'), 0, "no confirm dialog");
    await app.shot("delete-refused-light");
    await setTheme(app, "dark");
    await app.shot("delete-refused-dark");
    await setTheme(app, "light");
    await dismissNotice(app);
  });

  it("in team-a the palette offers Delete and the keyboard Delete asks", T, async () => {
    const { app } = s;
    await focusRow(app, "hello", "team-a");
    await sleep(1500); // let the access check answer
    const opts = await paletteActions(app, "delete", (o) => o.some((i) => i.label === "Delete"));
    console.log(`team-a palette: ${JSON.stringify(opts)}`);
    assert.equal(opts.find((o) => o.label === "Delete").disabled, false);
    await closePalette(app);
    await focusRow(app, "hello", "team-a");
    await press(app, Key.DELETE);
    await app.find(byTestId("action-dialog"));
    await press(app, Key.ESCAPE);
    await app.waitFor(async () => (await count(app, '[data-testid="action-dialog"]')) === 0, { message: "dialog closed" });
    kubectl(["-n", "team-a", "get", "deployment", "hello"]);
  });

  it("on a read-only context the read-only reason wins", T, async () => {
    const { app } = s;
    await setMode(app, "Read-only");
    try {
      await focusRow(app, "hello", "team-a");
      const opts = await paletteActions(app, "delete", (o) => o.some((i) => i.label === "Delete" && i.disabled));
      const del = opts.find((o) => o.label === "Delete");
      console.log(`read-only palette: ${JSON.stringify(del)}`);
      assert.match(del.reason, READ_ONLY);
      await app.shot("palette-read-only-light");
      await closePalette(app);
      await focusRow(app, DEPLOYMENT, ns);
      await press(app, Key.DELETE);
      const text = await app.waitFor(async () => (await noticeText(app)) || null, { message: "a notice" });
      console.log(`read-only notice: ${text}`);
      assert.match(text, READ_ONLY, "read-only, not RBAC, is the reason");
      assert.equal(await count(app, '[role="alertdialog"]'), 0, "no confirm dialog");
      await setTheme(app, "dark");
      await app.shot("delete-read-only-dark");
      await setTheme(app, "light");
      await dismissNotice(app);
    } finally {
      await setMode(app, "Normal");
    }
  });
});

// Actions follow RBAC (#340), as the namespace-scoped user from
// scripts/test-cluster/limited-user.sh (`edit` in team-a only). The scenario
// also gives that user `view` in a temp namespace (a RoleBinding made with
// the admin context), so it can list objects there but not change them:
// - in team-a the row menu offers every action;
// - in the view-only namespace the row menu greys out Scale, Rollout
//   restart and Delete, each with the missing permission under it, and
//   keeps Logs;
// - the detail panel's bar greys out the same, with the reason in its
//   tooltip;
// - the bulk bar's Delete is refused for ConfigMaps of that namespace, with
//   the reason, and opens no dialog.
// Skipped unless NAUVI_LIMITED_KUBECONFIG names that kubeconfig.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { closeNamespacePicker, openNamespacePicker } from "../lib/table.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";
import { closeMenu, contextMenu } from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };
const kubeconfig = process.env.NAUVI_LIMITED_KUBECONFIG;
const skip = kubeconfig && existsSync(kubeconfig) ? false : "set NAUVI_LIMITED_KUBECONFIG (limited-user.sh)";
const CONFIGMAPS = ["qa-rbac-a", "qa-rbac-b"];
const DEPLOYMENT = "qa-rbac-dep";
let ns;

const objects = () =>
  [
    ...CONFIGMAPS.map((n) => `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: ${n} }\ndata: { k: v }`),
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
  ]
    .join("\n---\n");

/** The open row menu: each item's label, whether it is disabled, and the reason under it. */
function menuState(app) {
  return app.js(`
    const m = document.querySelector('[data-testid="context-menu"]');
    return Array.from(m.querySelectorAll('[role="menuitem"]'), (b) => ({
      label: b.textContent.trim(),
      disabled: b.disabled,
      reason: b.getAttribute("aria-describedby") ? document.getElementById(b.getAttribute("aria-describedby"))?.textContent.trim() ?? "" : "",
    }));
  `);
}

/** Type a namespace into the picker and add it (the user cannot list namespaces). */
async function addTyped(app, namespace) {
  const pop = await openNamespacePicker(app);
  await app.setValue(await pop.findElement(By.css('input[aria-label="Search namespaces"]')), namespace);
  await (await app.find(By.xpath(`//*[@aria-label='Namespaces']//button[starts-with(normalize-space(),'Add')]`))).click();
  await closeNamespacePicker(app);
}

describe("actions follow RBAC (limited user)", { timeout: 12 * 60_000, skip }, () => {
  before(() => {
    ns = tempNamespace("qa-rbac-actions");
    kubectl(["-n", ns, "apply", "-f", "-"], objects());
  });
  after(() => deleteNamespace(ns));
  const s = appSession("rbac-actions", { kubeconfig });

  it("in team-a the row menu offers every action", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.nav("Deployments");
    await app.filter("hello");
    await contextMenu(app, "hello", "team-a");
    // Give the access check time to answer, then nothing may be greyed.
    await new Promise((r) => setTimeout(r, 1500));
    const items = await menuState(app);
    console.log(`team-a menu: ${JSON.stringify(items)}`);
    assert.ok(items.some((i) => i.label === "Delete"), "Delete offered");
    assert.deepEqual(
      items.filter((i) => i.disabled),
      [],
      "nothing greyed in team-a",
    );
  });

  it("in a view-only namespace the row menu greys out what view can't do", T, async () => {
    const { app } = s;
    await closeMenu(app);
    await addTyped(app, ns);
    await app.filter(DEPLOYMENT);
    await contextMenu(app, DEPLOYMENT, ns);
    const items = await app.waitFor(
      async () => {
        const st = await menuState(app);
        return st.filter((i) => i.disabled).length >= 3 ? st : null;
      },
      { timeout: 20_000, message: "greyed menu items" },
    );
    console.log(`view-only menu: ${JSON.stringify(items, null, 1)}`);
    const by = Object.fromEntries(items.map((i) => [i.label, i]));
    assert.equal(by["Delete"].disabled, true);
    assert.equal(by["Delete"].reason, `Not allowed: you can't delete deployments.apps in namespace ${ns}`);
    assert.equal(by["Scale…"].reason, `Not allowed: you can't patch deployments/scale.apps in namespace ${ns}`);
    assert.equal(by["Rollout restart"].disabled, true);
    assert.equal(by["Logs"].disabled, false, "view may read logs");
    assert.equal(by["Copy link"].disabled, false);
    await setTheme(app, "dark");
    await app.shot("view-only-menu-dark");
    await setTheme(app, "light");
  });

  it("the detail panel greys out the same, with the reason in the tooltip", T, async () => {
    const { app } = s;
    await closeMenu(app);
    await (await app.find(app.row(DEPLOYMENT, ns))).click();
    const del = await app.find(By.css('[data-testid="detail-panel"] [role="toolbar"] button[data-action="delete"]'));
    await app.waitFor(async () => (await del.getAttribute("aria-disabled")) === "true", {
      message: "Delete greyed in the panel",
    });
    await app.driver.actions().move({ origin: del }).perform();
    const tip = await app.waitFor(
      () => app.js(`return document.querySelector('[data-testid="action-tip"]')?.innerText ?? null`),
      { message: "the tooltip" },
    );
    console.log(`panel tooltip: ${tip}`);
    assert.match(tip, new RegExp(`you can't delete deployments.apps in namespace ${ns}`));
  });

  it("the bulk bar's Delete is refused with the reason", T, async () => {
    const { app } = s;
    await app.driver.actions().sendKeys(Key.ESCAPE).perform();
    await app.nav("Config Maps");
    await app.filter("qa-rbac-");
    for (const name of CONFIGMAPS) {
      const row = await app.find(app.row(name, ns));
      await (await row.findElement(By.css('input[type="checkbox"]'))).click();
    }
    const reason = await app.waitFor(
      () => app.js(`return document.querySelector('[data-testid="bulk-reason"]')?.textContent.trim() ?? null`),
      { timeout: 20_000, message: "the bulk bar's reason" },
    );
    console.log(`bulk bar: ${reason}`);
    assert.equal(reason, `Not allowed: you can't delete configmaps in namespace ${ns}`);
    const btn = await app.find(By.xpath(`//*[@role='toolbar'][@aria-label='Selection']//button[starts-with(normalize-space(),'Delete')]`));
    assert.equal(await btn.getAttribute("aria-disabled"), "true");
    await btn.click();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await app.driver.findElements(By.css('[role="alertdialog"]'))).length, 0, "no confirm dialog");
    await setTheme(app, "dark");
    await app.shot("bulk-refused-dark");
    await setTheme(app, "light");
    assert.ok(await app.driver.findElement(byTestId("bulk-reason")));
  });
});

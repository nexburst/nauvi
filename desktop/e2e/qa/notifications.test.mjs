// Notification history (#326), at 1280x800 in the dark and the light theme,
// on two Deployments in a temp namespace:
// - the bell has no count and the panel says it is empty at first
// - a Rollout restart (a notice) and a refused one (an error notice: a
//   ValidatingAdmissionPolicy denies updates of qa-notify-locked) land in
//   the history; the bell counts them until the panel is opened
// - each entry has its time, level, context and a link to the object;
//   the link opens the object's detail panel
// - Clear all empties it

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/theme.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";
import { contextMenu, menuItem, noticeText, openKind } from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };

const deployment = (name) => `
apiVersion: apps/v1
kind: Deployment
metadata: { name: ${name} }
spec:
  replicas: 0
  selector: { matchLabels: { app: ${name} } }
  template:
    metadata: { labels: { app: ${name} } }
    spec:
      containers: [{ name: main, image: "busybox:1.36", command: ["sh", "-c", "sleep 3600"] }]
`;

let ns = "";
let policy = "";
let skip = "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function policyYaml(name, namespace) {
  return `
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicy
metadata: { name: ${name} }
spec:
  failurePolicy: Fail
  matchConstraints:
    resourceRules:
      - apiGroups: ["apps"]
        apiVersions: ["v1"]
        operations: ["UPDATE"]
        resources: ["deployments"]
  validations:
    - expression: "object.metadata.name != 'qa-notify-locked'"
      message: "qa-notify-locked is locked by the QA scenario"
---
apiVersion: admissionregistration.k8s.io/v1
kind: ValidatingAdmissionPolicyBinding
metadata: { name: ${name} }
spec:
  policyName: ${name}
  validationActions: [Deny]
  matchResources:
    namespaceSelector:
      matchLabels: { kubernetes.io/metadata.name: ${namespace} }
`;
}

/** Wait until the API server enforces the policy (it picks it up after a few seconds). */
async function waitPolicy() {
  for (let i = 0; i < 60; i++) {
    try {
      kubectl(["-n", ns, "annotate", "deploy/qa-notify-locked", "qa=1", "--overwrite", "--dry-run=server"]);
    } catch (e) {
      if (/locked by the QA scenario/.test(String(e.stderr ?? e.message))) return;
    }
    await sleep(1000);
  }
  throw new Error("the ValidatingAdmissionPolicy was never enforced");
}

async function bothThemes(app, label) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await app.js("return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

const panelOpen = async (app) => (await app.driver.findElements(byTestId("notifications-panel"))).length > 0;
const badge = (app) => app.js(`return document.querySelector('[data-testid="notification-count"]')?.textContent.trim() ?? ""`);
const entries = (app) =>
  app.js(
    `return Array.from(document.querySelectorAll('[data-testid="notification"]'), (e) => ({
       cls: e.className, text: e.innerText.trim(),
       time: e.querySelector('time')?.textContent.trim() ?? "",
       context: e.querySelector('.context')?.textContent.trim() ?? "",
       link: e.querySelector('button.link')?.textContent.trim() ?? "" }))`,
  );

async function toggleBell(app, open) {
  await (await app.find(byTestId("notification-bell"))).click();
  await app.waitFor(async () => (await panelOpen(app)) === open, { message: `the panel to ${open ? "open" : "close"}` });
}

before(async () => {
  try {
    kubectl(["api-resources", "--api-group=admissionregistration.k8s.io", "-o", "name"]).includes(
      "validatingadmissionpolicies",
    ) || (skip = "the cluster has no ValidatingAdmissionPolicy");
  } catch (e) {
    skip = `could not list admission resources: ${e.message}`;
  }
  ns = tempNamespace("qa-notify", deployment("qa-notify") + "---" + deployment("qa-notify-locked"));
  if (!skip) {
    policy = ns;
    kubectl(["apply", "-f", "-"], policyYaml(policy, ns));
    await waitPolicy();
  }
});
after(() => {
  if (policy) {
    try {
      kubectl(["delete", "validatingadmissionpolicybinding,validatingadmissionpolicy", policy, "--wait=false"]);
    } catch (e) {
      console.error(`could not delete the policy ${policy}: ${e.message}`);
    }
  }
  deleteNamespace(ns);
});

describe("notification history", { timeout: 15 * 60_000 }, () => {
  const s = appSession("notifications");

  it("starts empty", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    assert.equal(await badge(app), "", "no count at first");
    await bothThemes(app, "bell-empty");
    await toggleBell(app, true);
    const empty = await (await app.find(byTestId("notifications-empty"))).getText();
    assert.match(empty, /No notifications yet/);
    await bothThemes(app, "panel-empty");
    await toggleBell(app, false);
  });

  it("a notice and a refused action land in the history, counted on the bell", T, async (t) => {
    if (skip) return t.skip(skip);
    const { app } = s;
    await openKind(app, "Deployments", ns, "qa-notify");
    await contextMenu(app, "qa-notify", ns);
    await menuItem(app, "Rollout restart");
    // It asks first, from the menu as from Shift+R (#494).
    await (await app.find(byTestId("action-confirm"))).click();
    await app.waitFor(async () => /Restarted|restart/i.test(await noticeText(app)), { message: "the restart notice" });
    await contextMenu(app, "qa-notify-locked", ns);
    await menuItem(app, "Rollout restart");
    await (await app.find(byTestId("action-confirm"))).click();
    const err = await app.waitFor(
      async () => {
        const n = await noticeText(app);
        return /locked by the QA scenario/.test(n) ? n : null;
      },
      { timeout: 30_000, message: "the refused restart notice" },
    );
    console.log(`error notice: ${err}`);
    assert.equal(await badge(app), "2");
    await bothThemes(app, "bell-unread");

    await toggleBell(app, true);
    assert.equal(await badge(app), "", "opening the panel reads them");
    const list = await entries(app);
    console.log(`entries: ${JSON.stringify(list, null, 2)}`);
    assert.equal(list.length, 2);
    assert.match(list[0].cls, /\berror\b/);
    assert.match(list[0].text, /locked by the QA scenario/);
    assert.equal(list[0].link, `Deployment ${ns}/qa-notify-locked`);
    assert.match(list[1].cls, /\bsuccess\b/);
    assert.equal(list[1].link, `Deployment ${ns}/qa-notify`);
    for (const e of list) {
      assert.match(e.time, /^\d\d:\d\d:\d\d$/);
      assert.equal(e.context, CONTEXT);
    }
    await bothThemes(app, "panel-entries");
  });

  it("an entry opens its object; Clear all empties the history", T, async (t) => {
    if (skip) return t.skip(skip);
    const { app } = s;
    await app.nav("Pods");
    if (!(await panelOpen(app))) await toggleBell(app, true);
    const link = await app.find(
      By.xpath(`//*[@data-testid='notifications-panel']//button[normalize-space()=${xq(`Deployment ${ns}/qa-notify`)}]`),
    );
    await link.click();
    await app.waitFor(async () => !(await panelOpen(app)), { message: "the panel to close" });
    const title = await app.waitFor(
      () => app.js(`return document.querySelector('[data-testid="detail-panel"]')?.innerText ?? null`),
      { message: "the deployment's detail panel" },
    );
    assert.match(title, /qa-notify/);
    await app.shot("opened-from-history");

    await toggleBell(app, true);
    await (
      await app.find(By.xpath(`//*[@data-testid='notifications-panel']//button[normalize-space()='Clear all']`))
    ).click();
    await app.waitFor(async () => (await entries(app)).length === 0, { message: "the history to be empty" });
    await app.find(byTestId("notifications-empty"));
    await app.shot("cleared");
  });
});

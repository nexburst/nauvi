// Area 2 of #83, PR #23 (resource actions), on objects in a temp namespace:
// - Deployments: Scale to 3, then to 0 (warning shown); the table updates.
// - Rollout restart of a Deployment, StatefulSet and DaemonSet: pods roll.
// - CronJob: Trigger (a Job <name>-manual-xxxxx owned by it), Suspend, Resume.
// - Pod: Delete, then Force delete (the name must be typed).
// - ConfigMaps: checkboxes, shift-click, header checkbox, Delete N lists them.
// - Right-click inside a multi-selection offers only the bulk delete.
// - Detail panel buttons match the context menu (Deployment, CronJob, Node, Pod).
// - Node: Cordon / Uncordon on the worker (always uncordoned afterwards); the
//   Ready cell says True,SchedulingDisabled while cordoned (#100); and
//   the Drain dialog's warning (cancelled: a real drain from the GUI would
//   evict the shared demo pods; the CLI drain with --pod-selector is
//   tests/cluster.rs).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, beforeEach, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { deleteNamespace, kubectl, podNames, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import {
  actionBarLabels,
  actionDialogText,
  cell,
  closeMenu,
  contextMenu,
  dialogButton,
  menuItem,
  noticeText,
  openKind,
  setTheme,
  waitActionDialogClosed,
} from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };
/** The kind worker node (nauvi-test-worker): cordoned briefly, never drained. */
const WORKER = (() => {
  try {
    return kubectl(["get", "nodes", "-l", "!node-role.kubernetes.io/control-plane", "-o", "jsonpath={.items[0].metadata.name}"]);
  } catch {
    return "nauvi-test-worker";
  }
})();
const CONFIGMAPS = ["qa-cm-a", "qa-cm-b", "qa-cm-c", "qa-cm-d", "qa-cm-e"];

/** One busybox container, in flow style so it fits at any indentation. */
const container = (cmd) =>
  `containers: [{ name: main, image: "busybox:1.36", imagePullPolicy: IfNotPresent, command: ["sh", "-c", ${JSON.stringify(cmd)}] }]`;

const FIXTURE = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: qa-dep }
spec:
  replicas: 1
  selector: { matchLabels: { app: qa-dep } }
  template:
    metadata: { labels: { app: qa-dep } }
    spec:
      terminationGracePeriodSeconds: 0
      ${container("sleep 3600")}
---
apiVersion: apps/v1
kind: StatefulSet
metadata: { name: qa-sts }
spec:
  replicas: 1
  serviceName: qa-sts
  selector: { matchLabels: { app: qa-sts } }
  template:
    metadata: { labels: { app: qa-sts } }
    spec:
      terminationGracePeriodSeconds: 0
      ${container("sleep 3600")}
---
apiVersion: apps/v1
kind: DaemonSet
metadata: { name: qa-ds }
spec:
  selector: { matchLabels: { app: qa-ds } }
  template:
    metadata: { labels: { app: qa-ds } }
    spec:
      terminationGracePeriodSeconds: 0
      nodeSelector: { kubernetes.io/hostname: ${WORKER} }
      ${container("sleep 3600")}
---
apiVersion: batch/v1
kind: CronJob
metadata: { name: qa-cron }
spec:
  schedule: "0 0 1 1 *"
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          terminationGracePeriodSeconds: 0
          ${container("echo qa-cron ran")}
---
# Ignores SIGTERM and has a long grace period: a Delete leaves it
# Terminating, so Force delete has something to do.
apiVersion: v1
kind: Pod
metadata: { name: qa-stuck, labels: { app: qa-stuck } }
spec:
  terminationGracePeriodSeconds: 600
  ${container("trap '' TERM; while true; do sleep 1; done")}
${CONFIGMAPS.map((n) => `---\napiVersion: v1\nkind: ConfigMap\nmetadata: { name: ${n} }\ndata: { k: v }`).join("\n")}
`;

let ns;
const get = (args, input) => kubectl(["-n", ns, ...args], input);
const uid = (kind, name) => get(["get", kind, name, "-o", "jsonpath={.metadata.uid}"]);

function uncordon() {
  try {
    kubectl(["uncordon", WORKER]);
  } catch (e) {
    console.error(`could not uncordon ${WORKER}: ${e.message}`);
  }
}

describe("area 2: resource actions", { timeout: 20 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-area2-act");
    // A bare pod is refused until the namespace's default ServiceAccount
    // exists; a busy controller-manager can take a while to create it, so
    // create it ourselves if it hasn't appeared after a few seconds.
    for (let i = 0; ; i++) {
      try {
        get(["get", "serviceaccount", "default"]);
        break;
      } catch {
        if (i === 10) {
          try {
            get(["create", "serviceaccount", "default"]);
          } catch {
            /* created meanwhile */
          }
        }
        if (i > 40) throw new Error(`no default ServiceAccount in ${ns}`);
        execFileSync("sleep", ["0.5"]);
      }
    }
    get(["apply", "-f", "-"], FIXTURE);
    get(["rollout", "status", "deploy/qa-dep", "--timeout=180s"]);
    get(["rollout", "status", "sts/qa-sts", "--timeout=180s"]);
    get(["rollout", "status", "ds/qa-ds", "--timeout=180s"]);
    get(["wait", "--for=condition=Ready", "pod/qa-stuck", "--timeout=180s"]);
  });
  after(() => {
    uncordon();
    if (ns) {
      // qa-stuck would hold the namespace for its 600 s grace period.
      try {
        get(["delete", "pod", "qa-stuck", "--grace-period=0", "--force", "--ignore-not-found"]);
      } catch {
        /* gone */
      }
    }
    deleteNamespace(ns);
  });
  const s = appSession("area-2-actions");
  // A test that failed half-way may leave a menu or dialog open: close it,
  // so the next test starts clean.
  beforeEach(async () => {
    if (!s.app) return;
    for (let i = 0; i < 2; i++) {
      const open = await s.app.js(
        "return !!document.querySelector('[data-testid=\"context-menu\"], [data-testid=\"action-dialog\"], [role=\"alertdialog\"]')",
      );
      if (open) await s.app.driver.actions().sendKeys(Key.ESCAPE).perform();
    }
  });

  it("scales a Deployment to 3, then to 0 with a warning; the table follows", T, async () => {
    const { app } = s;
    await waitLive(app);
    await openKind(app, "Deployments", ns, "qa-dep");
    const menu = await contextMenu(app, "qa-dep", ns);
    console.log(`Deployment menu: ${JSON.stringify(menu)}`);
    await menuItem(app, "Scale…");
    const replicas = await app.find(byTestId("action-replicas"));
    assert.equal(await replicas.getAttribute("value"), "1", "the dialog starts at the current replicas");
    await app.setValue(replicas, "3");
    await (await dialogButton(app, "Scale to 3")).click();
    await waitActionDialogClosed(app);
    await app.waitFor(async () => (await cell(app, "qa-dep", "Ready")) === "3/3", {
      timeout: 90_000,
      message: "Ready 3/3 in the table",
    });
    await app.shot("scaled-to-3");

    await contextMenu(app, "qa-dep", ns);
    await menuItem(app, "Scale…");
    await app.setValue(await app.find(byTestId("action-replicas")), "0");
    const text = await app.waitFor(async () => {
      const t = await actionDialogText(app);
      return t?.includes("Scale to 0") ? t : null;
    });
    console.log(`scale-to-0 dialog: ${text}`);
    assert.match(text, /Scaling to 0 stops every pod/);
    await app.shot("scale-to-0-warning");
    await (await dialogButton(app, "Scale to 0")).click();
    await waitActionDialogClosed(app);
    await app.waitFor(async () => (await cell(app, "qa-dep", "Ready")) === "0/0", {
      timeout: 60_000,
      message: "Ready 0/0 in the table",
    });
    assert.equal(get(["get", "deploy", "qa-dep", "-o", "jsonpath={.spec.replicas}"]), "0");
  });

  for (const [label, kind, name, selector] of [
    ["Deployments", "deploy", "qa-dep", "app=qa-dep"],
    ["StatefulSets", "sts", "qa-sts", "app=qa-sts"],
    ["DaemonSets", "ds", "qa-ds", "app=qa-ds"],
  ]) {
    it(`rollout restart of ${kind}/${name} rolls its pods`, { timeout: 360_000 }, async () => {
      const { app } = s;
      if (kind === "deploy") {
        get(["scale", "deploy/qa-dep", "--replicas=1"]);
        get(["rollout", "status", "deploy/qa-dep", "--timeout=120s"]);
      }
      const pods = podNames(ns, selector);
      const uids = pods.map((p) => uid("pod", p));
      assert.ok(pods.length > 0, `${name} has pods`);
      await openKind(app, label, ns, name);
      await contextMenu(app, name, ns);
      await menuItem(app, "Rollout restart");
      // It asks first, from the menu as from Shift+R (#494).
      await (await app.find(byTestId("action-confirm"))).click();
      const notice = await app.waitFor(async () => {
        const t = await noticeText(app);
        return t.includes(`${ns}/${name}`) && /restart/i.test(t) ? t : null;
      }, { message: "the restart notice" });
      console.log(`notice: ${notice}`);
      assert.ok(
        get(["get", kind, name, "-o", "jsonpath={.spec.template.metadata.annotations.kubectl\\.kubernetes\\.io/restartedAt}"]),
        "restartedAt annotation set",
      );
      // The Pods table shows the new pod(s). The rollout itself can be slow
      // on a busy shared cluster: wait for it with kubectl first, then give
      // the table a few seconds to match.
      await openKind(app, "Pods", ns, name);
      get(["rollout", "status", `${kind}/${name}`, "--timeout=240s"]);
      await app.waitFor(
        async () => {
          const now = podNames(ns, selector);
          const nowUids = now.map((p) => uid("pod", p));
          if (nowUids.some((u) => uids.includes(u)) || now.length === 0) return false;
          const rows = (await app.rows()).map(([n]) => n);
          return now.every((p) => rows.includes(p)) && pods.every((p) => !rows.includes(p) || now.includes(p));
        },
        { timeout: 60_000, interval: 1000, message: `${name}'s pods replaced in the table` },
      );
    });
  }

  it("CronJob: Trigger creates an owned manual Job; Suspend and Resume flip Suspend", T, async () => {
    const { app } = s;
    await openKind(app, "CronJobs", ns, "qa-cron");
    const menu = await contextMenu(app, "qa-cron", ns);
    console.log(`CronJob menu: ${JSON.stringify(menu)}`);
    await menuItem(app, "Trigger now");
    await openKind(app, "Jobs", ns, "qa-cron-manual");
    const job = await app.waitFor(async () => (await app.rows()).map(([n]) => n).find((n) => /^qa-cron-manual-[a-z0-9]{5}$/.test(n)), {
      message: "a qa-cron-manual-xxxxx Job in the table",
    });
    const owner = get(["get", "job", job, "-o", "jsonpath={.metadata.ownerReferences[0].kind}/{.metadata.ownerReferences[0].name}"]);
    assert.equal(owner, "CronJob/qa-cron");
    await app.shot("triggered-job");

    await openKind(app, "CronJobs", ns, "qa-cron");
    console.log(`Suspend column before: ${await cell(app, "qa-cron", "Suspend")}`);
    await contextMenu(app, "qa-cron", ns);
    await menuItem(app, "Suspend");
    await app.waitFor(async () => (await cell(app, "qa-cron", "Suspend")) === "true", { message: "Suspend true" });
    await app.shot("suspended");
    await contextMenu(app, "qa-cron", ns);
    await menuItem(app, "Resume");
    await app.waitFor(async () => (await cell(app, "qa-cron", "Suspend")) === "false", { message: "Suspend false" });
  });

  it("Pod: Delete leaves it Terminating, Force delete needs the typed name and removes it", T, async () => {
    const { app } = s;
    await openKind(app, "Pods", ns, "qa-stuck");
    const menu = await contextMenu(app, "qa-stuck", ns);
    console.log(`Pod menu: ${JSON.stringify(menu)}`);
    await menuItem(app, "Delete");
    const text = await app.waitFor(() => actionDialogText(app), { message: "the delete dialog" });
    console.log(`delete dialog: ${text}`);
    assert.match(text, new RegExp(`${ns}/qa-stuck`));
    await (await dialogButton(app, "Delete")).click();
    await waitActionDialogClosed(app);
    await app.waitFor(async () => /Terminating/.test((await cell(app, "qa-stuck", "Status")) ?? ""), {
      timeout: 30_000,
      message: "qa-stuck Terminating in the table",
    });
    await app.shot("terminating");

    await contextMenu(app, "qa-stuck", ns);
    await menuItem(app, "Force delete…");
    const confirm = await app.find(byTestId("action-confirm"));
    assert.equal(await confirm.isEnabled(), false, "Force delete is disabled before typing the name");
    const typed = await app.driver.findElement(By.css('[data-testid="action-dialog"] input.mono'));
    await typed.sendKeys("qa-stu");
    assert.equal(await confirm.isEnabled(), false, "Force delete is disabled with half the name");
    await app.shot("force-delete-half-typed");
    await typed.sendKeys("ck");
    await app.waitFor(() => confirm.isEnabled(), { message: "Force delete enabled" });
    await confirm.click();
    await waitActionDialogClosed(app);
    await app.waitFor(async () => !(await app.rows()).some(([n]) => n === "qa-stuck"), {
      timeout: 30_000,
      message: "qa-stuck gone from the table",
    });
    assert.equal(get(["get", "pod", "qa-stuck", "--ignore-not-found", "-o", "name"]), "");
  });

  it("ConfigMaps: checkbox, shift-click range, header checkbox; a selection's menu only offers bulk delete", T, async () => {
    const { app } = s;
    await openKind(app, "Config Maps", ns, "qa-cm-");
    await app.waitFor(async () => (await app.rows()).length === CONFIGMAPS.length, { message: "5 ConfigMaps" });
    const box = (n) => app.driver.findElement(By.css(`input[aria-label="Select ${n}"]`));
    await (await box("qa-cm-a")).click();
    await app.driver.actions().keyDown(Key.SHIFT).click(await box("qa-cm-c")).keyUp(Key.SHIFT).perform();
    const bar = async () => (await app.find(By.css('[role="toolbar"][aria-label="Selection"]'))).getText();
    await app.waitFor(async () => (await bar()).includes("3 selected"), { message: "3 selected after shift-click" });

    const menu = await contextMenu(app, "qa-cm-b", ns);
    console.log(`menu inside the selection: ${JSON.stringify(menu)}`);
    assert.deepEqual(menu.items, ["Delete 3 selected…"]);
    await app.shot("selection-menu");
    await closeMenu(app);
    const single = await contextMenu(app, "qa-cm-e", ns);
    console.log(`menu outside the selection: ${JSON.stringify(single)}`);
    assert.ok(!single.items.some((i) => /selected/.test(i)), "a row outside the selection gets its own menu");
    await closeMenu(app);

    await (await app.driver.findElement(By.css('input[aria-label="Select all visible rows"]'))).click();
    await app.waitFor(async () => (await bar()).includes("5 selected"), { message: "5 selected after the header checkbox" });
    await (await app.find(By.xpath("//*[@aria-label='Selection']//button[normalize-space()='Delete 5…']"))).click();
    const text = await app.waitFor(() => actionDialogText(app), { message: "the bulk delete dialog" });
    console.log(`bulk dialog: ${text}`);
    for (const n of CONFIGMAPS) assert.ok(text.includes(`${ns}/${n}`), `the dialog lists ${n}`);
    await app.shot("bulk-dialog");
    await (await dialogButton(app, "Delete 5")).click();
    await waitActionDialogClosed(app);
    await app.waitFor(async () => (await app.rows()).length === 0, { message: "the ConfigMaps gone from the table" });
    console.log(`notice: ${await noticeText(app)}`);
    assert.equal(get(["get", "configmap", "-o", "name"]).split("\n").filter((l) => l.includes("qa-cm-")).length, 0);
  });

  it("detail panel buttons match the context menu for Deployment, CronJob, Node and Pod", T, async () => {
    const { app } = s;
    const pod = podNames(ns, "app=qa-dep")[0];
    const cases = [
      ["Deployments", ns, "qa-dep"],
      ["CronJobs", ns, "qa-cron"],
      ["Nodes", "", WORKER],
      ["Pods", ns, pod],
    ];
    const report = [];
    for (const [label, namespace, name] of cases) {
      await app.nav(label);
      if (namespace) await openKind(app, label, namespace, name);
      else await app.filter(name);
      const { items } = await contextMenu(app, name, namespace || undefined);
      await closeMenu(app);
      await app.clickRow(name, namespace || undefined);
      await app.waitFor(async () => (await actionBarLabels(app)).length > 0, { message: `${name}'s action bar` });
      const bar = await actionBarLabels(app);
      report.push(`${label}: menu ${JSON.stringify(items)} / panel ${JSON.stringify(bar)}`);
      await app.shot(`panel-${label}`);
      // The panel's header and the menu come from the same registry (#218):
      // the same items, Edit YAML in both (#494). "Copy prompt for your AI" is the
      // row's alone: it is written from the row's columns.
      for (const b of bar) assert.ok(items.includes(b), `${label}: the menu has "${b}"`);
      for (const i of items.filter((i) => i !== "Copy prompt for your AI")) assert.ok(bar.includes(i), `${label}: the panel lacks "${i}"`);
      assert.ok(items.includes("Copy prompt for your AI"), `${label}: the menu has Copy prompt for your AI`);
      assert.ok(bar.includes("Edit YAML") && items.includes("Edit YAML"), `${label}: both have Edit YAML`);
    }
    console.log(report.join("\n"));
    await app.driver.actions().sendKeys(Key.ESCAPE).perform();
  });

  it("Node: Cordon shows SchedulingDisabled, Uncordon clears it; Drain warns before anything", T, async () => {
    const { app } = s;
    try {
      await app.nav("Nodes");
      await app.filter(WORKER);
      await contextMenu(app, WORKER);
      await menuItem(app, "Cordon");
      await app.waitFor(() => kubectl(["get", "node", WORKER, "-o", "jsonpath={.spec.unschedulable}"]) === "true", {
        message: "the worker unschedulable",
      });
      assert.match(kubectl(["get", "node", WORKER]), /SchedulingDisabled/);
      // #100: the app's table shows it too, like kubectl, in amber.
      const readyCell = () =>
        app.js(`
          const row = [...document.querySelectorAll('[data-testid="resource-table"] [role="row"]')]
            .find((r) => r.innerText.includes(${JSON.stringify(WORKER)}));
          const cell = row && [...row.querySelectorAll('[role="gridcell"]')].find((c) => /^(True|False|Unknown)/.test(c.innerText.trim()));
          return cell ? { text: cell.innerText.trim(), cls: cell.className, fits: cell.scrollWidth <= cell.clientWidth } : null;
        `);
      const cordoned = await app.waitFor(
        async () => {
          const c = await readyCell();
          return c?.text === "True,SchedulingDisabled" ? c : null;
        },
        { message: "the worker's Ready cell to say True,SchedulingDisabled" },
      );
      console.log(`Ready cell while cordoned: ${JSON.stringify(cordoned)}`);
      assert.match(cordoned.cls, /phase-Pending/, "the cordoned node's Ready cell is amber");
      assert.ok(cordoned.fits, "True,SchedulingDisabled fits in the column");
      // Both themes explicitly (CI's system theme is light).
      await setTheme(app, "dark");
      await app.shot("cordoned");
      await setTheme(app, "light");
      await app.shot("cordoned-light");
      await setTheme(app, null);
      await contextMenu(app, WORKER);
      await menuItem(app, "Uncordon");
      await app.waitFor(() => kubectl(["get", "node", WORKER, "-o", "jsonpath={.spec.unschedulable}"]) === "", {
        message: "the worker schedulable again",
      });
      assert.doesNotMatch(kubectl(["get", "node", WORKER]), /SchedulingDisabled/);
      const uncordoned = await app.waitFor(
        async () => {
          const c = await readyCell();
          return c?.text === "True" ? c : null;
        },
        { message: "the worker's Ready cell back to True" },
      );
      assert.doesNotMatch(uncordoned.cls, /phase-/, "an uncordoned, ready node is not coloured");
      await app.shot("uncordoned");
    } finally {
      uncordon();
    }

    await contextMenu(app, WORKER);
    await menuItem(app, "Drain…");
    const text = await app.waitFor(() => actionDialogText(app), { message: "the drain dialog" });
    console.log(`drain dialog: ${text}`);
    await app.shot("drain-dialog");
    await (await dialogButton(app, "Cancel")).click();
    await waitActionDialogClosed(app);
    assert.equal(kubectl(["get", "node", WORKER, "-o", "jsonpath={.spec.unschedulable}"]), "", "Cancel did not cordon");
  });
});

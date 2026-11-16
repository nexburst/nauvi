// Evict one pod through the Eviction API (#300), at 1280x800 in the dark
// and the light theme, on a one-replica Deployment behind a
// PodDisruptionBudget (minAvailable: 1) in a temp namespace:
// - the row menu and the detail panel's action bar offer Evict
// - Evict asks first (the dialog names the pod and mentions the budget)
// - with the budget at minAvailable 1 the eviction is refused: the dialog
//   shows the server's message (naming the budget) and the pod stays
// - with the budget at minAvailable 0, Evict from the action bar evicts it:
//   the panel closes, the notice says so and the Deployment makes a new pod

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, kubectl, runningPodNames, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { setTheme } from "../lib/theme.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";
import {
  actionBarLabels,
  actionDialogText,
  contextMenu,
  dialogButton,
  menuItem,
  noticeText,
  openKind,
  waitActionDialogClosed,
} from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };

const FIXTURE = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: qa-evict }
spec:
  replicas: 1
  selector: { matchLabels: { app: qa-evict } }
  template:
    metadata: { labels: { app: qa-evict } }
    spec:
      terminationGracePeriodSeconds: 0
      containers: [{ name: main, image: "busybox:1.36", imagePullPolicy: IfNotPresent, command: ["sh", "-c", "sleep 3600"] }]
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata: { name: qa-evict }
spec:
  minAvailable: 1
  selector: { matchLabels: { app: qa-evict } }
`;

let ns = "";
let pod = "";
const get = (args, input) => kubectl(["-n", ns, ...args], input);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait until the disruption controller has seen the budget's spec and counted the pod. */
async function waitPdbObserved(healthy) {
  for (let i = 0; i < 90; i++) {
    const [gen, observed, current] = get([
      "get",
      "pdb",
      "qa-evict",
      "-o",
      "jsonpath={.metadata.generation} {.status.observedGeneration} {.status.currentHealthy}",
    ]).split(" ");
    if (gen === observed && current === String(healthy)) return;
    await sleep(1000);
  }
  throw new Error("the PodDisruptionBudget was never observed");
}

async function bothThemes(app, label) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await app.js("return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

before(async () => {
  ns = tempNamespace("qa-evict", FIXTURE);
  get(["rollout", "status", "deploy/qa-evict", "--timeout=180s"]);
  pod = runningPodNames(ns, "app=qa-evict")[0];
  waitPodReady(ns, pod);
  await waitPdbObserved(1);
});
after(() => deleteNamespace(ns));

describe("evict a pod", { timeout: 15 * 60_000 }, () => {
  const s = appSession("evict");

  it("the row menu offers Evict; it asks first", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await openKind(app, "Pods", ns, "qa-evict");
    const menu = await contextMenu(app, pod, ns);
    console.log(`pod menu: ${JSON.stringify(menu)}`);
    assert.ok(menu.items.includes("Evict"), "Evict in the row menu");
    await app.shot("row-menu");
    await menuItem(app, "Evict");
    const text = await app.waitFor(() => actionDialogText(app), { message: "the evict dialog" });
    console.log(`evict dialog: ${text}`);
    assert.match(text, /Evict Pod/);
    assert.match(text, new RegExp(`${ns}/${pod}`));
    assert.match(text, /PodDisruptionBudget/);
    await bothThemes(app, "evict-confirm");
  });

  it("a PodDisruptionBudget block is shown plainly, with the server's message", T, async () => {
    const { app } = s;
    await (await dialogButton(app, "Evict")).click();
    const text = await app.waitFor(
      async () => {
        const t = await actionDialogText(app);
        return t && /Blocked by a PodDisruptionBudget/.test(t) ? t : null;
      },
      { timeout: 30_000, message: "the PDB block in the dialog" },
    );
    console.log(`blocked dialog: ${text}`);
    assert.match(text, /disruption budget qa-evict/, "the server's message names the budget");
    await bothThemes(app, "evict-blocked");
    // The pod is still there and not terminating.
    assert.equal(get(["get", "pod", pod, "-o", "jsonpath={.metadata.deletionTimestamp}"]), "");
    await (await dialogButton(app, "Cancel")).click();
    await waitActionDialogClosed(app);
  });

  it("with the budget allowing it, Evict in the action bar evicts the pod", T, async () => {
    const { app } = s;
    get(["patch", "pdb", "qa-evict", "--type=merge", "-p", '{"spec":{"minAvailable":0}}']);
    await waitPdbObserved(1);
    await app.openDetail("Pods", ns, pod);
    const labels = await app.waitFor(
      async () => {
        const l = await actionBarLabels(app);
        return l.includes("Evict") ? l : null;
      },
      { message: "Evict in the action bar" },
    );
    console.log(`action bar: ${JSON.stringify(labels)}`);
    await bothThemes(app, "action-bar");
    const btn = await app.find(
      By.xpath(`//*[@data-testid='detail-panel']//*[@role='toolbar']//button[normalize-space()=${xq("Evict")}]`),
    );
    await btn.click();
    await app.waitFor(() => actionDialogText(app), { message: "the evict dialog" });
    await (await dialogButton(app, "Evict")).click();
    await waitActionDialogClosed(app, 30_000);
    const notice = await app.waitFor(
      async () => {
        const n = await noticeText(app);
        return n.includes("Evicted") ? n : null;
      },
      { message: "the Evicted notice" },
    );
    console.log(`notice: ${notice}`);
    assert.match(notice, new RegExp(`Evicted Pod/${ns}/${pod}`));
    await app.waitFor(async () => (await app.driver.findElements(byTestId("detail-panel"))).length === 0, {
      message: "the detail panel to close",
    });
    // The Deployment makes a new pod (openDetail filtered on the old name).
    await app.filter("qa-evict");
    await app.waitFor(async () => (await app.rows()).some(([n]) => n !== pod && n.startsWith("qa-evict-")), {
      timeout: 60_000,
      message: "a new qa-evict pod in the table",
    });
    await bothThemes(app, "evicted");
  });
});

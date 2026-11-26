// #468: the screenshots of the landing page (site/) and the docs
// (docs/user/src/img/), taken in the real app against the kind test cluster,
// so no real cluster, namespace or pod name appears. Run it again to refresh
// them for a release:
//
//   QA_SITE_IMG_DIR=$PWD/docs/user/src/img desktop/e2e/qa.sh site-screenshots
//
// Without QA_SITE_IMG_DIR the images go to <artifacts>/site-img/. Each one
// is 1280x800, in the light and the dark theme:
//   overview   the Overview of the whole cluster
//   pods       the Pods table of `demo` (with demo/crashed failing)
//   logs       demo/logger's logs streaming in the dock
//   pod-env    a pod's detail panel with its Environment list open
//   terminal   a shell in that pod's container
// The pod-env and terminal shots use a pod of their own, in a temporary
// `shop-*` namespace; the demo objects are only read.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { ARTIFACTS, xq } from "../lib/app.mjs";
import { deleteNamespace, podNames, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { logLines, openPodLogs, panelButton } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { terminal } from "../lib/terminal.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const OUT = process.env.QA_SITE_IMG_DIR || join(ARTIFACTS, "site-img");

// A small shop: a ConfigMap, a Secret and a pod that reads both.
const SHOP = `
apiVersion: v1
kind: ConfigMap
metadata: { name: checkout-config }
data:
  LOG_LEVEL: info
  REGION: eu-west-1
  PAYMENT_URL: http://payments.shop.svc:8080
---
apiVersion: v1
kind: Secret
metadata: { name: checkout-db }
stringData:
  password: not-a-real-password
---
apiVersion: v1
kind: Pod
metadata:
  name: checkout
  labels: { app: checkout }
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: checkout
      image: busybox:1.36
      command: [sh, -c, "echo checkout ready; sleep 36000"]
      resources:
        requests: { cpu: 50m, memory: 32Mi }
        limits: { memory: 64Mi }
      envFrom:
        - configMapRef: { name: checkout-config }
      env:
        - { name: SERVICE_NAME, value: checkout }
        - name: DB_PASSWORD
          valueFrom: { secretKeyRef: { name: checkout-db, key: password } }
        - name: POD_NAME
          valueFrom: { fieldRef: { fieldPath: metadata.name } }
`;

let shop;

before(() => {
  mkdirSync(OUT, { recursive: true });
  shop = tempNamespace("shop", SHOP);
  waitPodReady(shop, "checkout");
});
after(() => deleteNamespace(shop));

/** Save the window as `<name>-<theme>.png` in OUT. */
async function save(app, name, theme) {
  // Let the last frame (chart animations, the caret) settle.
  await new Promise((r) => setTimeout(r, 800));
  const file = join(OUT, `${name}-${theme}.png`);
  writeFileSync(file, await app.driver.takeScreenshot(), "base64");
  console.log(`saved ${file}`);
}

async function closeAllTabs(app) {
  await app.js(`document.querySelectorAll('[data-testid="dock"] button[aria-label^="Close "]').forEach((b) => b.click())`);
}

for (const theme of ["light", "dark"]) {
  describe(`site screenshots, ${theme} (#468)`, { timeout: 15 * 60_000 }, () => {
    const s = appSession(`site-screenshots-${theme}`);

    it("sets the window and the theme", T, async () => {
      const { app } = s;
      await resizeWindow(app, 1280, 800);
      await waitLive(app);
      await setTheme(app, theme);
      const size = await app.js("return [window.innerWidth, window.innerHeight]");
      assert.ok(size[0] >= 1200, `viewport ${size}`);
    });

    it("overview", T, async () => {
      const { app } = s;
      await app.nav("Overview");
      // The problem pods and the usage need the watches and a metrics sample.
      // demo/crashed is a problem pod only between two of its runs, and its
      // name is in the warning cards too: wait for its problem card, and take
      // the shot only while that card is still there.
      const problemCard = () =>
        app.js(`return [...document.querySelectorAll(".problem")].some((p) => p.innerText.includes("crashed"))`);
      for (let tries = 0; ; tries++) {
        await app.waitFor(problemCard, { timeout: 120_000, message: "demo/crashed among the problem pods" });
        await new Promise((r) => setTimeout(r, 4000));
        if ((await problemCard()) || tries >= 4) break;
      }
      await save(app, "overview", theme);
    });

    it("pods", T, async () => {
      const { app } = s;
      await app.nav("Pods");
      await pickNamespaces(app, ["demo"]);
      await app.find(app.row("crashed", "demo"), { timeout: 30_000 });
      await app.waitFor(async () => (await app.rows()).length >= 4, { message: "the demo pods" });
      // demo/crashed runs for a few seconds between crashes: wait until the
      // table shows it failing, as it does most of the time.
      const crashedRow = () =>
        app.js(`return Array.from(document.querySelectorAll('[data-testid="resource-row"]'))
          .find((r) => r.querySelectorAll('[role="gridcell"]')[1]?.textContent.trim() === "crashed")?.innerText ?? ""`);
      await app.waitFor(async () => !/Running|^$/.test(await crashedRow()), {
        timeout: 120_000,
        interval: 500,
        message: "demo/crashed failing",
      });
      await save(app, "pods", theme);
    });

    it("logs", T, async () => {
      const { app } = s;
      const [logger] = podNames("demo", "app=logger");
      assert.ok(logger, "a demo/logger pod");
      const id = await openPodLogs(app, "demo", logger);
      await app.waitFor(async () => (await logLines(app, id)).length >= 8, {
        timeout: 60_000,
        message: "a few logger lines",
      });
      await app.filter("");
      await save(app, "logs", theme);
      await closeAllTabs(app);
    });

    it("pod-env", T, async () => {
      const { app } = s;
      await app.nav("Pods");
      await pickNamespaces(app, [shop]);
      await app.openDetail("Pods", shop, "checkout");
      await app.filter("");
      const summary = await app.find(
        By.xpath(`//section[@aria-label="Container checkout"]//summary[starts-with(normalize-space(), ${xq("Environment (")})]`),
        { timeout: 30_000 },
      );
      await app.js("arguments[0].scrollIntoView({ block: 'center' }); arguments[0].click()", summary);
      const list = '[data-testid="env-list"]';
      await app.find(By.css(list), { timeout: 30_000 });
      await app.waitFor(async () => !(await app.js(`return document.querySelector('${list}').innerText`)).includes("Loading"), {
        message: "the env values",
        timeout: 30_000,
      });
      // The container card at the top of the panel, its Environment list
      // below the summary.
      await app.js(`const card = document.querySelector('section[aria-label="Container checkout"]');
        card.scrollIntoView({ block: 'start' });
        let p = card.parentElement;
        while (p && !(p.scrollHeight > p.clientHeight && /auto|scroll/.test(getComputedStyle(p).overflowY))) p = p.parentElement;
        p?.scrollBy(0, -56);`);
      const text = await app.js(`return document.querySelector('${list}').innerText`);
      assert.ok(text.includes("eu-west-1"), text);
      assert.ok(!text.includes("not-a-real-password"), "the Secret value stays hidden");
      await save(app, "pod-env", theme);
    });

    it("terminal", T, async () => {
      const { app } = s;
      await panelButton(app, "Shell");
      const term = terminal(app);
      await term.waitForPrompt();
      await term.type('echo "$SERVICE_NAME in $REGION"; ls /');
      await term.waitFor(/checkout in eu-west-1/, { message: "the command's output" });
      await save(app, "terminal", theme);
      await closeAllTabs(app);
    });
  });
}

// "Why it's failing" (#496), at 1280x800 in the dark and the light theme:
// - a pod whose image cannot be pulled (registry.invalid), opened from the
//   Overview's problem pods: the Pods table scrolls its row into view, and
//   the panel leads with "Image … cannot be pulled: host registry.invalid
//   not found" and the newest warning, without scrolling
// - a crash-looping pod: "Container app keeps crashing", the last run's
//   exit code and termination message, and Logs opens the dock on the run
//   that crashed (while it waits to restart, that is the current log)
// - a healthy demo pod has no such block
//
// Its pods live in a temporary namespace, with a Deployment of fillers
// whose names sort first, so the failing rows are below the table's fold.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { logLines } from "../lib/dock.mjs";
import { closePanel, setTheme, waitPanelTitle } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 300_000 };
const WHY = '[data-testid="detail-panel"] [data-testid="pod-why"]';
const PROBLEMS = '.overview section[aria-label="Problem pods"]';

const YAML = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: aaa-filler
spec:
  replicas: 14
  selector: { matchLabels: { app: aaa-filler } }
  template:
    metadata: { labels: { app: aaa-filler } }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: c
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sleep", "3600"]
          resources: { requests: { cpu: 1m, memory: 4Mi } }
---
apiVersion: v1
kind: Pod
metadata:
  name: pull
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: registry.invalid/inventory-api:1.2.3
---
apiVersion: v1
kind: Pod
metadata:
  name: crash
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "echo connecting to the database; echo 'no DB_URL set' > /dev/termination-log; exit 3"]
`;

const frame = (app) =>
  app.driver.executeAsyncScript(
    "const done = arguments[arguments.length - 1]; requestAnimationFrame(() => requestAnimationFrame(() => done()))",
  );

async function shotBoth(app, name) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await frame(app);
    await app.shot(`${name}-${theme}`);
  }
  await setTheme(app, null);
}

/** The block's parts and where it is, or null while it is not there. */
const why = (app) =>
  app.js(`
    const w = document.querySelector('${WHY}');
    if (!w) return null;
    const r = w.getBoundingClientRect();
    const t = (id) => w.querySelector('[data-testid="' + id + '"]')?.textContent.trim() ?? "";
    return {
      headline: t("pod-why-headline"), last: t("pod-why-last"), termination: t("pod-why-termination"),
      warning: t("pod-why-warning"), buttons: Array.from(w.querySelectorAll("button"), (b) => b.textContent.trim()),
      top: r.top, bottom: r.bottom, viewport: innerHeight,
    };`);

/** The selected row of the table, and whether it is wholly inside the table's scroller. */
const selectedRow = (app) =>
  app.js(`
    const row = document.querySelector('[data-testid="resource-row"].selected');
    const sc = document.querySelector('[role="grid"] .scroller');
    if (!row || !sc) return null;
    const r = row.getBoundingClientRect(), s = sc.getBoundingClientRect();
    return { name: (c => c?.getAttribute("aria-label") ?? c?.textContent.trim())(row.querySelectorAll('[role="gridcell"]')[1]), inView: r.top >= s.top - 1 && r.bottom <= s.bottom + 1, top: r.top, scroller: [s.top, s.bottom] };`);

async function openProblem(app, ns, name) {
  await app.nav("Overview");
  const label = `${ns}/${name}`;
  await app.waitFor(
    () =>
      app.js(
        `const b = Array.from(document.querySelectorAll('${PROBLEMS} .problem button')).find((b) => b.textContent.trim() === arguments[0]);
         if (b) b.click();
         return !!b;`,
        label,
      ),
    { timeout: 120_000, interval: 2000, message: `${label} in the problem pods` },
  );
  await waitPanelTitle(app, label);
}

let ns;

describe("why a pod is failing (#496)", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-why", YAML);
    kubectl(["-n", ns, "rollout", "status", "deployment/aaa-filler", "--timeout=180s"]);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("pod-why");

  it("an image that cannot be pulled: the row in view, the reason at the top", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await openProblem(app, ns, "pull");
    const w = await app.waitFor(
      async () => {
        const x = await why(app);
        return x && /cannot be pulled/.test(x.headline) ? x : null;
      },
      { timeout: 120_000, interval: 1000, message: "the pull error in the panel" },
    );
    console.log(JSON.stringify(w, null, 2));
    assert.match(w.headline, /^Image registry\.invalid\/inventory-api:1\.2\.3 cannot be pulled/);
    assert.ok(w.bottom <= w.viewport, "the block shows without scrolling the panel");
    assert.ok(w.buttons.includes("Logs"));
    const row = await app.waitFor(
      async () => {
        const r = await selectedRow(app);
        return r?.inView ? r : null;
      },
      { timeout: 20_000, message: "the selected row in view" },
    );
    console.log(JSON.stringify(row));
    assert.equal(row.name, "pull");
    await shotBoth(app, "pull");
  });

  it("a crash loop: the exit code, the termination message, its logs", T, async () => {
    const { app } = s;
    // Wait for the crash loop itself (a first restart), not just a failed run.
    await app.waitFor(
      () => {
        const r = kubectl(["-n", ns, "get", "pod", "crash", "-o", "jsonpath={.status.containerStatuses[0].restartCount}"]);
        return Number(r) >= 1;
      },
      { timeout: 120_000, interval: 2000, message: "crash restarted once" },
    );
    await openProblem(app, ns, "crash");
    const w = await app.waitFor(
      async () => {
        const x = await why(app);
        return x?.termination && x.headline === "Container app keeps crashing" ? x : null;
      },
      { timeout: 120_000, interval: 1000, message: "the crash in the panel" },
    );
    console.log(JSON.stringify(w, null, 2));
    assert.equal(w.headline, "Container app keeps crashing");
    assert.match(w.last, /^Last run exited with code 3/);
    assert.equal(w.termination, "no DB_URL set");
    assert.ok(w.bottom <= w.viewport, "the block shows without scrolling the panel");
    assert.ok((await selectedRow(app))?.inView, "the selected row in view");
    await shotBoth(app, "crash");

    await app.js(`Array.from(document.querySelectorAll('${WHY} button')).find((b) => b.textContent.trim() === "Logs")?.click()`);
    const id = `logs:${ns}/crash`;
    await app.waitFor(async () => (await logLines(app, id)).some((l) => l.includes("connecting to the database")), {
      timeout: 60_000,
      message: "the crashed run's log",
    });
    await shotBoth(app, "crash-logs");
  });

  it("a healthy pod has no why", T, async () => {
    const { app } = s;
    await closePanel(app);
    await app.nav("Pods");
    await pickNamespaces(app, [ns]);
    const name = kubectl(["-n", ns, "get", "pods", "-l", "app=aaa-filler", "-o", "jsonpath={.items[0].metadata.name}"]);
    await app.filter(name);
    await (await app.find(app.row(name))).click();
    await waitPanelTitle(app, name);
    await app.waitFor(() => app.js(`return !!document.querySelector('[data-testid="detail-panel"] dl.meta')`), {
      message: "the panel's details",
    });
    assert.equal(await why(app), null);
    await app.shot("healthy");
  });
});

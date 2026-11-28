// #605: the Overview fits one screen however big the cluster. Checks, in
// WebKitGTK against kind: the crash-looping pods of one Deployment are one
// Problem group ("6 of 6 pods"), whose events are not in the Warning groups
// and show when the row is expanded; at most five Problem groups and five
// Warning groups, one line each; "See all … problem pods" opens Pods
// filtered to the problems and "See all warnings" Events filtered to
// warnings; the Errors card opens the Pods that need attention; the page
// stays under 1,000 px at 1280x800. Screenshots in the light and dark
// theme, expanded rows, the namespace-scoped view (calm when team-a is)
// and an unreachable cluster.
//
// Everything it creates is in a temporary namespace: a Deployment of 6
// crash-looping pods and 6 crash-looping pods without an owner, so there
// are more groups than the budget.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, describe, it } from "node:test";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { appSession, unreachableKubeconfig, waitLive } from "../lib/qa.mjs";
import { tableData } from "../lib/table.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 300_000 };
const GROUPS = '.overview section[aria-label="Problem groups"]';
const WARNINGS = '.overview section[aria-label="Warning groups"]';

const crashing = (name) => `
      terminationGracePeriodSeconds: 0
      containers:
        - name: app
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "echo ${name} starting; exit 1"]
          resources: { requests: { cpu: 1m, memory: 4Mi } }`;

const YAML = [
  `apiVersion: apps/v1
kind: Deployment
metadata:
  name: crashy
spec:
  replicas: 6
  selector: { matchLabels: { app: crashy } }
  template:
    metadata: { labels: { app: crashy } }
    spec:${crashing("crashy")}`,
  ...Array.from(
    { length: 6 },
    (_, i) => `apiVersion: v1
kind: Pod
metadata:
  name: lone-${i}
spec:${crashing(`lone-${i}`)}`,
  ),
].join("\n---\n");

/** Both themes, then back to the system's. */
async function shotBoth(app, name) {
  for (const theme of ["light", "dark"]) {
    await setTheme(app, theme);
    await app.shot(`${name}-${theme}`);
  }
  await setTheme(app, null);
}

/** The Overview's rows, heights and links, as the page shows them. */
function overviewState(app, ns) {
  return app.js(
    `const ns = arguments[0];
     const rows = Array.from(document.querySelectorAll('${GROUPS} [data-testid="problem-group"]'), (r) => ({
       name: r.querySelector(".name")?.getAttribute("aria-label") ?? "",
       text: r.innerText.replace(/\\s+/g, " ").trim(),
       height: Math.round(r.getBoundingClientRect().height),
       actions: Array.from(r.querySelectorAll(".actions button"), (b) => b.textContent.trim()),
     }));
     const warnings = Array.from(document.querySelectorAll('${WARNINGS} [data-testid="warning-group"]'), (r) => ({
       text: r.innerText.replace(/\\s+/g, " ").trim(),
       height: Math.round(r.getBoundingClientRect().height),
     }));
     const o = document.querySelector(".overview");
     return {
       rows,
       warnings,
       crashyEvents: warnings.filter((w) => w.text.includes("Pod/crashy-")).length,
       count: document.querySelector('[data-testid="problem-groups-count"]')?.textContent.trim() ?? "",
       seeAll: document.querySelector('[data-testid="see-all-problems"]')?.textContent.trim() ?? "",
       seeAllWarnings: !!document.querySelector('[data-testid="see-all-warnings"]'),
       scroll: o?.scrollHeight ?? 0,
       client: o?.clientHeight ?? 0,
       kicker: document.querySelector('[data-testid="deck-kicker"]')?.textContent.trim() ?? "",
       headline: document.querySelector('[data-testid="deck-headline"]')?.textContent.trim() ?? "",
       ns,
     };`,
    ns,
  );
}

const statusFilter = (app) =>
  app.js(
    `return document.querySelector('[data-testid="status-filter"]')?.textContent.replace(/\\s+/g, " ").trim() ?? ""`,
  );
const activeView = (app) =>
  app.js(`return document.querySelector("nav button.active .label")?.textContent.trim() ?? ""`);

describe("Overview: Problem groups and Warning groups (#605)", { timeout: 20 * 60_000 }, () => {
  const s = appSession("overview-groups");
  let ns = "";
  after(() => ns && deleteNamespace(ns));

  it("the pods of one Deployment are one row; the Overview keeps to its budget", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    ns = tempNamespace("qa-605", YAML);
    await app.nav("Overview");
    const crashy = `${ns}/crashy`;
    // Each pod is a Problem pod once its container waits in CrashLoopBackOff
    // (after its first restarts), and the Deployment's row counts all six.
    const got = await app.waitFor(
      async () => {
        const st = await overviewState(app, ns);
        const row = st.rows.find((r) => r.name === crashy);
        return row && /6 of 6 pods/.test(row.text) ? st : null;
      },
      {
        timeout: 240_000,
        interval: 2000,
        message: `${crashy} as one group of 6 crash-looping pods`,
      },
    );
    console.log(JSON.stringify(got, null, 1));
    const row = got.rows.find((r) => r.name === crashy);
    // A crash loop flips between Error and CrashLoopBackOff: still one row.
    assert.match(row.text, /^crashy (Error|CrashLoopBackOff)\b/);
    assert.deepEqual(row.actions, ["Logs", "Describe"], "Logs and Describe on the row, not only on hover");
    assert.ok(got.rows.length <= 5, `at most 5 Problem groups: ${got.rows.length}`);
    assert.ok(got.warnings.length <= 5, `at most 5 Warning groups: ${got.warnings.length}`);
    for (const r of got.rows) assert.ok(r.height <= 41, `a Problem group row is one line: ${r.height}px ${r.text}`);
    for (const w of got.warnings) assert.ok(w.height <= 37, `a Warning group row is one line: ${w.height}px ${w.text}`);
    assert.equal(got.crashyEvents, 0, "the group's BackOff events are not in the Warning groups");
    // 1 Deployment + 6 lone pods + the demo's: more groups than rows.
    assert.ok(Number(got.count) >= 7, `the one count is the groups: ${got.count}`);
    assert.match(got.seeAll, /^See all \d+ problem pods →$/);
    assert.ok(got.scroll <= 1000, `the Overview is ${got.scroll}px high at 1280x800`);
    assert.match(got.kicker, / · all namespaces$/);
    console.log(`#605 Overview scrollHeight ${got.scroll}px (client ${got.client}px), ${got.count} groups`);
    await app.js(`document.querySelector(".overview").scrollTo(0, 0)`);
    await shotBoth(app, "overview-many-problems");
  });

  it("an expanded row shows its pods and their events, without the uid", T, async () => {
    const { app } = s;
    const crashy = `${ns}/crashy`;
    await app.js(
      `document.querySelector('${GROUPS} button[aria-label="Show the pods of ' + arguments[0] + '"]')?.click()`,
      crashy,
    );
    const more = await app.waitFor(
      () =>
        app.js(
          `const r = Array.from(document.querySelectorAll('${GROUPS} [data-testid="problem-group"]'))
             .find((r) => r.querySelector(".name")?.getAttribute("aria-label") === arguments[0]);
           const m = r?.querySelector('[data-testid="problem-group-pods"]');
           return m ? { pods: m.querySelectorAll(".pods li").length, text: m.innerText } : null;`,
          crashy,
        ),
      { timeout: 30_000, message: "the expanded crashy row" },
    );
    console.log(JSON.stringify(more, null, 1));
    assert.equal(more.pods, 6);
    assert.doesNotMatch(more.text, /\([0-9a-f]{8}-[0-9a-f-]{27}\)/, "no name_namespace(uid) in the messages");
    // A warning row expanded too: its message in mono, under the line.
    await app.js(`document.querySelector('${WARNINGS} .row-chev')?.click()`);
    await shotBoth(app, "overview-expanded");
    await app.js(`document.querySelectorAll('.overview .row-chev[aria-expanded="true"]').forEach((b) => b.click())`);
  });

  it("See all opens the Pods that need attention, and Events filtered to warnings", T, async () => {
    const { app } = s;
    await app.js(`document.querySelector('[data-testid="see-all-problems"]').click()`);
    await app.waitFor(async () => (await activeView(app)) === "Pods", {
      message: "the Pods view",
    });
    assert.equal(await statusFilter(app), "Status: needs attention ✕");
    await app.shot("see-all-problem-pods");

    await app.nav("Overview");
    await app.waitFor(() => app.js(`return !!document.querySelector('[data-testid="see-all-warnings"]')`), {
      timeout: 60_000,
      message: "See all warnings",
    });
    await app.js(`document.querySelector('[data-testid="see-all-warnings"]').click()`);
    // Events may be under "N more" in the sidebar: its filter and Type column say it.
    await app.waitFor(async () => (await statusFilter(app)) === "Status: Warning ✕", {
      message: "Events, Status: Warning",
    });
    const rows = await app.waitFor(
      async () => {
        const t = await tableData(app);
        return t?.rows.length ? t.rows : null;
      },
      { timeout: 30_000, message: "warning events in the table" },
    );
    console.log(JSON.stringify(rows.slice(0, 3)));
    for (const r of rows) assert.equal(r.Type, "Warning", `only warnings: ${JSON.stringify(r)}`);
    await app.shot("see-all-warnings");

    await app.nav("Overview");
    // The Overview may still be drawing: click once the card is there.
    await app.waitFor(
      () =>
        app.js(
          `const c = Array.from(document.querySelectorAll(".overview .card")).find((c) => c.querySelector(".label")?.textContent.trim() === "Errors");
           c?.click();
           return !!c;`,
        ),
      { message: "the Errors card" },
    );
    await app.waitFor(async () => (await activeView(app)) === "Pods", {
      message: "the Pods view from Errors",
    });
    assert.equal(await statusFilter(app), "Status: needs attention ✕");
    await app.nav("Overview");
  });
});

const limited = process.env.NAUVI_LIMITED_KUBECONFIG;
describe(
  "Overview of a namespace-scoped user (#605)",
  {
    timeout: 5 * 60_000,
    skip: limited && existsSync(limited) ? false : "set NAUVI_LIMITED_KUBECONFIG (limited-user.sh)",
  },
  () => {
    const s = appSession("overview-groups-limited", { kubeconfig: limited });

    it("names the namespace above the headline; calm when team-a is", T, async () => {
      const { app } = s;
      await resizeWindow(app, 1280, 800);
      await waitLive(app);
      const st = await app.waitFor(
        async () => {
          const o = await overviewState(app, "team-a");
          return o.headline ? o : null;
        },
        { message: "the Overview of team-a" },
      );
      console.log(JSON.stringify(st, null, 1));
      assert.match(st.kicker, / · namespace team-a$/);
      const problems = kubectl(["-n", "team-a", "get", "pods", "-o", "name"]);
      console.log(`team-a pods: ${problems.trim() || "none"}`);
      if (st.rows.length === 0) {
        assert.match(st.headline, /^No problems in /);
        assert.equal(st.seeAll, "");
      }
      await shotBoth(app, "overview-team-a");
    });
  },
);

describe("Overview of an unreachable cluster (#605)", { timeout: 5 * 60_000 }, () => {
  const s = appSession("overview-groups-unreachable", {
    kubeconfig: unreachableKubeconfig(),
  });

  it("says the cluster is out of reach, not a blank page", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    const text = await app.waitFor(
      () => app.js(`return document.querySelector('[data-testid="out-of-reach"]')?.innerText ?? null`),
      { timeout: 90_000, message: "the out-of-reach state" },
    );
    console.log(text);
    await shotBoth(app, "overview-unreachable");
  });
});

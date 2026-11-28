// Checks (#79, #115): Workloads > Overview of one temp namespace, fed live
// on its own channel:
// - a ready Deployment counts as Running, one whose image never pulls as
//   Pending, and the broken one is listed under Problem workloads;
// - live: scaling a new Deployment in and deleting the broken one change
//   the counts and empty the problem list, without a Refresh;
// - switching to an empty namespace starts a new feed: every count 0, and
//   nothing from the old feed shows up afterwards;
// - leaving the view and coming back starts over and is Live again;
// - with many broken Deployments (#606) it fits one screen like the
//   Overview: the deck says how many need a look, five Problem workloads
//   rows of 32 px, "See all N →" opens Deployments filtered to problems,
//   and the Warning groups leave out the listed problems' pods;
// - calm (nothing broken) and empty (an empty namespace) say so.
// Screenshots at 1280x800 in light and dark theme.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A Deployment of `replicas` (JSON is YAML too). */
function deployment(name, image = "busybox:1.36", replicas = 1) {
  return JSON.stringify({
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name },
    spec: {
      replicas,
      selector: { matchLabels: { "qa-wo": name } },
      template: {
        metadata: { labels: { "qa-wo": name } },
        spec: {
          terminationGracePeriodSeconds: 0,
          containers: [{ name: "c", image, imagePullPolicy: "IfNotPresent", command: ["sleep", "3600"] }],
        },
      },
    },
  });
}

/** The view's counts: per kind card, its total and every status count. */
const counts = (app) =>
  app.js(`const out = {};
    for (const c of document.querySelectorAll('[data-testid="workloads-overview"] section.card')) {
      const by = {};
      for (const b of c.querySelectorAll('button[data-status]')) by[b.dataset.status] = Number(b.querySelector('.count')?.textContent ?? 0);
      out[c.dataset.kind] = { total: Number(c.querySelector('.total')?.textContent ?? 0), ...by };
    }
    return out;`);
const problems = (app) =>
  app.js(`return Array.from(document.querySelectorAll('[data-testid="workloads-overview"] .problem'), (p) => p.textContent.replace(/\\s+/g, ' ').trim());`);
const headline = (app) =>
  app.js(`return document.querySelector('[data-testid="workloads-overview"] [data-testid="deck-headline"]')?.textContent.trim() ?? ""`);
/** The extra broken Deployments of the many-problems step. */
const EXTRA = Array.from({ length: 7 }, (_, i) => `broken-${i + 1}`);

/** Light, then dark, then back to the system theme. */
async function shots(app, label) {
  for (const theme of ["light", "dark"]) {
    await setTheme(app, theme);
    await sleep(500); // let WebKitGTK repaint before the shot
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

async function openOverview(app) {
  const button = await app.find(By.css('nav button[aria-label="Workloads overview"]'));
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", button);
  await button.click();
  await app.find(byTestId("workloads-overview"));
}

let ns;
let empty;

describe("workloads overview", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-wo", [deployment("ok"), deployment("broken", "nauvi.invalid/nope:1")].join("\n---\n"));
    empty = tempNamespace("qa-wo-empty");
  });
  after(() => {
    deleteNamespace(ns);
    deleteNamespace(empty);
  });
  const s = appSession("workloads-overview");

  it("counts the namespace's workloads by status and lists the broken one", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    await openOverview(app);
    await pickNamespaces(app, [ns]);
    const c = await app.waitFor(
      async () => {
        const c = await counts(app);
        return c.Deployment?.total === 2 && c.Deployment.Running === 1 && c.Deployment.Pending === 1 ? c : null;
      },
      { timeout: 90_000, message: "2 Deployments: 1 Running, 1 Pending" },
    );
    console.log(JSON.stringify(c));
    const p = await app.waitFor(async () => {
      const p = await problems(app);
      return p.some((t) => t.includes(`${ns}/broken`)) ? p : null;
    }, { timeout: 60_000, message: "broken under Problem workloads" });
    console.log(JSON.stringify(p));
    assert.ok(!p.some((t) => t.includes(`${ns}/ok`)), "the ready Deployment is no problem");
    await waitLive(app);
    await shots(app, "counts");
  });

  it("many broken Deployments: five rows, See all, one screen (#606)", T, async () => {
    const { app } = s;
    kubectl(["-n", ns, "apply", "-f", "-"], EXTRA.map((n) => deployment(n, "nauvi.invalid/nope:1")).join("\n---\n"));
    await app.waitFor(async () => ((await headline(app)) === "8 workloads need a look" ? true : null), {
      timeout: 90_000,
      message: "8 workloads need a look",
    });
    // Give the image pulls time to fail, so the warnings are there too.
    await app
      .waitFor(
        async () =>
          (await app.js(`return document.querySelectorAll('[data-testid="workloads-overview"] [data-testid="warning-group"]').length`)) > 0 || null,
        { timeout: 60_000, message: "a warning group" },
      )
      .catch((e) => console.log(`no warning group yet: ${e.message}`));
    const m = await app.js(`
      const el = document.querySelector('[data-testid="workloads-overview"]');
      const all = (s) => Array.from(el.querySelectorAll(s));
      const h3 = el.querySelector('.sec-head h3');
      return {
        scroll: el.scrollHeight,
        client: el.clientHeight,
        rows: all('[data-testid="problem-workload"]').map((r) => Math.round(r.getBoundingClientRect().height)),
        names: all('[data-testid="problem-workload"] .name').map((n) => n.textContent.trim()),
        warnings: all('[data-testid="warning-group"]').map((w) => w.textContent.replace(/\\s+/g, ' ').trim()),
        seeAll: el.querySelector('[data-testid="see-all-workloads"]')?.textContent.trim() ?? "",
        h3: [getComputedStyle(h3).textTransform, getComputedStyle(h3).fontSize],
        headline: getComputedStyle(el.querySelector('[data-testid="deck-headline"]')).fontSize,
        // The namespace gives way; the workload's name is never cut.
        cut: all('[data-testid="problem-workload"] .nm').filter((n) => {
          const text = document.createRange();
          text.selectNodeContents(n);
          return text.getBoundingClientRect().width > n.getBoundingClientRect().width + 1;
        }).length,
      };`);
    console.log(`#606 many problems: ${JSON.stringify(m)}`);
    console.log(`#606 Workloads overview scrollHeight with 8 broken Deployments at 1280x800: ${m.scroll}px (client ${m.client}px)`);
    assert.ok(m.scroll <= m.client, `fits one screen: ${m.scroll} > ${m.client}`);
    assert.equal(m.rows.length, 5);
    for (const r of m.rows) assert.ok(r >= 31 && r <= 33, `row ${r}px`);
    assert.equal(m.seeAll, "See all 8 →");
    assert.deepEqual(m.h3, ["none", "15px"]);
    assert.equal(m.headline, "26px");
    assert.equal(m.cut, 0, "a workload name is cut");
    assert.ok(m.warnings.length <= 5, `${m.warnings.length} warning groups`);
    // No warning about a listed problem's pods (`<deployment>-<hash>-<id>`).
    for (const name of m.names.map((n) => n.split("/")[1])) {
      const pod = new RegExp(`\\b${name}-[a-z0-9]{6,10}-[a-z0-9]{5}\\b`);
      assert.ok(!m.warnings.some((w) => pod.test(w)), `a warning about a pod of ${name}: ${m.warnings.join(" | ")}`);
    }
    await waitLive(app);
    await shots(app, "many");

    // See all opens Deployments filtered to the problems.
    await (await app.find(byTestId("see-all-workloads"))).click();
    const filter = await app.find(byTestId("status-filter"));
    assert.match(await filter.getText(), /needs attention/);
    await app.shot("see-all");
    kubectl(["-n", ns, "delete", "deployment", ...EXTRA, "--wait=false"]);
    await openOverview(app);
  });

  it("follows the cluster live: a new Deployment and a deleted one", T, async () => {
    const { app } = s;
    kubectl(["-n", ns, "apply", "-f", "-"], deployment("extra", "busybox:1.36", 2));
    await app.waitFor(async () => (await counts(app)).Deployment?.total === 3, {
      timeout: 60_000,
      message: "3 Deployments",
    });
    kubectl(["-n", ns, "delete", "deployment", "broken", "--wait=false"]);
    const c = await app.waitFor(
      async () => {
        const c = await counts(app);
        return c.Deployment?.total === 2 && c.Deployment.Running === 2 && (await problems(app)).length === 0 ? c : null;
      },
      { timeout: 120_000, message: "2 Running Deployments, no problems" },
    );
    console.log(JSON.stringify(c));
    assert.ok(c.Pod.total >= 3, `the pods of ok and extra (${c.Pod.total})`);
    // Calm: nothing needs a look in the namespace.
    assert.match(await headline(app), /^No workload problems/);
    await shots(app, "live");
  });

  it("a namespace switch starts a new feed; the old one stays quiet", T, async () => {
    const { app } = s;
    await pickNamespaces(app, [empty]);
    await app.waitFor(
      async () => {
        const c = await counts(app);
        return Object.values(c).length > 0 && Object.values(c).every((k) => k.total === 0);
      },
      { timeout: 60_000, message: "every count 0" },
    );
    // A change in the old namespace must not reach this view.
    kubectl(["-n", ns, "scale", "deployment", "extra", "--replicas=3"]);
    await sleep(3000);
    const c = await counts(app);
    assert.ok(Object.values(c).every((k) => k.total === 0), `still empty: ${JSON.stringify(c)}`);
    assert.match(await headline(app), /^No workload problems/);
    await waitLive(app);
    await shots(app, "empty");
  });

  it("leaving and coming back starts over, Live", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await pickNamespaces(app, [ns]);
    await openOverview(app);
    await app.waitFor(async () => (await counts(app)).Deployment?.total === 2, {
      timeout: 60_000,
      message: "the namespace's 2 Deployments again",
    });
    await waitLive(app);
    await app.shot("again");
  });
});

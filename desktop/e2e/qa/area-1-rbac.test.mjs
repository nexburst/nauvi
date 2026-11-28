// QA area 1 (#83): a namespace-scoped user (#56, #66, #21 RBAC greying).
// Checks, as the user from scripts/test-cluster/limited-user.sh (`edit` in
// team-a only): the app opens on team-a; Pods and Deployments list and go
// Live; Nodes and the other cluster-scoped kinds are greyed out with a
// reason; the namespace control offers team-a and takes typed names; a
// forbidden namespace says "You can't list … in namespace …" and does not
// retry; All namespaces asks to pick a namespace, without retrying; team-a
// plus a forbidden namespace says "Not allowed in …" for that one only while
// team-a stays live; the Overview shows team-a's pods and events, the notes,
// and no Nodes or Namespaces cards.
//
// Skipped unless NAUVI_LIMITED_KUBECONFIG names that kubeconfig. The pod
// it adds to team-a (with the admin context) has a unique name and is
// deleted afterwards.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { kubectl } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import {
  bannerText,
  closeNamespacePicker,
  namespaceLabel,
  namespaceOptions,
  openNamespacePicker,
  tableData,
} from "../lib/table.mjs";

const T = { timeout: 120_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kubeconfig = process.env.NAUVI_LIMITED_KUBECONFIG;
const skip = kubeconfig && existsSync(kubeconfig) ? false : "set NAUVI_LIMITED_KUBECONFIG (limited-user.sh)";
const FORBIDDEN = "demo";

/**
 * Record the header status from now on. A retry would show "Connecting…"
 * (or "Reconnecting…") again. (Wrapping `__TAURI_INTERNALS__.invoke` to
 * count calls does not work: the bindings keep their own reference.)
 */
function recordWatches(app) {
  return app.js(`
    const el = document.querySelector('[data-testid="connection-status"]');
    window.__qa = { status: [el.textContent] };
    window.__qaObs?.disconnect();
    window.__qaObs = new MutationObserver(() => window.__qa.status.push(el.textContent));
    window.__qaObs.observe(el, { childList: true, characterData: true, subtree: true });
  `);
}

const recorded = (app) => app.js("return window.__qa");

/** Type a namespace into the picker and add it. */
async function addTyped(app, ns) {
  const pop = await openNamespacePicker(app);
  await app.setValue(await pop.findElement(By.css('input[aria-label="Search namespaces"]')), ns);
  await (await app.find(By.xpath(`//*[@aria-label='Namespaces']//button[starts-with(normalize-space(),'Add')]`))).click();
  await closeNamespacePicker(app);
}

/** Untick a namespace in the picker. */
async function untick(app, ns) {
  await openNamespacePicker(app);
  await app.js(
    `const l = Array.from(document.querySelectorAll('[aria-label="Namespace list"] label')).find((l) => l.textContent.trim() === arguments[0]);
     if (l?.querySelector("input").checked) l.querySelector("input").click();`,
    ns,
  );
  await closeNamespacePicker(app);
}

describe("area 1: namespace-scoped user", { timeout: 15 * 60_000, skip }, () => {
  const pod = `qa-area1-live-${Date.now().toString(36)}`;
  after(() => {
    try {
      kubectl(["-n", "team-a", "delete", "pod", pod, "--ignore-not-found", "--wait=false"]);
    } catch (e) {
      console.error(`could not delete team-a/${pod}: ${e.message}`);
    }
  });
  const s = appSession("area-1-rbac", { kubeconfig });

  it("the Overview shows team-a's pods and events, the notes, no Nodes or Namespaces cards", T, async () => {
    const { app } = s;
    await waitLive(app);
    const o = await app.waitFor(
      () =>
        app.js(`
          const cards = Array.from(document.querySelectorAll(".overview .card .label"), (l) => l.textContent.trim());
          if (!cards.length) return null;
          return { cards, notes: document.querySelector(".overview .notes")?.innerText ?? "",
                   warnings: document.querySelector('.overview section[aria-label="Warning groups"] h3')?.textContent.trim() ?? "",
                   text: document.querySelector(".overview").innerText };`),
      { message: "the Overview" },
    );
    console.log(JSON.stringify(o, null, 1));
    assert.ok(o.cards.includes("Pods in team-a"), `cards: ${o.cards}`);
    assert.ok(!o.cards.includes("Namespaces"), "no Namespaces card");
    assert.ok(!o.cards.includes("Nodes ready"), "no Nodes card");
    assert.ok(o.notes.length > 0, "notes say what is not shown");
    assert.equal(o.warnings, "Warning groups in team-a");
  });

  it("Nodes and the other cluster-scoped kinds are greyed out with a reason", T, async () => {
    const { app } = s;
    // Cluster Roles and the like wait under their section's "N more" (#481).
    await app.expandSidebar();
    const nav = await app.waitFor(
      async () => {
        const n = await app.js(
          `return Array.from(document.querySelectorAll("[data-testid=sidebar-kinds] button.kind"), (b) => ({ label: b.querySelector(".label").textContent.trim(), denied: b.classList.contains("denied"), title: b.title }))`,
        );
        return n.find((b) => b.label === "Nodes")?.denied ? n : null;
      },
      { timeout: 30_000, message: "Nodes greyed out" },
    );
    const byLabel = Object.fromEntries(nav.map((b) => [b.label, b]));
    for (const k of ["Nodes", "Namespaces", "Persistent Volumes", "Storage Classes", "Cluster Roles", "Cluster Role Bindings"]) {
      assert.ok(byLabel[k]?.denied, `${k} greyed out`);
      assert.equal(byLabel[k].title, `You are not allowed to list ${k}`);
    }
    for (const k of ["Pods", "Deployments", "Config Maps", "Services"]) assert.ok(!byLabel[k]?.denied, `${k} not greyed`);
    console.log(`greyed: ${nav.filter((b) => b.denied).map((b) => b.label).join(", ")}`);
    // A greyed cluster-scoped kind does not open.
    await app.nav("Nodes");
    await sleep(500);
    assert.doesNotMatch(await app.js(`return document.querySelector("nav button.active")?.textContent ?? ""`), /Nodes/);
  });

  it("opens on team-a; Pods and Deployments list and go Live", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await waitLive(app);
    assert.equal(await namespaceLabel(app), "team-a");
    await app.waitFor(async () => (await tableData(app)).rows.some((r) => r.Namespace === "team-a"), {
      message: "a pod in team-a",
    });
    await app.nav("Deployments");
    await waitLive(app);
    await app.waitFor(async () => (await tableData(app)).rows.some((r) => r.Namespace === "team-a"), {
      message: "a Deployment in team-a",
    });
  });

  it("the namespace control offers team-a and takes typed names", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    const pop = await openNamespacePicker(app);
    const placeholder = await (await pop.findElement(By.css("input"))).getAttribute("placeholder");
    assert.equal(placeholder, "Type a namespace…");
    assert.ok((await namespaceOptions(app)).includes("team-a"));
    await app.setValue(await pop.findElement(By.css("input")), "qa-area1-typed");
    await app.find(By.xpath(`//*[@aria-label='Namespaces']//button[normalize-space()='Add “qa-area1-typed”']`));
    await app.shot("typed-namespace");
    await closeNamespacePicker(app);
  });

  it(`a forbidden namespace says so and does not retry`, T, async () => {
    const { app } = s;
    await addTyped(app, FORBIDDEN);
    await untick(app, "team-a");
    assert.equal(await namespaceLabel(app), FORBIDDEN);
    await app.waitFor(async () => (await app.statusText()) === "Not allowed", { message: 'status "Not allowed"' });
    const banner = await bannerText(app);
    console.log(`banner: ${banner}`);
    assert.match(banner, new RegExp(`You can't list Pods in namespace ${FORBIDDEN}`));
    await recordWatches(app);
    await sleep(20_000);
    const r = await recorded(app);
    console.log(`after 20 s: ${JSON.stringify(r)}`);
    assert.deepEqual([...new Set(r.status)], ["Not allowed"]);
  });

  it("All namespaces asks to pick a namespace, without retrying", T, async () => {
    const { app } = s;
    await openNamespacePicker(app);
    await app.js(`document.querySelector('[aria-label="Namespaces"] .option.all input').click()`);
    await closeNamespacePicker(app);
    assert.equal(await namespaceLabel(app), "All namespaces");
    await app.waitFor(async () => (await app.statusText()) === "Not allowed", { message: 'status "Not allowed"' });
    const banner = await bannerText(app);
    console.log(`banner: ${banner}`);
    assert.match(banner, /across all namespaces\. Pick a namespace you have access to/);
    await recordWatches(app);
    await sleep(20_000);
    const r = await recorded(app);
    console.log(`after 20 s: ${JSON.stringify(r)}`);
    assert.deepEqual([...new Set(r.status)], ["Not allowed"]);
  });

  it(`team-a plus ${FORBIDDEN}: "Not allowed in ${FORBIDDEN}" only, and team-a stays live`, T, async () => {
    const { app } = s;
    await openNamespacePicker(app);
    await app.js(
      `for (const ns of ["team-a", arguments[0]]) {
         const l = Array.from(document.querySelectorAll('[aria-label="Namespace list"] label')).find((l) => l.textContent.trim() === ns);
         if (l && !l.querySelector("input").checked) l.querySelector("input").click();
       }`,
      FORBIDDEN,
    );
    await closeNamespacePicker(app);
    assert.equal(await namespaceLabel(app), "2 namespaces");
    await app.waitFor(async () => (await app.statusText()) === `Not allowed in ${FORBIDDEN}`, {
      message: `status "Not allowed in ${FORBIDDEN}"`,
    });
    const banner = await bannerText(app);
    console.log(`banner: ${banner}`);
    assert.match(banner, new RegExp(`You can't list Pods in namespace ${FORBIDDEN}`));
    assert.doesNotMatch(banner, /in namespace team-a/);
    // team-a is still watched: a new pod there shows up.
    kubectl(["-n", "team-a", "run", pod, "--image=busybox:1.36", "--image-pull-policy=IfNotPresent", "--", "sleep", "600"]);
    await app.waitFor(async () => (await tableData(app)).rows.some((r) => r.Name === pod && r.Namespace === "team-a"), {
      timeout: 30_000,
      message: `team-a/${pod} in the table`,
    });
    await app.shot("team-a-live-demo-forbidden");
  });
});

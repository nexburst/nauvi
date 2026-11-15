// QA area 1 (#83): the header status, the Overview, Refresh and the sidebar.
// Checks (#18, #19): the window opens on the embedded UI; the status goes
// from "Connecting…" to "Live" with a green dot; the Overview cards and pods
// by namespace match kubectl; Refresh reloads the Overview; the context
// select is hidden with a single context; the sidebar switches views; the
// namespace control shows only on namespaced kinds and lists the namespaces.
//
// Only reads the cluster. Other agents may add namespaces and pods at the
// same time, so the kubectl comparison is retried until both sides agree.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { kubectl } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import {
  bannerText,
  closeNamespacePicker,
  namespaceControlVisible,
  namespaceOptions,
  openNamespacePicker,
} from "../lib/table.mjs";

const T = { timeout: 120_000 };

/** What kubectl says: namespace count, nodes ready/total, pods per namespace. */
function clusterSummary() {
  const ns = JSON.parse(kubectl(["get", "ns", "-o", "json"])).items;
  const nodes = JSON.parse(kubectl(["get", "nodes", "-o", "json"])).items;
  const pods = JSON.parse(kubectl(["get", "pods", "-A", "-o", "json"])).items;
  const ready = nodes.filter((n) => n.status.conditions.some((c) => c.type === "Ready" && c.status === "True")).length;
  const byNs = {};
  for (const p of pods) byNs[p.metadata.namespace] = (byNs[p.metadata.namespace] ?? 0) + 1;
  return { namespaces: ns.length, nodes: `${ready}/${nodes.length}`, pods: pods.length, byNs };
}

/** What the Overview shows. */
function overviewSummary(app) {
  return app.js(`
    const cards = Object.fromEntries(Array.from(document.querySelectorAll(".overview .card"), (c) =>
      [c.querySelector(".label")?.textContent.trim(), c.querySelector(".num")?.textContent.trim()]));
    const byNs = {};
    const table = Array.from(document.querySelectorAll('.overview section[aria-label="Problem pods"] table tbody tr'));
    for (const tr of table) byNs[tr.cells[0].textContent.trim()] = Number(tr.cells[1].textContent.trim());
    return { cards, byNs };
  `);
}

describe("area 1: status, Overview, Refresh, sidebar", { timeout: 10 * 60_000 }, () => {
  const s = appSession("area-1-overview");

  it("opens on the embedded UI and goes Live with a green dot", T, async () => {
    const { app } = s;
    // The custom protocol, not a dev server (a connection-refused page otherwise).
    const url = await app.driver.getCurrentUrl();
    console.log(`url: ${url}`);
    assert.doesNotMatch(url, /localhost:1420/);
    assert.ok(await app.find(By.css("header .brand")));
    await waitLive(app);
    const dot = await app.find(By.css("header .dot"));
    assert.match(await dot.getAttribute("class"), /\bok\b/);
    // One context in the kubeconfig: the select is there but hidden.
    const select = await app.driver.findElement(By.css('select[aria-label="Cluster context"]'));
    assert.match(await select.getAttribute("class"), /invisible/);
  });

  it("matches kubectl: namespaces, nodes ready, pods and pods by namespace", T, async () => {
    const { app } = s;
    let last;
    await app.waitFor(
      async () => {
        const want = clusterSummary();
        const got = await overviewSummary(app);
        last = { want, got };
        return (
          Number(got.cards["Namespaces"]) === want.namespaces &&
          got.cards["Nodes ready"] === want.nodes &&
          Number(got.cards["Pods"]) === want.pods &&
          JSON.stringify(Object.entries(got.byNs).sort()) === JSON.stringify(Object.entries(want.byNs).sort())
        );
      },
      { timeout: 60_000, interval: 2000, message: "the Overview to match kubectl" },
    ).catch((e) => {
      throw new Error(`${e.message}\n${JSON.stringify(last, null, 2)}`);
    });
    console.log(JSON.stringify(last.got.cards));
    // The warnings list has entries or says so.
    const warnings = await app.js(
      `return document.querySelector('.overview section[aria-label="Warnings"]')?.innerText ?? ""`,
    );
    assert.match(warnings, /Warnings/);
  });

  it("Refresh reloads the Overview: Connecting… then Live again", T, async () => {
    const { app } = s;
    // Record every status text from now on.
    await app.js(`
      const el = document.querySelector('[data-testid="connection-status"]');
      window.__qaStatus = [el.textContent];
      new MutationObserver(() => window.__qaStatus.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    `);
    await (await app.find(By.xpath("//header//button[normalize-space()='Refresh']"))).click();
    await app.waitFor(async () => (await app.js("return window.__qaStatus")).includes("Connecting…"), {
      message: 'status "Connecting…" after Refresh',
    });
    await waitLive(app);
    const history = await app.js("return window.__qaStatus");
    console.log(`status after Refresh: ${history.join(" -> ")}`);
    assert.equal(history.at(-1), "Live");
    await app.waitFor(async () => Number((await overviewSummary(app)).cards["Pods"]) > 0, {
      message: "Overview cards after Refresh",
    });
  });

  it("the sidebar switches views; the namespace control shows only on namespaced kinds", T, async () => {
    const { app } = s;
    const views = [
      ["Pods", true],
      ["Deployments", true],
      ["Config Maps", true],
      ["Nodes", false],
      ["Namespaces", false],
      ["Overview", false],
    ];
    for (const [label, namespaced] of views) {
      await app.nav(label);
      await app.waitFor(
        async () =>
          (await app.js(`return document.querySelector("nav button.active")?.textContent.trim() ?? ""`)).startsWith(
            label,
          ),
        { message: `${label} active in the sidebar` },
      );
      if (label === "Overview") {
        await app.find(By.css(".overview .card"));
        continue;
      }
      await app.find(By.css(`[data-testid="resource-table"] [role="grid"][aria-label=${JSON.stringify(label)}]`));
      await waitLive(app);
      assert.equal(await namespaceControlVisible(app), namespaced, `namespace control on ${label}`);
    }
  });

  it("the namespace list is populated", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await openNamespacePicker(app);
    const want = kubectl(["get", "ns", "-o", "jsonpath={.items[*].metadata.name}"]).split(/\s+/);
    const options = await app.waitFor(
      async () => {
        const o = await namespaceOptions(app);
        return ["default", "demo", "kube-system"].every((n) => o.includes(n)) ? o : null;
      },
      { message: "default, demo and kube-system in the namespace list" },
    );
    const missing = want.filter((n) => !options.includes(n));
    // Namespaces created in the last seconds may not be there yet.
    assert.ok(missing.length <= 2, `missing from the list: ${missing.join(", ")}`);
    await app.shot("namespace-popover");
    await closeNamespacePicker(app);
  });
});

/** A kubeconfig whose only context points at a closed local port. */
function unreachableKubeconfig() {
  const dir = mkdtempSync(join(tmpdir(), "kubeloupe-qa-area1-"));
  const path = join(dir, "kubeconfig");
  writeFileSync(
    path,
    `apiVersion: v1
kind: Config
clusters:
  - name: nowhere
    cluster:
      server: https://127.0.0.1:1
contexts:
  - name: qa-area1-unreachable
    context:
      cluster: nowhere
      user: nobody
current-context: qa-area1-unreachable
users:
  - name: nobody
    user:
      token: not-a-token
`,
  );
  return path;
}

// #18, #19: a cluster that cannot be reached shows the red status and the
// banner, and the Overview keeps retrying (every 5 s) instead of giving up.
describe("area 1: an unreachable cluster", { timeout: 5 * 60_000 }, () => {
  const s = appSession("area-1-unreachable", { kubeconfig: unreachableKubeconfig() });

  it("shows the red status and the banner, and retries", T, async () => {
    const { app } = s;
    const banner = await app.find(By.css('[role="alert"]'), { timeout: 60_000 });
    const text = await app.js("return arguments[0].innerText", banner);
    console.log(`banner: ${text}; status: ${await app.statusText()}`);
    assert.match(text, /reach|connect/i);
    assert.match(await (await app.find(By.css("header .dot"))).getAttribute("class"), /\berror\b/);
    // Each retry shows "Connecting…" again, then fails.
    await app.js(`
      const el = document.querySelector('[data-testid="connection-status"]');
      window.__qaStatus = [];
      new MutationObserver(() => window.__qaStatus.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    `);
    await app.waitFor(
      async () => (await app.js("return window.__qaStatus")).filter((t) => t === "Connecting…").length >= 2,
      { timeout: 30_000, message: "two more attempts (Connecting… twice)" },
    );
    console.log(`status: ${(await app.js("return window.__qaStatus")).join(" -> ")}`);
    // Still red, still the banner.
    assert.match(await (await app.find(By.css("header .dot"))).getAttribute("class"), /\berror\b/);
    assert.match(await bannerText(app), /reach|connect/i);
  });
});

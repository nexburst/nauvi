// QA area 1 (#83): the header status, the Overview, Refresh and the sidebar.
// Checks (#18, #19): the window opens on the embedded UI; the status goes
// from "Connecting…" to "Live" with a green dot; the Overview cards and pods
// by namespace match kubectl; Refresh reloads the Overview; the context
// select is hidden with a single context; the sidebar switches views; the
// namespace control shows only on namespaced kinds and lists the namespaces.
//
// #263: a running pod whose other container exited with an error reads
// "Error" in the Overview's problem pods, as STATUS does in the Pods table
// (not "Not ready"); light and dark theme.
//
// Reads the cluster, except for that pod, which lives in a temp namespace.
// Other agents may add namespaces and pods at the same time, so the kubectl
// comparison is retried until both sides agree.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import {
  bannerText,
  tableData,
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
    const table = Array.from(document.querySelectorAll('.overview section[aria-label="Pods by namespace"] table tbody tr'));
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
    assert.equal(await app.statusState(), "ok");
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
    // The heading is drawn in capitals.
    assert.match(warnings, /Warnings/i);
  });

  // Running (one container still sleeps), not ready, STATUS "Error".
  const halfFailed = `apiVersion: v1
kind: Pod
metadata:
  name: half-failed
spec:
  restartPolicy: Never
  terminationGracePeriodSeconds: 0
  containers:
    - name: fail
      image: busybox:1.36
      command: ["sh", "-c", "exit 1"]
    - name: app
      image: busybox:1.36
      command: ["sleep", "3600"]
`;
  let ns = "";
  after(() => deleteNamespace(ns));

  it("a running pod whose container failed reads Error in the problem pods and the Pods table (#263)", T, async () => {
    const { app } = s;
    ns = tempNamespace("qa-i263", halfFailed);
    const status = () =>
      JSON.parse(kubectl(["-n", ns, "get", "pod", "half-failed", "-o", "json"])).status?.containerStatuses ?? [];
    await app.waitFor(
      () => status().some((c) => c.name === "fail" && c.state?.terminated) && status().some((c) => c.state?.running),
      { timeout: 90_000, interval: 1000, message: "half-failed: one container exited, one running" },
    );
    await app.nav("Overview");
    const entry = () =>
      app.js(
        `const p = Array.from(document.querySelectorAll('.overview section[aria-label="Problem pods"] .problem'))
           .find((el) => el.querySelector("button, span")?.textContent.trim() === arguments[0]);
         const r = p?.querySelector(".reason");
         return r ? { reason: r.textContent.trim(), error: r.classList.contains("error") } : null;`,
        `${ns}/half-failed`,
      );
    const got = await app.waitFor(entry, { timeout: 60_000, message: `${ns}/half-failed in the problem pods` });
    console.log(`overview problem: ${JSON.stringify(got)}`);
    assert.equal(got.reason, "Error", "the problem text is the pod's STATUS");
    assert.ok(got.error, "shown as an error, like other STATUS problems");
    await app.js(
      `document.querySelector('.overview section[aria-label="Problem pods"]')?.scrollIntoView({ block: "start" })`,
    );
    for (const theme of ["dark", "light"]) {
      await setTheme(app, theme);
      // Until #276's helper is on main: wait for the background to follow.
      await app.waitFor(
        async () => {
          const rgb = await app.js("return getComputedStyle(document.body).backgroundColor");
          const sum = (rgb.match(/\d+/g) ?? []).slice(0, 3).reduce((a, v) => a + Number(v), 0) / 765;
          return theme === "dark" ? sum < 0.2 : sum > 0.8;
        },
        { message: `the ${theme} theme` },
      );
      await app.driver.executeAsyncScript(
        "const done = arguments[arguments.length - 1]; requestAnimationFrame(() => requestAnimationFrame(() => done()))",
      );
      await app.shot(`problem-pods-error-${theme}`);
    }
    await setTheme(app, null);

    // The same text in the Pods table, where the problem pod opens.
    await app.js(
      `Array.from(document.querySelectorAll('.overview section[aria-label="Problem pods"] .problem button'))
         .find((b) => b.textContent.trim() === arguments[0])?.click()`,
      `${ns}/half-failed`,
    );
    const row = await app.waitFor(
      async () => (await tableData(app))?.rows.find((r) => r.Name === "half-failed" && r.Namespace === ns),
      { timeout: 30_000, message: "half-failed in the Pods table" },
    );
    console.log(`pods row: ${JSON.stringify(row)}`);
    assert.equal(row.Status, "Error");
    assert.equal(row._problem, "Error");
    await app.nav("Overview");
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
  const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-area1-"));
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

  it("shows the red status and the banner, and retries", { timeout: 240_000 }, async () => {
    const { app } = s;
    const banner = await app.find(By.css('[role="alert"]'), { timeout: 60_000 });
    const text = await app.js("return arguments[0].innerText", banner);
    console.log(`banner: ${text}; status: ${await app.statusText()}`);
    assert.match(text, /reach|connect/i);
    assert.equal(await app.statusState(), "error");
    // #462: the tree's dot follows the header (red, not green), and the
    // view under the banner says so instead of staying blank.
    const dot = await app.js(
      `return document.querySelector('[data-testid="cluster-node"][data-state="visible"] .dot')?.className ?? ""`,
    );
    assert.match(dot, /failed/, `the shown cluster's dot: ${dot}`);
    const empty = await app.find(By.css('[data-testid="out-of-reach"]'));
    assert.match(await app.js("return arguments[0].innerText", empty), /Cluster unreachable[\s\S]*Retry now/);
    for (const theme of ["light", "dark"]) {
      await setTheme(app, theme);
      await app.shot(`out-of-reach-${theme}`);
    }
    await setTheme(app, null);
    // Each retry shows "Retrying…" (the first attempt said "Connecting…"), then fails.
    await app.js(`
      const el = document.querySelector('[data-testid="connection-status"]');
      window.__qaStatus = [];
      new MutationObserver(() => window.__qaStatus.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
    `);
    await app.waitFor(
      async () => (await app.js("return window.__qaStatus")).filter((t) => t === "Connecting…" || t === "Retrying…").length >= 2,
      // The waits between attempts grow (lib/retry.ts): two of them take up to 100 s.
      { timeout: 150_000, message: "two more attempts (Retrying… twice)" },
    );
    console.log(`status: ${(await app.js("return window.__qaStatus")).join(" -> ")}`);
    // Still red, still the banner.
    assert.equal(await app.statusState(), "error");
    assert.match(await bannerText(app), /reach|connect/i);
  });
});

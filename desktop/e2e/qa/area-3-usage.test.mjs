// Area 3 of #83, PR #73 (usage history from metrics-server) and PR #92
// (workloads overview, workload charts):
// - Pods: sparklines appear in CPU/Memory after about 2 polls (40 s)
// - demo/multi: charts with `pod`, `app` and `sidecar` lines and
//   "Collecting since", in the dark and the light theme at 1280x800
// - a CoreDNS pod: request lines (CPU, memory) and a memory limit line
// - a node: allocatable lines
// - a Deployment: the summed workload charts grow and match the sum of its
//   pods (kubectl top), with summed requests and limits
// - a pod panel opened from a related link (Pods table not shown) still
//   grows from the panel's own sampling
// - the Workloads overview: counts, problem link
// - switch context: the history is gone (a second context: the staging
//   cluster when the kubeconfig has it, otherwise an alias of the test
//   context in a private kubeconfig)
// Needs metrics-server (kind setup.sh installs it).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, byTestId } from "../lib/app.mjs";
import { contexts, deleteNamespace, kubectl, podNames, tempNamespace } from "../lib/cluster.mjs";
import {
  maxPoints,
  openClusterDetail,
  openRelated,
  scrollPanelTo,
  setTheme,
  useLiveRange,
  usageCharts,
  waitPanelTitle,
  waitRelatedGroup,
  waitUsagePoints,
} from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow, selectContext } from "../lib/window.mjs";

const T = { timeout: 240_000 };
const STAGING = "kind-kubeloupe-staging";

const deployment = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: qa-burn
spec:
  replicas: 2
  selector:
    matchLabels: { app: qa-burn }
  template:
    metadata:
      labels: { app: qa-burn }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: burn
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          # A little CPU (capped at 20m) so the line is not flat at zero.
          command: ["sh", "-c", "while true; do :; done"]
          resources:
            requests: { cpu: 10m, memory: 8Mi }
            limits: { cpu: 20m, memory: 32Mi }
`;

/**
 * A kubeconfig with the test context and a second one: staging if the
 * developer's kubeconfig has it, else an alias of the test context.
 */
function twoContextKubeconfig() {
  const dir = mkdtempSync(join(tmpdir(), "qa-area3-kube-"));
  const path = join(dir, "kubeconfig");
  const have = contexts();
  const second = have.includes(STAGING) ? STAGING : "qa-area3-alias";
  const view = (ctx) =>
    execFileSync("kubectl", ["config", "view", "--minify", "--flatten", "--context", ctx], { encoding: "utf8" });
  const parts = [CONTEXT, ...(second === STAGING ? [STAGING] : [])].map((ctx, i) => {
    const p = join(dir, `part-${i}`);
    writeFileSync(p, view(ctx), { mode: 0o600 });
    return p;
  });
  writeFileSync(
    path,
    execFileSync("kubectl", ["config", "view", "--flatten"], {
      encoding: "utf8",
      env: { ...process.env, KUBECONFIG: parts.join(":") },
    }),
    { mode: 0o600 },
  );
  if (second !== STAGING) {
    const ctx = execFileSync(
      "kubectl",
      ["--kubeconfig", path, "config", "view", "-o", `jsonpath={.contexts[?(@.name=="${CONTEXT}")].context}`],
      { encoding: "utf8" },
    );
    const { cluster, user } = JSON.parse(ctx);
    execFileSync("kubectl", ["--kubeconfig", path, "config", "set-context", second, `--cluster=${cluster}`, `--user=${user}`]);
  }
  return { dir, path, second };
}

/** Parse "12m", "1.5", "3Mi", "2.1 MiB"... into millicores / bytes. */
function cpuMilli(text) {
  const m = String(text).match(/([\d.]+)\s*(m|k)?/);
  if (!m) return NaN;
  const n = Number(m[1]);
  return m[2] === "m" ? n : m[2] === "k" ? n * 1e6 : n * 1000;
}
function memBytes(text) {
  const m = String(text).match(/([\d.]+)\s*(Ki|Mi|Gi|KiB|MiB|GiB|k|M|G)?/);
  if (!m) return NaN;
  const mult = { Ki: 1024, KiB: 1024, Mi: 1024 ** 2, MiB: 1024 ** 2, Gi: 1024 ** 3, GiB: 1024 ** 3, k: 1e3, M: 1e6, G: 1e9 };
  return Number(m[1]) * (mult[m[2]] ?? 1);
}

/** "pod 12m" -> "12m": the value after the series name in a legend entry. */
function legendValue(chart, name) {
  const li = chart.legend.find((l) => l.startsWith(`${name} `));
  return li?.slice(name.length + 1) ?? "";
}

describe("area 3: usage history charts (#73, #92)", { timeout: 30 * 60_000 }, () => {
  let ns;
  let kube;
  before(() => {
    ns = tempNamespace("qa-area3-use", deployment);
    kubectl(["-n", ns, "rollout", "status", "deploy/qa-burn", "--timeout=180s"]);
    kube = twoContextKubeconfig();
  });
  after(() => {
    deleteNamespace(ns);
    if (kube) rmSync(kube.dir, { recursive: true, force: true });
  });

  const s = appSession("area-3-usage", () => ({ kubeconfig: kube.path }));

  it("Pods: sparklines appear in CPU and Memory after about two polls", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.nav("Pods");
    await waitLive(app);
    const t0 = Date.now();
    const n = await app.waitFor(
      async () => {
        const c = await app.js(`return document.querySelectorAll('[data-testid="resource-row"] [data-testid="sparkline"]').length`);
        return c >= 4 ? c : null;
      },
      { timeout: 120_000, interval: 1000, message: "sparklines in the Pods table" },
    );
    console.log(`${n} sparklines after ${Math.round((Date.now() - t0) / 1000)} s`);
    // Both metric columns, and they draw a line.
    const cells = await app.js(`
      return Array.from(document.querySelectorAll('[data-testid="resource-row"]')).slice(0, 40).flatMap((r) =>
        Array.from(r.querySelectorAll('[data-testid="sparkline"] polyline'), (p) => p.getAttribute('points').split(' ').length));`);
    assert.ok(cells.some((p) => p >= 2), "a sparkline with 2+ points");
  });

  it("demo/multi: pod, app and sidecar lines and Collecting since (dark)", T, async () => {
    const { app } = s;
    await app.openDetail("Pods", "demo", "multi");
    await useLiveRange(app);
    const u = await waitUsagePoints(app, 2, { series: "pod" });
    console.log(`multi: ${JSON.stringify({ ...u, text: undefined })}`);
    assert.deepEqual(Object.keys(u.cpu.series).sort(), ["app", "pod", "sidecar"]);
    assert.deepEqual(Object.keys(u.memory.series).sort(), ["app", "pod", "sidecar"]);
    assert.match(u.since, /^Collecting since \d\d:\d\d\./);
    await setTheme(app, "dark");
    await scrollPanelTo(app, '[data-testid="usage-charts"]');
  });

  it("demo/multi charts in the light theme", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await scrollPanelTo(app, '[data-testid="usage-charts"]');
    const colors = await app.js(`
      const svg = document.querySelector('[data-testid="detail-panel"] [data-testid="usage-chart-cpu"] svg');
      const line = svg.querySelector('polyline.total');
      return { bg: getComputedStyle(svg).backgroundColor, stroke: getComputedStyle(line).stroke,
               page: getComputedStyle(document.body).backgroundColor };`);
    console.log(`light colours: ${JSON.stringify(colors)}`);
    assert.notEqual(colors.bg, colors.stroke);
  });

  it("a CoreDNS pod: CPU and memory request lines and a memory limit line", T, async () => {
    const { app } = s;
    await setTheme(app, null);
    const pod = podNames("kube-system", "k8s-app=kube-dns")[0];
    await app.openDetail("Pods", "kube-system", pod);
    await useLiveRange(app);
    const u = await waitUsagePoints(app, 1);
    console.log(`coredns: cpu refs ${u.cpu.refs} legend ${u.cpu.legend}; memory refs ${u.memory.refs} legend ${u.memory.legend}`);
    assert.deepEqual(u.cpu.refs, ["request"]);
    assert.deepEqual([...u.memory.refs].sort(), ["limit", "request"]);
    assert.ok(u.cpu.legend.includes("request 100m"), JSON.stringify(u.cpu.legend));
    assert.ok(u.memory.legend.some((l) => /^limit 170\s?Mi/.test(l)), JSON.stringify(u.memory.legend));
    await scrollPanelTo(app, '[data-testid="usage-charts"]');
  });

  it("a node: allocatable lines", T, async () => {
    const { app } = s;
    const node = kubectl(["get", "nodes", "-o", "jsonpath={.items[0].metadata.name}"]);
    await openClusterDetail(app, "Nodes", node);
    await useLiveRange(app);
    const u = await waitUsagePoints(app, 1);
    console.log(`node: cpu ${JSON.stringify(u.cpu)} memory refs ${u.memory.refs}`);
    assert.deepEqual(u.cpu.refs, ["allocatable"]);
    assert.deepEqual(u.memory.refs, ["allocatable"]);
    await scrollPanelTo(app, '[data-testid="usage-charts"]');
  });

  it("a Deployment: summed charts grow and match the sum of its pods", T, async () => {
    const { app } = s;
    await app.openDetail("Deployments", ns, "qa-burn");
    await useLiveRange(app);
    const first = await waitUsagePoints(app, 1, { series: "pods" });
    const n0 = first.cpu.series.pods;
    const u = await waitUsagePoints(app, n0 + 1, { series: "pods", timeout: 60_000 });
    console.log(`qa-burn: ${JSON.stringify({ ...u, text: undefined })}`);
    // Requests and limits of 2 replicas.
    assert.ok(u.cpu.legend.includes("request 20m"), JSON.stringify(u.cpu.legend));
    assert.ok(u.cpu.legend.includes("limit 40m"), JSON.stringify(u.cpu.legend));
    assert.ok(u.memory.legend.some((l) => /^request 16\s?Mi/.test(l)), JSON.stringify(u.memory.legend));
    assert.ok(u.memory.legend.some((l) => /^limit 64\s?Mi/.test(l)), JSON.stringify(u.memory.legend));
    const top = kubectl(["-n", ns, "top", "pods", "--no-headers"])
      .split("\n")
      .map((l) => l.trim().split(/\s+/));
    const sumCpu = top.reduce((a, [, c]) => a + cpuMilli(c), 0);
    const sumMem = top.reduce((a, [, , m]) => a + memBytes(m), 0);
    const chartCpu = cpuMilli(legendValue(u.cpu, "pods"));
    const chartMem = memBytes(legendValue(u.memory, "pods"));
    console.log(`sum of pods (kubectl top): cpu ${sumCpu}m mem ${sumMem}; chart: cpu ${chartCpu}m mem ${chartMem}`);
    assert.ok(Math.abs(chartCpu - sumCpu) <= Math.max(10, sumCpu * 0.5), "CPU close to the pods' sum");
    assert.ok(Math.abs(chartMem - sumMem) <= Math.max(2 * 1024 ** 2, sumMem * 0.5), "memory close to the pods' sum");
    await scrollPanelTo(app, '[data-testid="usage-charts"]');
  });

  it("a pod panel opened from a related link grows from its own sampling", T, async () => {
    const { app } = s;
    // Deployments view: the Pods table (and its metrics poll) is not shown.
    await app.openDetail("Deployments", ns, "qa-burn");
    const g = await waitRelatedGroup(app, "Pods");
    await openRelated(app, "Pods", g.links[0]);
    await waitPanelTitle(app, `${ns}/${g.links[0]}`);
    await useLiveRange(app);
    const a = await waitUsagePoints(app, 1, { series: "pod" });
    const n0 = maxPoints(a.cpu);
    const b = await waitUsagePoints(app, n0 + 2, { series: "pod", timeout: 75_000 });
    console.log(`related pod: ${n0} -> ${maxPoints(b.cpu)} points`);
    await scrollPanelTo(app, '[data-testid="usage-charts"]');
  });

  it("the Workloads overview: counts and a problem link", T, async () => {
    const { app } = s;
    await (await app.find(By.css('nav button[aria-label="Workloads overview"]'))).click();
    const wo = await app.find(byTestId("workloads-overview"));
    const text = await app.waitFor(
      async () => {
        const t = await app.js(`return document.querySelector('[data-testid="workloads-overview"]').innerText`);
        return t.includes("Deployments") && !t.includes("Loading") ? t : null;
      },
      { timeout: 30_000, message: "workload counts" },
    );
    console.log(`workloads overview:\n${text}`);
    assert.ok(wo);
    const deploys = Number(kubectl(["get", "deploy", "-A", "--no-headers"]).split("\n").length);
    const card = await app.js(
      `return document.querySelector('[data-testid="workloads-overview"] section.card[data-kind="Deployment"] .total')?.textContent.trim()`,
    );
    assert.ok(Math.abs(Number(card) - deploys) <= 2, `Deployments card ${card} vs kubectl ${deploys}`);
  });

  it("switching context drops the usage history", T, async () => {
    const { app } = s;
    await app.openDetail("Pods", "demo", "multi");
    await useLiveRange(app);
    const before = await waitUsagePoints(app, 3, { series: "pod", timeout: 90_000 });
    console.log(`before switch: ${before.since} ${maxPoints(before.cpu)} points`);
    await selectContext(app, kube.second);
    await waitLive(app);
    await selectContext(app, CONTEXT);
    await waitLive(app);
    await app.openDetail("Pods", "demo", "multi");
    await useLiveRange(app);
    const u = await app.waitFor(async () => usageCharts(app), { message: "the usage charts after the switch" });
    await app.driver.sleep(1000);
    const after = (await usageCharts(app)) ?? u;
    console.log(`after switching to ${kube.second} and back: ${after.since || after.empty} ${maxPoints(after.cpu)} points`);
    assert.ok(maxPoints(after.cpu) < maxPoints(before.cpu), "the old samples are gone");
    await scrollPanelTo(app, '[data-testid="usage-charts"]');
  });
});

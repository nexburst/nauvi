// The detail panel's sticky header of action icons (#218), at 1280x800 in
// the dark and the light theme:
// - a pod: Logs, Shell, Port forward, Attach, Debug, Edit, Delete, Force
//   delete; Shell and Logs open dock tabs; the header stays at the top while
//   the panel scrolls; Edit brings the YAML editor into view; the tooltip
//   and the arrow keys work from the keyboard
// - a Deployment: Logs, Scale, Rollout restart; Edit opens the YAML tab
// - a Node: Shell, Cordon, Uncordon, Drain (nothing is run on it)
// - a view-only ServiceAccount (made here): Logs offered; Shell, Attach,
//   Edit, Delete... greyed with "Not allowed: you can't ..." and inert
// - the limited user (limited-user.sh, `edit` in team-a): nothing greyed
//   in team-a but Debug where `edit` lacks pods/ephemeralcontainers. Skipped without NAUVI_LIMITED_KUBECONFIG.
// Everything lives in a temp namespace.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { CONTEXT } from "../lib/app.mjs";
import { deleteNamespace, kubectl, podNames, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { pane } from "../lib/dock.mjs";
import { closePanel, openClusterDetail, setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const BAR = '[data-testid="detail-panel"] [role="toolbar"][aria-label="Actions"]';
const WORKER = (() => {
  try {
    return kubectl(["get", "nodes", "-l", "!node-role.kubernetes.io/control-plane", "-o", "jsonpath={.items[0].metadata.name}"]);
  } catch {
    return "nauvi-test-worker";
  }
})();

const fixtures = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: qa-act
spec:
  replicas: 1
  selector:
    matchLabels: { app: qa-act }
  template:
    metadata:
      labels: { app: qa-act }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: app
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "while true; do echo tick; sleep 2; done"]
---
apiVersion: v1
kind: ServiceAccount
metadata:
  name: qa-viewer
`;

/** The header's buttons: label, greyed by RBAC (and why), disabled, icon size. */
function bar(app) {
  return app.js(`
    return Array.from(document.querySelectorAll('${BAR} button'), (b) => {
      const svg = b.querySelector('svg')?.getBoundingClientRect();
      const why = b.getAttribute('aria-describedby');
      return {
        label: b.textContent.trim(),
        denied: b.getAttribute('aria-disabled') === 'true',
        reason: why ? document.getElementById(why)?.textContent ?? '' : '',
        disabled: b.disabled,
        icon: svg ? Math.round(svg.width) : 0,
      };
    });`);
}

function waitBar(app, labels) {
  return app.waitFor(
    async () => {
      const b = await bar(app);
      return JSON.stringify(b.map((x) => x.label)) === JSON.stringify(labels) ? b : null;
    },
    { message: `the action header ${JSON.stringify(labels)}` },
  );
}

/** The tooltip's text, or null. */
function tipText(app) {
  return app.js(`return document.querySelector('[data-testid="action-tip"]')?.innerText.trim() ?? null`);
}

async function headerButton(app, label) {
  return app.find(By.xpath(`//*[@data-testid='detail-panel']//*[@role='toolbar']//button[normalize-space()='${label}']`));
}

/** Focus a header button the way Tab would (the tooltip follows the focus). */
function focusButton(app, label) {
  return app.js(
    `Array.from(document.querySelectorAll('${BAR} button')).find((b) => b.textContent.trim() === arguments[0]).focus()`,
    label,
  );
}

async function bothThemes(app, label) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await app.js("return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

const POD_LABELS = ["Logs", "Shell", "Port forward…", "Attach", "Debug…", "Edit", "Copy link", "Evict", "Delete", "Force delete…"];

let ns = "";
let pod = "";
before(() => {
  ns = tempNamespace("qa-actions", fixtures);
  kubectl(["-n", ns, "rollout", "status", "deploy/qa-act", "--timeout=180s"]);
  pod = podNames(ns, "app=qa-act")[0];
  waitPodReady(ns, pod);
  kubectl(["-n", ns, "create", "rolebinding", "qa-viewer", "--clusterrole=view", `--serviceaccount=${ns}:qa-viewer`]);
});
after(() => deleteNamespace(ns));

describe("detail panel action header (admin)", { timeout: 15 * 60_000 }, () => {
  const s = appSession("detail-actions");

  it("pod: every action has an icon, nothing greyed; dark and light", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.openDetail("Pods", ns, pod);
    await app.find(By.xpath("//*[@data-testid='detail-panel']//h3[normalize-space()='Containers']"), { timeout: 30_000 });
    const b = await waitBar(app, POD_LABELS);
    console.log(`pod header: ${JSON.stringify(b)}`);
    assert.ok(b.every((x) => x.icon === 16), "every button shows a 16px icon");
    assert.ok(b.every((x) => !x.denied && !x.disabled), "nothing greyed for the admin");
    const text = await app.js(`return document.querySelector('[data-testid="detail-panel"]').innerText`);
    assert.ok(!text.includes("Logs and shell"), "the old Logs and shell block is gone");
    await bothThemes(app, "pod-panel");
  });

  it("pod: the tooltip follows the keyboard; arrows move along the header", T, async () => {
    const { app } = s;
    await focusButton(app, "Logs");
    await app.waitFor(async () => (await tipText(app)) === "Logs", { message: 'the "Logs" tooltip' });
    await app.driver.actions().sendKeys(Key.ARROW_RIGHT).perform();
    await app.waitFor(async () => (await tipText(app)) === "Shell", { message: 'the "Shell" tooltip after ArrowRight' });
    const focused = await app.js("return document.activeElement?.textContent.trim()");
    assert.equal(focused, "Shell");
    await focusButton(app, "Force delete…");
    await app.waitFor(async () => (await tipText(app)) === "Force delete", { message: "the last tooltip" });
    // The last button's tooltip stays inside the panel.
    const fits = await app.js(`
      const p = document.querySelector('[data-testid="detail-panel"]').getBoundingClientRect();
      const t = document.querySelector('[data-testid="action-tip"]').getBoundingClientRect();
      return t.left >= p.left && t.right <= p.right;`);
    assert.ok(fits, "the tooltip fits in the panel");
    await bothThemes(app, "pod-tooltip");
    await app.js("document.activeElement?.blur()");
  });

  it("pod: Shell and Logs open dock tabs", T, async () => {
    const { app } = s;
    await (await headerButton(app, "Shell")).click();
    await app.find(By.css(pane(`shell:${ns}/${pod}`)), { timeout: 30_000 });
    await (await headerButton(app, "Logs")).click();
    await app.find(By.css(pane(`logs:${ns}/${pod}`)), { timeout: 30_000 });
    await app.waitFor(
      async () => (await app.js(`return document.querySelector('[data-testid="dock"]')?.innerText ?? ""`)).includes("tick"),
      { timeout: 30_000, message: '"tick" in the log tab' },
    );
  });

  it("pod: Edit scrolls to the YAML editor and the header stays on top", T, async () => {
    const { app } = s;
    await (await headerButton(app, "Edit")).click();
    const pos = await app.waitFor(
      async () => {
        const r = await app.js(`
          const p = document.querySelector('[data-testid="detail-panel"]');
          const bar = document.querySelector('${BAR}').getBoundingClientRect();
          const ed = p.querySelector('[data-testid="yaml-editor"]')?.getBoundingClientRect();
          const top = p.getBoundingClientRect();
          return { scroll: p.scrollTop, barTop: bar.top - top.top, edTop: ed ? ed.top - top.top : -1, height: top.height };`);
        return r.scroll > 0 && r.edTop >= 0 && r.edTop < r.height ? r : null;
      },
      { message: "the YAML editor in view" },
    );
    console.log(`after Edit: ${JSON.stringify(pos)}`);
    assert.ok(pos.barTop < 60, "the header stays at the top of the scrolled panel");
    await bothThemes(app, "pod-edit-scrolled");
  });

  it("Deployment: Logs, Scale, Rollout restart; Edit opens the YAML tab", T, async () => {
    const { app } = s;
    await app.openDetail("Deployments", ns, "qa-act");
    const b = await waitBar(app, ["Logs", "Scale…", "Rollout restart", "Port forward…", "Edit", "Copy link", "Delete"]);
    assert.ok(b.every((x) => x.icon === 16 && !x.denied));
    await bothThemes(app, "deployment-panel");
    await (await headerButton(app, "Edit")).click();
    await app.find(By.css('[data-testid="detail-panel"] .cm-content'), { timeout: 20_000 });
    const selected = await app.js(
      `return document.querySelector('[data-testid="detail-panel"] [role="tab"][aria-selected="true"]')?.textContent.trim()`,
    );
    assert.equal(selected, "YAML");
  });

  it("Node: Shell, Cordon, Uncordon, Drain", T, async () => {
    const { app } = s;
    await closePanel(app);
    await openClusterDetail(app, "Nodes", WORKER);
    const b = await waitBar(app, ["Shell", "Cordon", "Uncordon", "Edit", "Copy link", "Drain…", "Delete"]);
    assert.ok(b.every((x) => x.icon === 16 && !x.denied));
    await focusButton(app, "Drain…");
    await app.waitFor(async () => (await tipText(app)) === "Drain", { message: 'the "Drain" tooltip' });
    await bothThemes(app, "node-panel");
    await app.js("document.activeElement?.blur()");
  });
});

/** A kubeconfig for `sa` in `namespace` on the test cluster, with a short-lived token. */
function serviceAccountKubeconfig(namespace, sa) {
  const token = kubectl(["-n", namespace, "create", "token", sa, "--duration=1h"]);
  const server = kubectl(["config", "view", "--raw", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"]);
  const ca = kubectl(["config", "view", "--raw", "--minify", "-o", "jsonpath={.clusters[0].cluster.certificate-authority-data}"]);
  const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-viewer-"));
  const path = join(dir, "kubeconfig");
  const yaml = `apiVersion: v1
kind: Config
current-context: qa-viewer
clusters:
  - name: ${CONTEXT}
    cluster:
      server: ${server}
      certificate-authority-data: ${ca}
users:
  - name: qa-viewer
    user:
      token: ${token}
contexts:
  - name: qa-viewer
    context:
      cluster: ${CONTEXT}
      user: qa-viewer
      namespace: ${namespace}
`;
  writeFileSync(path, yaml, { mode: 0o600 });
  return path;
}

describe("detail panel action header (view-only user)", { timeout: 10 * 60_000 }, () => {
  const s = appSession("detail-actions-viewer", () => ({ kubeconfig: serviceAccountKubeconfig(ns, "qa-viewer") }));

  it("pod: Logs offered; Shell, Attach, Edit, Delete greyed with the reason", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.openDetail("Pods", ns, pod);
    const b = await app.waitFor(
      async () => {
        const list = await bar(app);
        return list.some((x) => x.denied) ? list : null;
      },
      { timeout: 30_000, message: "greyed actions" },
    );
    console.log(`viewer header: ${JSON.stringify(b)}`);
    const by = Object.fromEntries(b.map((x) => [x.label, x]));
    assert.equal(by.Logs.denied, false, "view may read logs");
    for (const l of ["Shell", "Attach", "Debug…", "Port forward…", "Edit", "Evict", "Delete", "Force delete…"]) {
      assert.equal(by[l].denied, true, `${l} greyed`);
      assert.match(by[l].reason, /^Not allowed: you can't /, `${l} says why`);
    }
    assert.equal(by.Shell.reason, `Not allowed: you can't create pods/exec in namespace ${ns}`);
    await focusButton(app, "Shell");
    await app.waitFor(async () => (await tipText(app))?.includes("pods/exec"), { message: "the reason in the tooltip" });
    await bothThemes(app, "viewer-pod-greyed");
  });

  it("a greyed Shell and Delete do nothing", T, async () => {
    const { app } = s;
    await app.js(`Array.from(document.querySelectorAll('${BAR} button'))
      .filter((b) => ['Shell', 'Delete'].includes(b.textContent.trim())).forEach((b) => b.click())`);
    await new Promise((r) => setTimeout(r, 1000));
    const opened = await app.js(
      `return { shell: !!document.querySelector(arguments[0]), dialog: !!document.querySelector('[data-testid="action-dialog"]') }`,
      pane(`shell:${ns}/${pod}`),
    );
    assert.deepEqual(opened, { shell: false, dialog: false });
    await app.js("document.activeElement?.blur()");
  });

  it("Deployment: Logs offered; Scale and Rollout restart greyed", T, async () => {
    const { app } = s;
    await app.openDetail("Deployments", ns, "qa-act");
    const b = await app.waitFor(
      async () => {
        const list = await bar(app);
        return list.some((x) => x.denied) ? list : null;
      },
      { timeout: 30_000, message: "greyed actions" },
    );
    const by = Object.fromEntries(b.map((x) => [x.label, x]));
    assert.equal(by.Logs.denied, false);
    assert.equal(by["Scale…"].reason, `Not allowed: you can't patch deployments/scale.apps in namespace ${ns}`);
    assert.equal(by["Rollout restart"].denied, true);
    await bothThemes(app, "viewer-deployment-greyed");
  });
});

const limited = process.env.NAUVI_LIMITED_KUBECONFIG;
const skipLimited =
  limited && existsSync(limited) ? false : "set NAUVI_LIMITED_KUBECONFIG (limited-user.sh)";

describe("detail panel action header (limited user, edit in team-a)", { timeout: 10 * 60_000, skip: skipLimited }, () => {
  const s = appSession("detail-actions-limited", { kubeconfig: limited });

  it("team-a/hello's pod: every action offered", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.nav("Pods");
    const name = await app.waitFor(
      async () => (await app.rows()).find((r) => r.includes("team-a") && r.some((c) => c.startsWith("hello-")))?.find((c) => c.startsWith("hello-")),
      { timeout: 30_000, message: "a hello pod in team-a" },
    );
    await app.openDetail("Pods", "team-a", name);
    const b = await waitBar(app, POD_LABELS);
    // The answers arrive after the first render: give them a moment.
    await new Promise((r) => setTimeout(r, 1500));
    const after = await bar(app);
    console.log(`limited header: ${JSON.stringify(after)}`);
    assert.equal(b.length, after.length);
    // `edit` covers every pod action, except Debug on clusters whose `edit`
    // role has no pods/ephemeralcontainers (kind v1.37 in CI): that one is
    // greyed with its reason.
    for (const x of after) {
      if (x.label === "Debug…" && x.denied) assert.match(x.reason, /pods\/ephemeralcontainers in namespace team-a/);
      else assert.ok(!x.denied, `${x.label} offered to edit in team-a`);
    }
    await bothThemes(app, "limited-pod");
  });
});

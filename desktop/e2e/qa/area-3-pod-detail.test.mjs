// Area 3 of #83, PR #59 (pod detail parity, live detail panels):
// - default/hungry: FailedScheduling event, PodScheduled=False, `cpu 1k / —`
// - demo/crashed: `Waiting: CrashLoopBackOff` in red, `Terminated: Error
//   (exit 1)`; the restart count climbs live (on a pod of our own that
//   crashes at once, so the back-off is still short)
// - a demo/web pod: the owner link opens the ReplicaSet
// - a container port's Forward button starts a forward that serves HTTP
// - `kubectl label` while the panel is open: the chip appears in about 1 s
// - `kubectl delete pod` from outside: "This Pod was deleted", actions disabled
// - a Deployment and a ConfigMap panel update live and show the deletion
// - a Secret panel shows keys only (overview and YAML tab)
// - Logs and Shell still open in the dock
// The demo objects are only read; what changes lives in a temp namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { pane, panelButton } from "../lib/dock.mjs";
import { deleteNamespace, httpPodYaml, kubectl, podNames, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { actionButtons, panelText, setTheme, waitPanelTitle } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { terminal } from "../lib/terminal.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const SECRET_VALUE = "qa-area3-do-not-leak-7f3a";
// In the command line of qa-spec: the panel must mask both (#385).
const ARG_TOKEN = "qa-area3-arg-token-91c2";
const ARG_PASSWORD = "qa-area3-arg-pw-44d0";

const fixtures = `
${httpPodYaml("qa-web", 8080, "hello from area 3")}
---
apiVersion: v1
kind: Pod
metadata:
  name: qa-crash
spec:
  restartPolicy: Always
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "echo boom; exit 1"]
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: qa-config
data:
  greeting: hello
---
apiVersion: v1
kind: Secret
metadata:
  name: qa-secret
stringData:
  password: ${SECRET_VALUE}
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: qa-spec-cfg
data:
  app.conf: "listen 8080"
---
apiVersion: v1
kind: Pod
metadata:
  name: qa-spec
spec:
  terminationGracePeriodSeconds: 0
  containers:
    - name: app
      image: busybox:1.36
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "trap 'exit 0' TERM; while true; do sleep 5; done # --password=${ARG_PASSWORD} keep running"]
      args: ["--token=${ARG_TOKEN}", "--listen=:8080"]
      resources:
        requests: { cpu: 10m, memory: 16Mi }
        limits: { memory: 32Mi }
      env:
        - { name: MODE, value: qa }
        - name: DB_PASSWORD
          valueFrom: { secretKeyRef: { name: qa-secret, key: password } }
      volumeMounts:
        - { name: cfg, mountPath: /etc/app, readOnly: true }
        - { name: scratch, mountPath: /scratch }
  volumes:
    - { name: cfg, configMap: { name: qa-spec-cfg } }
    - { name: scratch, emptyDir: {} }
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: qa-deploy
spec:
  replicas: 1
  selector:
    matchLabels: { app: qa-deploy }
  template:
    metadata:
      labels: { app: qa-deploy }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: app
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "while true; do echo tick; sleep 2; done"]
`;

/** The `Restarts` value of the first container card. */
function restarts(app) {
  return app.js(`
    const dts = document.querySelectorAll('[data-testid="detail-panel"] section.card dt');
    for (const dt of dts) if (dt.textContent.trim() === 'Restarts') return Number(dt.nextElementSibling.textContent.trim());
    return -1;`);
}

/** Text and computed colour of the first container's state and last state. */
function containerStates(app) {
  return app.js(`
    const s = document.querySelector('[data-testid="detail-panel"] [data-testid="container-state"]');
    const l = document.querySelector('[data-testid="detail-panel"] [data-testid="last-state"]');
    return {
      state: s?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
      stateColor: s ? getComputedStyle(s).color : '',
      red: getComputedStyle(document.documentElement).getPropertyValue('--red').trim(),
      last: l?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
    };`);
}

/** The label chips of the panel. */
function chips(app) {
  return app.js(`return Array.from(document.querySelectorAll('[data-testid="detail-panel"] .chip'), (c) => c.textContent.trim())`);
}

describe("area 3: pod detail and live panels (#59)", { timeout: 20 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-area3-pod", fixtures);
    waitPodReady(ns, "qa-web");
    waitPodReady(ns, "qa-spec");
    kubectl(["-n", ns, "rollout", "status", "deploy/qa-deploy", "--timeout=180s"]);
  });
  after(() => deleteNamespace(ns));

  const s = appSession("area-3-pod-detail");

  it("default/hungry shows FailedScheduling, PodScheduled=False and cpu 1k / —", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.openDetail("Pods", "default", "hungry");
    const text = await app.waitFor(
      async () => {
        const t = await panelText(app);
        return t.includes("FailedScheduling") ? t : null;
      },
      { message: "the FailedScheduling event" },
    );
    assert.match(text, /PodScheduled\s+False/);
    assert.match(text, /Requests\s+cpu 1k · memory 100Gi/);
    assert.match(text, /Limits\s+—/);
    await app.js(`document.querySelector('[data-testid="detail-panel"] section.card')?.scrollIntoView()`);
  });

  /** The first container card's summary, once its mounts are in. */
  async function specSummary(app) {
    return app.waitFor(
      () =>
        app.js(`
          const card = document.querySelector('[data-testid="detail-panel"] section.card');
          const t = (id) => card?.querySelector('[data-testid="' + id + '"]')?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
          if (!t('container-mounts')) return null;
          card.scrollIntoView({ block: 'start' });
          return { command: t('container-command'), args: t('container-args'), env: t('container-env'),
                   mounts: t('container-mounts'), hidden: t('secrets-hidden'), html: card.innerHTML };`),
      { message: "the container summary of qa-spec" },
    );
  }

  for (const theme of ["light", "dark"]) {
    it(`qa-spec's card shows command, args, env and mount sources, tokens masked (${theme}, #385)`, T, async () => {
      const { app } = s;
      await setTheme(app, theme);
      await app.openDetail("Pods", ns, "qa-spec");
      const v = await specSummary(app);
      console.log(`summary: ${JSON.stringify({ ...v, html: undefined })}`);
      assert.match(v.command, /^sh -c 'trap/);
      assert.match(v.command, /--password=••••/);
      assert.match(v.args, /^--token=•••• --listen=:8080/);
      assert.equal(v.env, "2 variables (1 from a Secret)");
      assert.match(v.mounts, /\/etc\/app ← configmap qa-spec-cfg \(ro\)/);
      assert.match(v.mounts, /\/scratch ← emptyDir/);
      assert.match(v.mounts, /\/var\/run\/secrets\/kubernetes\.io\/serviceaccount ← projected \(service account token\) \(ro\)/);
      assert.ok(v.hidden, "the note that values are hidden");
      for (const secret of [ARG_TOKEN, ARG_PASSWORD, SECRET_VALUE]) {
        assert.ok(!v.html.includes(secret), `${secret} in the card`);
      }
      // The long command starts folded; open it for the dark screenshot.
      if (theme === "dark") {
        await (await app.find(By.css('[data-testid="detail-panel"] button[aria-label="Show all of command"]'))).click();
        await app.find(By.css('[data-testid="detail-panel"] button[aria-label="Fold command"]'));
      }
    });
  }

  it("demo/crashed shows CrashLoopBackOff in red and the last termination", T, async () => {
    const { app } = s;
    await app.openDetail("Pods", "demo", "crashed");
    const st = await app.waitFor(
      async () => {
        const v = await containerStates(app);
        // On a fresh cluster the first crash (the last termination) can take a while.
        return v.state && v.last ? v : null;
      },
      { timeout: 60_000, message: "the container state and its last termination" },
    );
    console.log(`crashed: ${JSON.stringify(st)}`);
    // Between two crashes the pod is briefly Running.
    if (st.state.startsWith("Waiting")) {
      assert.match(st.state, /^Waiting: CrashLoopBackOff/);
      assert.ok(st.stateColor && st.red, "colours resolved");
    }
    assert.match(st.last, /^Terminated: Error \(exit 1\)/);
  });

  it("the restart count climbs live without reopening the panel", T, async () => {
    const { app } = s;
    await app.openDetail("Pods", ns, "qa-crash");
    await app.waitFor(async () => (await restarts(app)) >= 1, { timeout: 60_000, message: "a first restart" });
    const first = await restarts(app);
    const t0 = Date.now();
    const next = await app.waitFor(
      async () => {
        const n = await restarts(app);
        return n > first ? n : null;
      },
      { timeout: 120_000, interval: 500, message: `the restart count to go past ${first}` },
    );
    const kube = Number(kubectl(["-n", ns, "get", "pod", "qa-crash", "-o", "jsonpath={.status.containerStatuses[0].restartCount}"]));
    console.log(`restarts ${first} -> ${next} in ${Date.now() - t0} ms (kubectl: ${kube})`);
    assert.ok(kube >= next);
  });

  it("a demo/web pod's owner link opens its ReplicaSet", T, async () => {
    const { app } = s;
    const pod = podNames("demo", "app=web")[0];
    assert.ok(pod, "a demo/web pod");
    const rs = kubectl(["-n", "demo", "get", "pod", pod, "-o", "jsonpath={.metadata.ownerReferences[0].name}"]);
    await app.openDetail("Pods", "demo", pod);
    const link = await app.find(By.xpath(`//*[@data-testid='detail-panel']//button[contains(@class,'link')][contains(normalize-space(), '${rs}')]`));
    await link.click();
    await waitPanelTitle(app, `ReplicaSet demo/${rs}`);
  });

  it("a container port's Forward button starts a working forward", T, async () => {
    const { app } = s;
    await app.openDetail("Pods", ns, "qa-web");
    const btn = await app.find(By.css('[data-testid="detail-panel"] button[aria-label="Forward port 8080"]'));
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", btn);
    await btn.click();
    const url = await app.waitFor(
      async () => (await panelText(app)).match(/(http:\/\/127\.0\.0\.1:\d+)/)?.[1] ?? null,
      { timeout: 60_000, message: "a forward URL in the panel" },
    );
    const body = await (await fetch(url)).text();
    assert.match(body, /hello from area 3/);
    await (await app.find(By.css(`[data-testid="detail-panel"] button[aria-label="Stop ${url}"]`))).click();
    await app.waitFor(
      async () => (await app.driver.findElements(By.css(`[data-testid="detail-panel"] button[aria-label="Stop ${url}"]`))).length === 0,
      { message: "the forward's row to go" },
    );
    await assert.rejects(fetch(url), "the forward stopped");
    // The status line under "Port forward" should not still say "Forwarding".
    const status = await app.js(
      `return Array.from(document.querySelectorAll('[data-testid="detail-panel"] .detail-status'), (p) => p.textContent.trim())`,
    );
    console.log(`status after Stop: ${JSON.stringify(status)}`);
    assert.ok(!status.some((t) => t.startsWith("Forwarding")), `stale status after Stop: ${JSON.stringify(status)}`);
  });

  it("a label added with kubectl shows up as a chip within about a second", T, async () => {
    const { app } = s;
    await app.openDetail("Pods", ns, "qa-web");
    await app.waitFor(async () => (await chips(app)).includes("app=qa-web"), { message: "the app label chip" });
    const k0 = Date.now();
    kubectl(["-n", ns, "label", "pod", "qa-web", "qa-area3=live"]);
    // From when the API server accepted the change (kubectl itself can be
    // slow on a busy machine).
    const t0 = Date.now();
    await app.waitFor(async () => (await chips(app)).includes("qa-area3=live"), {
      timeout: 10_000,
      interval: 100,
      message: "the new label chip",
    });
    const ms = Date.now() - t0;
    console.log(`label chip ${ms} ms after kubectl returned (kubectl took ${t0 - k0} ms)`);
    assert.ok(ms < 2000, `label chip took ${ms} ms`);
  });

  it("deleting the pod from outside shows the deleted notice and disables the actions", T, async () => {
    const { app } = s;
    await app.openDetail("Pods", ns, "qa-web");
    kubectl(["-n", ns, "delete", "pod", "qa-web", "--wait=false"]);
    await app.waitFor(async () => (await panelText(app)).includes("This Pod was deleted"), {
      timeout: 30_000,
      message: '"This Pod was deleted"',
    });
    const buttons = await actionButtons(app);
    console.log(`actions: ${JSON.stringify(buttons)}`);
    assert.ok(buttons.length > 0 && buttons.every((b) => b.disabled), "every action disabled");
    const term = await app.find(By.xpath("//*[@data-testid='detail-panel']//button[normalize-space()='Shell']"));
    assert.equal(await term.getAttribute("disabled"), "true");
  });

  it("a Deployment panel updates live and shows its deletion", T, async () => {
    const { app } = s;
    await app.openDetail("Deployments", ns, "qa-deploy");
    kubectl(["-n", ns, "label", "deploy", "qa-deploy", "qa-area3=deploy-live"]);
    await app.waitFor(async () => (await chips(app)).includes("qa-area3=deploy-live"), {
      timeout: 10_000,
      message: "the Deployment's new label",
    });
    kubectl(["-n", ns, "delete", "deploy", "qa-deploy", "--wait=false"]);
    await app.waitFor(async () => (await panelText(app)).includes("This Deployment was deleted"), {
      timeout: 30_000,
      message: '"This Deployment was deleted"',
    });
  });

  it("a ConfigMap panel updates live and shows its deletion", T, async () => {
    const { app } = s;
    await app.openDetail("Config Maps", ns, "qa-config");
    kubectl(["-n", ns, "label", "configmap", "qa-config", "qa-area3=cm-live"]);
    await app.waitFor(async () => (await chips(app)).includes("qa-area3=cm-live"), {
      timeout: 10_000,
      message: "the ConfigMap's new label",
    });
    kubectl(["-n", ns, "delete", "configmap", "qa-config", "--wait=false"]);
    await app.waitFor(async () => (await panelText(app)).includes("This ConfigMap was deleted"), {
      timeout: 30_000,
      message: '"This ConfigMap was deleted"',
    });
  });

  it("a Secret panel shows only its keys, in the overview and the YAML tab", T, async () => {
    const { app } = s;
    await app.openDetail("Secrets", ns, "qa-secret");
    const text = await app.waitFor(
      async () => {
        // The data editor (#278): one row per key, its size, the value hidden.
        const key = await app.js(
          `return document.querySelector('[data-testid="detail-panel"] [data-testid="data-editor"] li[data-key="password"]')?.innerText ?? ""`,
        );
        return /password\s+\d+ bytes/.test(key) ? panelText(app) : null;
      },
      { message: "the Secret's key in the data editor" },
    );
    assert.match(text, /Values are hidden until you reveal them/);
    const b64 = Buffer.from(SECRET_VALUE).toString("base64");
    assert.ok(!text.includes(SECRET_VALUE) && !text.includes(b64), "the overview leaks the value");
    const html = await app.js(`return document.querySelector('[data-testid="detail-panel"]').innerHTML`);
    assert.ok(!html.includes(SECRET_VALUE) && !html.includes(b64), "the overview has the value in its HTML");
    await (await app.find(By.xpath("//*[@data-testid='detail-panel']//button[@role='tab'][normalize-space()='YAML']"))).click();
    await app.find(By.css('[data-testid="detail-panel"] .cm-content'), { timeout: 20_000 });
    await app.waitFor(async () => (await panelText(app)).includes("password"), { message: "the YAML" });
    const yamlHtml = await app.js(`return document.querySelector('[data-testid="detail-panel"]').innerHTML`);
    assert.ok(!yamlHtml.includes(SECRET_VALUE) && !yamlHtml.includes(b64), "the YAML tab leaks the value before Reveal");
  });

  it("Logs and Shell still open in the dock", T, async () => {
    const { app } = s;
    // The crashing pod logs "boom" before each exit.
    await app.openDetail("Pods", ns, "qa-crash");
    // The button sits at the bottom of a long panel that re-renders on every
    // restart: scroll it into view first (WebKitWebDriver does not always),
    // and click again if no log tab opened.
    const logTab = pane(`logs:${ns}/qa-crash`);
    await app.waitFor(
      async () => {
        if (!(await app.js(`return !!document.querySelector(arguments[0])`, logTab))) await panelButton(app, "Logs");
        return app.js(`return !!document.querySelector(arguments[0])`, logTab);
      },
      { timeout: 20_000, interval: 2000, message: "the qa-crash log tab in the dock" },
    );
    await app.waitFor(
      async () => (await app.js(`return document.querySelector('[data-testid="dock"]')?.innerText ?? ""`)).includes("boom"),
      { timeout: 30_000, message: '"boom" in the dock log tab' },
    );
    await app.openDetail("Pods", "demo", "multi");
    await panelButton(app, "Shell");
    await app.find(byTestId("terminal"), { timeout: 30_000 });
    const out = await terminal(app).run("hostname", { timeout: 30_000 });
    assert.equal(out, "multi");
  });
});

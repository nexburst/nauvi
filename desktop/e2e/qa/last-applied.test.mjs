// #409: kubectl's last-applied-configuration annotation in the detail panel.
// - collapsed by default: "last-applied-configuration · N KB · Show"
// - Show: indented JSON with the same masking as the pod card (args, env
//   values, secret-named keys), done in the backend: the secret never
//   reaches the webview
// - a Secret's copy stays "<hidden: reveal to view>"
// - an object made with `kubectl create` has no such row
// - the YAML tab still shows the annotation as stored
// Everything lives in a temp namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { panelText, setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const ARG_TOKEN = "qa-409-arg-token-5b1e";
const ENV_PASSWORD = "qa-409-env-pw-c7a2";
const CM_PASSWORD = "qa-409-cm-pw-0d9f";
const SECRET_VALUE = "qa-409-secret-3e88";
const LEAKS = [ARG_TOKEN, ENV_PASSWORD, CM_PASSWORD, SECRET_VALUE];

const fixtures = `
apiVersion: apps/v1
kind: Deployment
metadata:
  name: qa-applied
spec:
  replicas: 0
  selector:
    matchLabels: { app: qa-applied }
  template:
    metadata:
      labels: { app: qa-applied }
    spec:
      containers:
        - name: app
          image: busybox:1.36
          command: ["sh", "-c", "sleep 3600"]
          args: ["--token=${ARG_TOKEN}", "--listen=:8080"]
          env:
            - { name: DB_PASSWORD, value: ${ENV_PASSWORD} }
            - { name: LOG_LEVEL, value: debug }
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: qa-applied-cm
data:
  password: ${CM_PASSWORD}
  mode: fast
---
apiVersion: v1
kind: Secret
metadata:
  name: qa-applied-secret
stringData:
  password: ${SECRET_VALUE}
`;

/** Open the panel's Annotations section and return the last-applied row's
 *  text (null until it is there). */
async function lastAppliedRow(app) {
  return app.waitFor(
    () =>
      app.js(`
        const p = document.querySelector('[data-testid="detail-panel"]');
        const d = Array.from(p?.querySelectorAll('details') ?? []).find((d) => d.querySelector('summary')?.textContent.startsWith('Annotations'));
        if (!d) return null;
        d.open = true;
        const row = d.querySelector('[data-testid="last-applied"]');
        if (!row) return null;
        row.scrollIntoView({ block: 'start' });
        return row.textContent.replace(/\\s+/g, ' ').trim();`),
    { message: "the last-applied-configuration row" },
  );
}

async function show(app) {
  await (await app.find(byTestId("last-applied-toggle"))).click();
  return app.waitFor(
    () => app.js(`return document.querySelector('[data-testid="last-applied-text"]')?.textContent ?? null`),
    { message: "the last-applied JSON" },
  );
}

function panelHtml(app) {
  return app.js(`return document.querySelector('[data-testid="detail-panel"]').innerHTML`);
}

describe("last-applied-configuration in the detail panel (#409)", { timeout: 10 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-409-applied", fixtures);
    kubectl(["-n", ns, "create", "configmap", "qa-created", "--from-literal=a=b"]);
  });
  after(() => deleteNamespace(ns));

  const s = appSession("last-applied");

  for (const theme of ["light", "dark"]) {
    it(`a Deployment's last-applied is collapsed, then shown masked (${theme})`, T, async () => {
      const { app } = s;
      await resizeWindow(app, 1280, 800);
      await waitLive(app);
      await setTheme(app, theme);
      await app.openDetail("Deployments", ns, "qa-applied");
      const row = await lastAppliedRow(app);
      console.log(`row: ${row}`);
      assert.match(row, /^last-applied-configuration · \d+(\.\d)? (B|KB) · Show$/);
      assert.equal(await app.js(`return !!document.querySelector('[data-testid="last-applied-text"]')`), false);

      const json = await show(app);
      console.log(`shown (${json.length} chars): ${json.slice(0, 200)}`);
      assert.match(json, /"--token=••••"/);
      assert.match(json, /"name": "DB_PASSWORD",\s+"value": "••••"/);
      assert.match(json, /"value": "debug"/);
      assert.match(json, /"--listen=:8080"/);
      await app.find(byTestId("last-applied-masked"));
      const html = await panelHtml(app);
      for (const secret of LEAKS) assert.ok(!html.includes(secret), `${secret} in the panel`);
      await app.js(`document.querySelector('[data-testid="last-applied"]').scrollIntoView({ block: 'start' })`);
    });
  }

  it("a ConfigMap's secret-named key is masked, the others kept", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await app.openDetail("Config Maps", ns, "qa-applied-cm");
    await lastAppliedRow(app);
    const json = await show(app);
    assert.match(json, /"password": "••••"/);
    assert.match(json, /"mode": "fast"/);
    const html = await panelHtml(app);
    for (const secret of LEAKS) assert.ok(!html.includes(secret), `${secret} in the panel`);
  });

  it("a Secret's last-applied stays hidden", T, async () => {
    const { app } = s;
    await app.openDetail("Secrets", ns, "qa-applied-secret");
    await lastAppliedRow(app);
    const text = await show(app);
    assert.equal(text.trim(), "<hidden: reveal to view>");
    assert.equal(await app.js(`return !!document.querySelector('[data-testid="last-applied-masked"]')`), false);
    const html = await panelHtml(app);
    const b64 = Buffer.from(SECRET_VALUE).toString("base64");
    assert.ok(!html.includes(SECRET_VALUE) && !html.includes(b64), "the Secret's value in the panel");
  });

  it("an object made with kubectl create has no last-applied row", T, async () => {
    const { app } = s;
    await app.openDetail("Config Maps", ns, "qa-created");
    await app.waitFor(async () => (await panelText(app)).includes("qa-created"), { message: "the qa-created panel" });
    assert.equal(await app.js(`return !!document.querySelector('[data-testid="last-applied"]')`), false);
  });

  it("the YAML tab still shows the annotation as stored", T, async () => {
    const { app } = s;
    await app.openDetail("Config Maps", ns, "qa-applied-cm");
    await lastAppliedRow(app);
    await (await app.find(By.xpath("//*[@data-testid='detail-panel']//button[@role='tab'][normalize-space()='YAML']"))).click();
    await app.find(By.css('[data-testid="detail-panel"] .cm-content'), { timeout: 20_000 });
    const yaml = await app.waitFor(
      async () => {
        const t = await panelText(app);
        return t.includes("last-applied-configuration") ? t : null;
      },
      { message: "the annotation in the YAML tab" },
    );
    // By design (#409): the YAML tab is the object as stored.
    assert.ok(yaml.includes(CM_PASSWORD), "the raw value in the YAML tab");
  });
});

// The dock's context line and the port-forward banner (#386).
// Checks: a log tab and a shell tab start with one line naming the pod, the
// container and the namespace (and for logs the "since" option); the pod's
// name opens its panel again once closed. Starting a forward from the pod
// panel and from a Service's ports shows a banner with Open and Port
// Forwards; Port Forwards opens the view. Screenshots in light and dark.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { openPodLogs, pane, panelButton } from "../lib/dock.mjs";
import { setTheme, waitPanelTitle } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const T = { timeout: 120_000 };
let ns;

const serviceYaml = (name, target) => `
apiVersion: v1
kind: Service
metadata:
  name: ${name}
spec:
  selector:
    app: ${target}
  ports:
    - name: http
      port: 80
      targetPort: 8080
`;

/** The context line of a dock tab, as text. */
function contextLine(app, id) {
  return app.js(
    `const el = document.querySelector(arguments[0] + ' [data-testid="dock-context"]'); return el ? el.textContent.replace(/\s+/g, ' ').trim() : null;`,
    pane(id),
  );
}

/** The context line once it reads `want`; fails with what it read last. */
async function waitLine(app, id, want) {
  let last = null;
  await app.waitFor(async () => (last = await contextLine(app, id)) === want, { message: want }).catch((e) => {
    throw new Error(`${e.message}; the line read ${JSON.stringify(last)}`);
  });
  return last;
}

function noticeText(app) {
  return app.js(`const el = document.querySelector('[data-testid="action-notice"]'); return el ? el.innerText : null;`);
}

async function noticeButton(app, label) {
  return app.find(By.xpath(`//*[@data-testid='action-notice']//button[normalize-space()=${xq(label)}]`));
}

async function shots(app, label) {
  await setTheme(app, "light");
  await app.shot(`${label}-light`);
  await setTheme(app, "dark");
  await app.shot(`${label}-dark`);
}

describe("dock context line and forward banner (#386)", { timeout: 10 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-dock-context", [httpPodYaml("web", 8080, "hello from 386"), serviceYaml("web-svc", "web")].join("\n---\n"));
    waitPodReady(ns, "web");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("dock-context");

  it("a log tab names the pod, container, namespace and since", T, async () => {
    const { app } = s;
    await waitLive(app);
    const id = await openPodLogs(app, ns, "web");
    const want = `Logs of pod web in namespace ${ns}, container web, from all time`;
    const line = await waitLine(app, id, want);
    console.log(`log context: ${line}`);
    await shots(app, "logs-context");

    // With the panel closed, the pod's name opens it again.
    await (await app.find(By.css('[data-testid="detail-panel"] button[aria-label="Close details"]'))).click();
    await app.waitFor(async () => (await app.driver.findElements(byTestId("detail-panel"))).length === 0, { message: "panel closed" });
    await (await app.find(By.xpath(`//*[@data-testid='dock-context']//button[normalize-space()='web']`))).click();
    await waitPanelTitle(app, `${ns}/web`);
    await app.shot("logs-context-link-opened");
  });

  it("a shell tab names the pod, container and namespace", T, async () => {
    const { app } = s;
    await panelButton(app, "Shell");
    const id = `shell:${ns}/web`;
    const want = `Shell into pod web, container web, in namespace ${ns}`;
    const line = await waitLine(app, id, want, { message: want });
    console.log(`shell context: ${line}`);
    await shots(app, "shell-context");
  });

  it("a forward from the pod panel shows a banner; Port Forwards opens the view", T, async () => {
    const { app } = s;
    const panel = await app.find(byTestId("detail-panel"));
    await app.setValue(await panel.findElement(By.css('input[aria-label="Pod port"]')), "8080");
    await (await panel.findElement(By.xpath(".//button[normalize-space()='Forward']"))).click();
    const text = await app.waitFor(async () => {
      const t = await noticeText(app);
      return t && /Forwarding http:\/\/127\.0\.0\.1:\d+ → pod\//.test(t) ? t : null;
    }, { message: "the forward banner" });
    console.log(`banner: ${text}`);
    assert.match(text, new RegExp(`pod/${ns}/web:8080`));
    const url = text.match(/(http:\/\/127\.0\.0\.1:\d+)/)[1];
    assert.match(await (await fetch(url)).text(), /hello from 386/);
    await shots(app, "forward-banner-pod");
    await (await noticeButton(app, "Port Forwards")).click();
    const view = await app.find(byTestId("port-forwards"));
    await app.waitFor(async () => (await app.js("return arguments[0].innerText", view)).includes(url), { message: `${url} listed` });
    await app.shot("forward-banner-view");
  });

  it("a forward from a Service's ports shows the banner too", T, async () => {
    const { app } = s;
    await app.openDetail("Services", ns, "web-svc");
    await (await app.find(By.css('[data-testid="service-ports"] button[aria-label="Forward port 80"]'))).click();
    const text = await app.waitFor(async () => {
      const t = await noticeText(app);
      return t && t.includes(`svc/${ns}/web-svc:80`) ? t : null;
    }, { message: "the service forward banner" });
    console.log(`banner: ${text}`);
    await noticeButton(app, "Open");
    await shots(app, "forward-banner-service");
  });
});

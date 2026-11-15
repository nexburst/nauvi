// QA area 4 (#83): the Port Forwards view (#65) beyond port-forward.test.mjs.
// Checks (#65): a pod forward outlives its detail panel (forwards live in
// the backend), the Port Forwards view lists it, and switching context
// stops it and empties the view.
// Checks (#19): Forward on a pod port works with an HTTP client, Stop ends it
// (Open / Copy URL / Stop from the view are in port-forward.test.mjs).

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { aliasKubeconfig } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { selectContext } from "../lib/window.mjs";

const T = { timeout: 120_000 };
let ns;
let kc;
let url;

describe("area 4: port forwards and context switches", { timeout: 10 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-area4-pf", httpPodYaml("web", 8080, "hello from area 4"));
    waitPodReady(ns, "web");
  });
  after(() => {
    deleteNamespace(ns);
    kc?.remove();
  });
  const s = appSession("area-4-port-forwards", () => {
    kc = aliasKubeconfig();
    return { kubeconfig: kc.path };
  });

  it("a pod forward keeps running after its panel closes", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.openDetail("Pods", ns, "web");
    const panel = await app.find(byTestId("detail-panel"));
    await app.setValue(await panel.findElement(By.css('input[aria-label="Pod port"]')), "8080");
    await (await panel.findElement(By.xpath(".//button[normalize-space()='Forward']"))).click();
    url = await app.waitFor(async () => (await panel.getText()).match(/Forwarding (http:\/\/127\.0\.0\.1:\d+)/)?.[1], {
      message: "Forwarding http://127.0.0.1:<port>",
    });
    assert.match(await (await fetch(url)).text(), /hello from area 4/);
    await (await app.find(By.css('[data-testid="detail-panel"] button[aria-label="Close details"]'))).click();
    await app.waitFor(async () => (await app.driver.findElements(byTestId("detail-panel"))).length === 0, { message: "panel closed" });
    assert.match(await (await fetch(url)).text(), /hello from area 4/, "still forwarding with the panel closed");
  });

  it("the Port Forwards view lists it", T, async () => {
    const { app } = s;
    await app.nav("Port Forwards");
    const view = await app.find(byTestId("port-forwards"));
    await app.waitFor(async () => (await app.js("return arguments[0].innerText", view)).includes(url), { message: `${url} listed` });
    const text = await app.js("return arguments[0].innerText", view);
    console.log(`Port Forwards view:\n${text}`);
    assert.ok(text.includes("web"), "the target is shown");
    await app.shot("port-forwards-view");
  });

  it("switching context stops it and empties Port Forwards", T, async () => {
    const { app } = s;
    await selectContext(app, kc.alias);
    await waitLive(app);
    await app.nav("Port Forwards");
    await app.find(By.xpath(`//*[@data-testid='port-forwards']//*[contains(normalize-space(), ${xq("No port-forwards.")})]`));
    await assert.rejects(fetch(url), "the old forward's port is closed");
  });
});

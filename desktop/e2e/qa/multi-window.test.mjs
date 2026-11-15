// Helper: several windows (lib/window.mjs: openNewWindow, switchTo,
// selectContext, windowTitles).
// Checks (#45): a second window opens with its own session, can list pods of
// another cluster (kind-kubeloupe-staging when it exists, as in qa.yml), and
// closing it leaves the first window live.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CONTEXT } from "../lib/app.mjs";
import { contexts } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { openNewWindow, selectContext, switchTo, windowHandles, windowTitles } from "../lib/window.mjs";

const T = { timeout: 120_000 };
const STAGING = process.env.QA_STAGING_CONTEXT || "kind-kubeloupe-staging";
const hasStaging = contexts().includes(STAGING);
let main;
let second;

describe("several windows", { timeout: 10 * 60_000 }, () => {
  const s = appSession("multi-window", { contexts: hasStaging ? [CONTEXT, STAGING] : [CONTEXT] });

  it("opens a second window with its own session", T, async () => {
    const { app } = s;
    await waitLive(app);
    main = await app.driver.getWindowHandle();
    second = await openNewWindow(app);
    await switchTo(app, second);
    await app.nav("Pods");
    await waitLive(app);
    const titles = await windowTitles(app);
    console.log(`window titles: ${JSON.stringify(Object.values(titles))}`);
    assert.equal(Object.keys(titles).length, 2);
  });

  it(
    `lists the pods of ${STAGING} in the second window`,
    { ...T, skip: hasStaging ? false : `no ${STAGING} context (setup.sh --staging)` },
    async () => {
      const { app } = s;
      await selectContext(app, STAGING);
      await app.nav("Pods");
      await waitLive(app);
      // The staging cluster has only system pods.
      await app.filter("kube-apiserver");
      await app.waitFor(async () => (await app.rows()).some(([n, ns]) => ns === "kube-system" && n.includes("staging")), {
        message: "the staging API server pod",
      });
      await app.filter("");
    },
  );

  it("closing the second window leaves the first one live", T, async () => {
    const { app } = s;
    await app.driver.close();
    await switchTo(app, main);
    await app.waitFor(async () => (await windowHandles(app)).length === 1, { message: "one window left" });
    await app.nav("Pods");
    await app.filter("web-");
    await app.waitFor(async () => (await app.rows()).some(([n, ns]) => ns === "demo" && n.startsWith("web-")), {
      message: "demo/web pods in the first window",
    });
    assert.equal(await app.statusText(), "Live");
  });
});

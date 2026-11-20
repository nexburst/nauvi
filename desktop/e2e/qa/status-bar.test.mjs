// The status bar (#387), in the real app (WebKitGTK) against kind:
// - the cluster's Kubernetes version next to its name, as the API server
//   reports it (`kubectl version`)
// - on a live Pods table scoped to a temp namespace: "Live · last change
//   <time>"; it stays put through a quiet minute and a change the table
//   does not show (a label), and moves when a pod is added and when one
//   is deleted
// Light and dark theme at 1280x800. Creates and deletes its own namespace.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { deleteNamespace, httpPodYaml, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces, tableData } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 300_000 };
const LIVE = /^Live · last change (\d\d:\d\d:\d\d)$/;

const footerPart = (app, id) =>
  app.js(`return document.querySelector('footer [data-testid="${id}"]')?.textContent.trim() ?? ""`);

const timeLabel = (app) => footerPart(app, "status-time");

/** The footer's time once it says Live; returns the time. */
async function liveTime(app, message) {
  let m = null;
  await app.waitFor(async () => (m = (await timeLabel(app)).match(LIVE)) !== null, { timeout: 30_000, message });
  return m[1];
}

/** Wait until the footer says Live with a time other than `before`. */
async function movedFrom(app, before, message) {
  let now = before;
  await app.waitFor(
    async () => {
      const m = (await timeLabel(app)).match(LIVE);
      if (m) now = m[1];
      return m !== null && now !== before;
    },
    { timeout: 60_000, message },
  );
  return now;
}

const podRow = async (app, name) => (await tableData(app))?.rows.find((r) => r.Name === name);

describe("status bar (#387)", { timeout: 15 * 60_000 }, () => {
  const s = appSession("status-bar");
  let ns = "";
  let first = "";
  after(() => deleteNamespace(ns));

  it("shows the cluster's version and Live with the last change (light)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "light");
    await waitLive(app);
    const server = JSON.parse(kubectl(["version", "-o", "json"])).serverVersion.gitVersion;
    await app.waitFor(async () => (await footerPart(app, "status-version")) === server, {
      message: `the version ${server} in the footer`,
    });

    ns = tempNamespace("qa387", httpPodYaml("web"));
    waitPodReady(ns, "web");
    await app.nav("Pods");
    await pickNamespaces(app, [ns]);
    await waitLive(app);
    await app.waitFor(async () => (await podRow(app, "web"))?.Status === "Running", { message: "web Running" });
    // The readiness probe may still flip a moment after Ready: let it settle.
    first = await liveTime(app, "Live · last change in the footer");
  });

  it("a quiet minute and a label change leave the time; a new pod moves it (light)", T, async () => {
    const { app } = s;
    first = await liveTime(app, "still live");
    await new Promise((r) => setTimeout(r, 65_000));
    assert.equal(await timeLabel(app), `Live · last change ${first}`, "quiet: the time stays");
    assert.equal(await app.statusText(), "Live");

    // Not a change the table shows: the time stays (by design, lib/statusTime.ts).
    kubectl(["-n", ns, "label", "pod", "web", "qa387=touched"]);
    await new Promise((r) => setTimeout(r, 5_000));
    assert.equal(await timeLabel(app), `Live · last change ${first}`, "a label change is not a change of the row");

    kubectl(["-n", ns, "apply", "-f", "-"], httpPodYaml("web2"));
    const second = await movedFrom(app, first, "the time moves when a pod is added");
    await app.waitFor(async () => (await podRow(app, "web2")) !== undefined, { message: "web2 in the table" });
    first = second;
  });

  it("a deleted pod moves it again (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    waitPodReady(ns, "web2");
    // Past the second web2 became ready in.
    await new Promise((r) => setTimeout(r, 3_000));
    const before = await liveTime(app, "live before the delete");
    kubectl(["-n", ns, "delete", "pod", "web2", "--wait=false"]);
    await movedFrom(app, before, "the time moves when web2 goes");
    await app.waitFor(async () => (await podRow(app, "web2")) === undefined, {
      timeout: 60_000,
      message: "web2 gone from the table",
    });
    assert.match(await timeLabel(app), LIVE);
  });
});

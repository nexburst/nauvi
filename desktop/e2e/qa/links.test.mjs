// #299: "Copy link" and opening nauvi:// links.
// - a second launch with a link (the single-instance path, #202) exits, and
//   the running window shows the object; still one process and one window
// - Copy link in the detail panel puts the same link on the clipboard
// - a cluster-scoped object (a Namespace), in the dark theme
// - a link for a context that is not in the kubeconfig, and a malformed
//   link, leave a plain notice and open nothing
// - a link for another of the user's contexts opens a window on it
// - the first launch with a link starts the main window on the link's
//   context and shows the object
//
// The app runs with a kubeconfig of the test context plus an alias of it
// (`aliasKubeconfig`), so "another context" needs no second cluster. The
// scenario starts a private session bus, as `single-instance` does.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { ARTIFACTS, CONTEXT, launch } from "../lib/app.mjs";
import { hookClipboard, waitForClipboard } from "../lib/clipboard.mjs";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { aliasKubeconfig, appPid } from "../lib/dock.mjs";
import { setTheme, waitPanelTitle } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { appPids, cannotLaunchTwice, launchDirect, startBus } from "../lib/second-launch.mjs";
import { switchTo, windowHandles, x11Windows } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const NAME = "links";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CONFIGMAP = `apiVersion: v1
kind: ConfigMap
metadata:
  name: linked
data:
  hello: from a nauvi link
`;

const enc = (s) => encodeURIComponent(s);
const linkTo = (context, group, version, kind, namespace, name) =>
  `nauvi://${enc(context)}/${group || "core"}/${version}/${kind}/${namespace || "_"}/${enc(name)}`;

function noticeText(app) {
  return app.js(`return document.querySelector('.notice')?.innerText ?? ""`);
}

function waitNotice(app, re) {
  return app.waitFor(async () => re.test(await noticeText(app)), { message: `a notice matching ${re}` });
}

async function dismissNotice(app) {
  await app.js(`document.querySelector('.notice .x')?.click()`);
}

describe("#299: nauvi:// links", { timeout: 15 * 60_000, skip: cannotLaunchTwice() }, () => {
  let bus;
  let alias;
  let namespace;
  const strays = [];
  after(() => {
    for (const p of strays) p.proc.kill("SIGKILL");
    deleteNamespace(namespace);
    alias?.remove();
    bus?.stop();
  });
  const s = appSession(NAME, async () => {
    bus = await startBus();
    alias = aliasKubeconfig(`${CONTEXT}-linked`);
    namespace = tempNamespace("qa-links", CONFIGMAP);
    return { kubeconfig: alias.path, env: { DBUS_SESSION_BUS_ADDRESS: bus.address } };
  });

  /** Open `link` like a click on it: a second launch with the link as its only argument. */
  async function openLink(app, link) {
    const second = launchDirect(
      {
        ...process.env,
        ...app.profile.env(),
        KUBECONFIG: alias.path,
        NAUVI_NO_SHELL_ENV: "1",
        DBUS_SESSION_BUS_ADDRESS: bus.address,
      },
      [link],
    );
    const result = await Promise.race([second.exited, sleep(30_000).then(() => "still running")]);
    if (result === "still running") strays.push(second);
    assert.deepEqual(result, { code: 0, signal: null }, `the second launch exits with 0 (${second.output().trim()})`);
  }

  it("a second launch with a link shows the object in the running window", T, async () => {
    const { app } = s;
    await waitLive(app);
    const pid = appPid(app.profile.home);
    await openLink(app, linkTo(CONTEXT, "", "v1", "ConfigMap", namespace, "linked"));
    await waitPanelTitle(app, `${namespace}/linked`, 30_000);
    await app.waitFor(
      async () => /from a nauvi link/.test(await app.js(`return document.querySelector('[data-testid="detail-panel"]')?.innerText ?? ""`)),
      { message: "the ConfigMap's data in the panel" },
    );
    assert.deepEqual(appPids(app.profile.home), [pid], "still one nauvi process");
    assert.equal(x11Windows(pid).length, 1, "still one window");
    assert.equal(await app.statusText(), "Live");
    const log = readFileSync(join(ARTIFACTS, `${NAME}-app.log`), "utf8");
    assert.match(log, /opened with a nauvi:\/\/ link/);
  });

  it("Copy link in the detail panel copies the same link", T, async () => {
    const { app } = s;
    await hookClipboard(app);
    await (await app.find(By.css('[data-testid="detail-panel"] [data-action="link"]'))).click();
    await waitNotice(app, /Copied the link to ConfigMap linked/);
    const { source } = await waitForClipboard(app, linkTo(CONTEXT, "", "v1", "ConfigMap", namespace, "linked"));
    console.log(`clipboard read from: ${source}`);
  });

  it("a link to a cluster-scoped object, in the dark theme", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await openLink(app, linkTo(CONTEXT, "", "v1", "Namespace", "", namespace));
    await waitPanelTitle(app, `Namespace ${namespace}`, 30_000);
    assert.doesNotMatch(await app.js(`return document.querySelector('[data-testid="detail-panel"] .title')?.textContent ?? ""`), /\//);
  });

  it("a link for a context the user hasn't got leaves a plain notice", T, async () => {
    const { app } = s;
    await setTheme(app, null);
    await dismissNotice(app);
    const before = await windowHandles(app);
    await openLink(app, linkTo("qa-no-such-context", "", "v1", "ConfigMap", namespace, "linked"));
    await waitNotice(app, /context qa-no-such-context, which is not in your kubeconfigs\. Nothing was opened\./);
    await sleep(1500);
    assert.equal((await windowHandles(app)).length, before.length, "no window opened");
    // The panel still shows the Namespace: nothing navigated.
    await waitPanelTitle(app, `Namespace ${namespace}`);
  });

  it("a malformed link leaves a plain notice", T, async () => {
    const { app } = s;
    await dismissNotice(app);
    await openLink(app, `nauvi://${CONTEXT}/core/v1/Pod/${namespace}/linked?exec=sh`);
    await waitNotice(app, /This nauvi link can't be opened: it has a query or a fragment\. Nothing was opened\./);
    await openLink(app, `nauvi://${CONTEXT}/core/v1/Pod/${namespace}/..`);
    await waitNotice(app, /is not an object name/);
    const log = readFileSync(join(ARTIFACTS, `${NAME}-app.log`), "utf8");
    assert.match(log, /refused a link/);
  });

  it("a link for another of the user's contexts opens a window on it", T, async () => {
    const { app } = s;
    await dismissNotice(app);
    const main = await app.driver.getWindowHandle();
    const before = await windowHandles(app);
    await openLink(app, linkTo(alias.alias, "", "v1", "ConfigMap", namespace, "linked"));
    const added = await app.waitFor(
      async () => (await windowHandles(app)).find((h) => !before.includes(h)),
      { timeout: 30_000, message: "a new window" },
    );
    await switchTo(app, added);
    await waitPanelTitle(app, `${namespace}/linked`, 45_000);
    const ctx = await app.js(`return document.querySelector('select[aria-label="Cluster context"]')?.value ?? ""`);
    assert.equal(ctx, alias.alias, "the new window is on the link's context");
    // A second link for the same context goes to that window, not a third.
    await openLink(app, linkTo(alias.alias, "", "v1", "Namespace", "", namespace));
    await waitPanelTitle(app, `Namespace ${namespace}`, 30_000);
    assert.equal((await windowHandles(app)).length, before.length + 1, "no third window");
    await switchTo(app, main);
  });
});

// Its own app, once the first one is closed (one WebDriver session at a time).
describe("#299: the first launch with a link", { timeout: 5 * 60_000 }, () => {
  let kc;
  let namespace;
  after(() => {
    deleteNamespace(namespace);
    kc?.remove();
  });

  it("the first launch with a link starts on the link's context", T, async (t) => {
    kc = aliasKubeconfig(`${CONTEXT}-linked`);
    namespace = tempNamespace("qa-links-start", CONFIGMAP);
    const link = linkTo(kc.alias, "", "v1", "ConfigMap", namespace, "linked");
    const first = await launch(`${NAME}-startup`, { kubeconfig: kc.path, args: [link] });
    try {
      await waitPanelTitle(first, `${namespace}/linked`, 60_000);
      const ctx = await first.js(`return document.querySelector('select[aria-label="Cluster context"]')?.value ?? ""`);
      assert.equal(ctx, kc.alias, "the main window started on the link's context");
      assert.equal((await windowHandles(first)).length, 1, "one window");
    } finally {
      await first.shot(t.name);
      await first.close();
    }
  });
});

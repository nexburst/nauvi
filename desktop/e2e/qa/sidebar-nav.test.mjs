// Helpers: App.nav (opens a section's "More" when the kind waits there),
// setTheme, resizeWindow.
// Checks (#481, #490) in WebKitGTK against kind, at 1280x800:
// - First launch: a fresh profile in a 1280-px window starts with the kinds
//   as a column, in words, beside the sheet (not the rail of codes), with
//   the filter at the top. Nothing pinned the column for it
//   (`nauvi.chart.pinned` is unset), and the default pins are not repeated
//   in a "Pinned" section above their own entries.
// - Expanded: every kind has an icon; Workloads lists its common kinds,
//   ReplicaSets waits under "1 more" until it is opened; Helm sits after
//   Cluster, before Access Control.
// - Filtered: "helm" leaves only the Helm section (no empty Network head);
//   a word that matches nothing says so; Escape clears the filter.
// - Pins: Config Maps pinned from its right-click menu makes the pins the
//   user's own, so Pinned shows them all; it opens with key 5; unpinned the
//   same way.
// - Collapsed: the rail of icons with their short names, "All kinds" in
//   words under the compass; G opens every kind over the sheet.
// Screenshots: first launch, expanded, filtered, no match, collapsed and
// the drawer, in light and dark.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { setTheme } from "../lib/theme.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };

async function shots(app, label) {
  for (const theme of ["light", "dark"]) {
    await setTheme(app, theme);
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

/** The section ids the sidebar shows, top to bottom. */
const groups = (app) =>
  app.js(`return Array.from(document.querySelectorAll('[data-testid="sidebar-kinds"] [data-group]'), (g) => g.dataset.group)`);
/** The labels of a section's kinds. */
const labels = (app, id) =>
  app.js(
    `return Array.from(document.querySelectorAll('[data-testid="sidebar-kinds"] [data-group="' + arguments[0] + '"] button.kind .label'), (l) => l.textContent.trim())`,
    id,
  );
const kindButton = (app, label) =>
  app.find(
    By.xpath(`//*[@data-testid="sidebar-kinds"]//*[@data-group]//button[contains(@class,"kind")][normalize-space(span[1])="${label}"]`),
  );

async function setFilter(app, text) {
  const input = await app.find(byTestId("sidebar-filter"));
  await input.click();
  await app.driver.actions().keyDown(Key.CONTROL).sendKeys("a").keyUp(Key.CONTROL).sendKeys(Key.BACK_SPACE).perform();
  if (text) await input.sendKeys(text);
  return input;
}

describe("sidebar: icons, More, filter, pins, rail; the first launch", { timeout: 15 * 60_000 }, () => {
  const s = appSession("sidebar-nav");

  it("a first launch at 1280 px shows every kind in words beside the sheet", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    const state = await app.js(`return {
      stored: localStorage.getItem("nauvi.chart.pinned"),
      column: !!document.querySelector("nav:not(.floating) [data-testid=sidebar-kinds]"),
      rail: !!document.querySelector('[data-testid="berths"]'),
      filter: document.querySelector('[data-testid="sidebar-filter"]')?.placeholder ?? null,
      pinnedSection: !!document.querySelector('[data-testid="sidebar-pinned"]'),
      width: innerWidth,
    }`);
    console.log(`first launch: ${JSON.stringify(state)}`);
    assert.equal(state.stored, null, "nothing pinned the column: the app chose it");
    assert.ok(state.column && !state.rail, "the kinds as a column, no rail");
    assert.equal(state.filter, "Filter kinds…");
    assert.equal(state.pinnedSection, false, "the default pins are not repeated above their own entries");
    for (const label of ["Pods", "Deployments", "Services", "Config Maps", "Nodes", "Releases"]) await kindButton(app, label);
    await shots(app, "first-launch");
  });

  it("every kind has an icon; common kinds first, the rest under More; Helm after Cluster", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await waitLive(app);
    const noIcon = await app.js(
      `return Array.from(document.querySelectorAll('[data-testid="sidebar-kinds"] button.kind')).filter((b) => !b.querySelector("svg[data-icon]")).map((b) => b.textContent.trim())`,
    );
    assert.deepEqual(noIcon, [], "every kind has an icon");
    const workloads = await labels(app, "workloads");
    console.log(`workloads: ${JSON.stringify(workloads)}`);
    assert.deepEqual(workloads.slice(0, 8), ["Overview", "Applications", "Pods", "Deployments", "StatefulSets", "DaemonSets", "Jobs", "CronJobs"]);
    assert.ok(!workloads.includes("ReplicaSets"), "ReplicaSets waits under More");
    const order = await groups(app);
    console.log(`sections: ${JSON.stringify(order)}`);
    assert.equal(order.indexOf("helm"), order.indexOf("cluster") + 1);
    await shots(app, "expanded");

    const more = await app.find(By.css('[data-testid="sidebar-more"][data-section="workloads"]'));
    assert.equal((await more.getText()).trim(), "1 more");
    await more.click();
    await app.waitFor(async () => (await labels(app, "workloads")).includes("ReplicaSets"), { message: "ReplicaSets under More" });
    await app.shot("more-open");
    await (await app.find(By.css('[data-testid="sidebar-more"][data-section="workloads"]'))).click();
    await app.waitFor(async () => !(await labels(app, "workloads")).includes("ReplicaSets"), { message: "More closed" });
  });

  it("the filter keeps what matches and drops empty sections", T, async () => {
    const { app } = s;
    await setFilter(app, "helm");
    await app.waitFor(async () => JSON.stringify(await groups(app)) === '["helm"]', { message: "only Helm" });
    const heads = await app.js(`return Array.from(document.querySelectorAll('[data-testid="sidebar-kinds"] h4'), (h) => h.textContent.trim())`);
    assert.deepEqual(heads, ["Helm"], "no empty section heads");
    await shots(app, "filtered");

    await setFilter(app, "zzzz");
    const none = await app.find(byTestId("sidebar-no-match"));
    assert.equal(await none.getText(), "No kind matches “zzzz”.");
    await shots(app, "no-match");

    const input = await app.find(byTestId("sidebar-filter"));
    await input.sendKeys(Key.ESCAPE);
    await app.waitFor(async () => (await input.getAttribute("value")) === "", { message: "the filter cleared" });
    await kindButton(app, "Pods");
  });

  it("a kind pinned from its menu shows under Pinned and opens with its key", T, async () => {
    const { app } = s;
    const cm = await kindButton(app, "Config Maps");
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", cm);
    await app.driver.actions().contextClick(cm).perform();
    const pin = await app.find(By.xpath(`//*[@data-testid="context-menu"]//button[normalize-space()="Pin to top"]`));
    await pin.click();
    await app.find(By.css('[data-testid="sidebar-pinned"] button[aria-label="Config Maps (pinned)"]'));
    const pins = await app.js(
      `return Array.from(document.querySelectorAll('[data-testid="sidebar-pinned"] button.kind .label'), (l) => l.textContent.trim())`,
    );
    assert.deepEqual(pins, ["Pods", "Deployments", "Services", "Config Maps"], "the user's own pins, all shown");
    await app.js("document.activeElement?.blur()");
    await app.driver.actions().sendKeys("5").perform();
    await app.waitFor(
      () => app.js(`return !!document.querySelector('[data-group="config"] button.kind.active[data-view="v1/configmaps"]')`),
      { message: "Config Maps opened by 5" },
    );
    await waitLive(app);
    await app.js(`document.querySelector('[data-testid="sidebar-kinds"]').scrollIntoView({ block: "start" })`);
    await shots(app, "pinned");
    const pinned = await app.find(By.css('[data-testid="sidebar-pinned"] button[aria-label="Config Maps (pinned)"]'));
    await app.driver.actions().contextClick(pinned).perform();
    await (await app.find(By.xpath(`//*[@data-testid="context-menu"]//button[normalize-space()="Unpin"]`))).click();
    await app.waitFor(
      () => app.js(`return !document.querySelector('[data-testid="sidebar-pinned"] button[aria-label="Config Maps (pinned)"]')`),
      { message: "Config Maps unpinned" },
    );
  });

  it("collapsed: a rail of icons, 'All kinds' in words; G opens every kind", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await (await app.find(byTestId("chart-unpin"))).click();
    const rail = await app.find(byTestId("berths"));
    const icons = await app.js(`return Array.from(document.querySelectorAll('[data-testid="berth"] svg[data-icon]'), (s) => s.dataset.icon)`);
    console.log(`rail icons: ${JSON.stringify(icons)}`);
    assert.deepEqual(icons, ["dashboard", "pod", "deployment", "service"]);
    assert.ok((await (await app.find(byTestId("chart-toggle"))).getText()).includes("All kinds"));
    assert.ok(await rail.isDisplayed());
    await waitLive(app);
    await shots(app, "collapsed");

    await app.js("document.activeElement?.blur()");
    await app.driver.actions().sendKeys("g").perform();
    await app.find(byTestId("chart-lens"));
    await shots(app, "drawer");
    await app.driver.actions().sendKeys(Key.ESCAPE).perform();
    await (await app.find(byTestId("sidebar-expand"))).click();
    await app.find(By.css("nav:not(.floating) [data-testid=sidebar-kinds]"));
  });
});

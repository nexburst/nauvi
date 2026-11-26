// Helpers: treeNode (lib/tree.mjs), App.restart with the session's profile.
// Checks (#383) in WebKitGTK against kind:
// - Long context names: three contexts that reach the test cluster, named
//   like two EKS clusters of one account (ARNs that differ only in the
//   cluster name) and a 60-character plain name. The cluster tree, the
//   status bar and the header's selector show "payments-prod",
//   "payments-staging" and the 60-character name cut in the middle (its end
//   kept); the full names are in the tooltips. Selecting the second ARN
//   changes the status bar's label.
// - Sidebar sections: every section but Workloads collapsed by click (one
//   by the keyboard) fits the 800 px window without scrolling; the state
//   survives a restart (settings.json `collapsed_sections`); expanding again
//   brings the kinds back.
// Screenshots at 1280x800 in light and dark, expanded and collapsed.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Key } from "selenium-webdriver";
import { CONTEXT } from "../lib/app.mjs";
import { setTheme } from "../lib/theme.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { treeNode } from "../lib/tree.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const ARN = (name) => `arn:aws:eks:eu-west-1:123456789012:cluster/${name}`;
const PROD = ARN("payments-prod");
const STAGING = ARN("payments-staging");
const LONG = "team-platform-production-eu-west-1-cluster-blue-0123456789ab";
assert.equal(LONG.length, 60);
const COLLAPSE = ["Pinned", "Network", "Config", "Storage", "Cluster", "Access Control", "Device Resources", "Helm", "Custom Resources", "Other"];

const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-383-"));

/** The test cluster under three more names; the EKS-like one is current. */
function longNames() {
  const path = join(dir, "kubeconfig");
  const yaml = execFileSync("kubectl", ["config", "view", "--minify", "--flatten", "--context", CONTEXT], { encoding: "utf8" });
  writeFileSync(path, yaml, { mode: 0o600 });
  const env = { ...process.env, KUBECONFIG: path };
  const cfg = JSON.parse(execFileSync("kubectl", ["config", "view", "-o", "json"], { encoding: "utf8", env }));
  const ctx = cfg.contexts.find((c) => c.name === CONTEXT).context;
  for (const name of [PROD, STAGING, LONG]) {
    execFileSync("kubectl", ["config", "set-context", name, `--cluster=${ctx.cluster}`, `--user=${ctx.user}`], { env });
  }
  execFileSync("kubectl", ["config", "use-context", PROD], { env });
  return path;
}

/** The text and tooltip of node `id`'s name. */
const nodeName = (app, id) =>
  app.js(
    `const b = document.querySelector(arguments[0] + " > .row .name");
     return b ? [b.querySelector(".text").textContent.trim(), b.title] : null;`,
    treeNode(id),
  );
const statusCluster = (app) =>
  app.js(
    `const l = document.querySelector('[data-testid="status-cluster"] [data-testid="cluster-label"]');
     return l ? [l.textContent.trim(), l.title] : null;`,
  );
/** aria-expanded of each sidebar section head, by title. */
const sections = (app) =>
  app.js(
    `return Object.fromEntries(Array.from(document.querySelectorAll('[data-testid="sidebar-kinds"] h4 button.section'),
       (b) => [b.querySelector(".title").textContent.trim(), b.getAttribute("aria-expanded")]))`,
  );
const toggle = (app, title) =>
  app.js(
    `const b = Array.from(document.querySelectorAll('[data-testid="sidebar-kinds"] h4 button.section'))
       .find((b) => b.querySelector(".title").textContent.trim() === arguments[0]);
     if (!b) return false;
     b.scrollIntoView({ block: "center" });
     b.click();
     return true;`,
    title,
  );
/** How far down the column the shown cluster's kinds end, and the column's
 *  visible height (other clusters' nodes below them may scroll). */
const kindsFit = (app) =>
  app.js(`const b = document.querySelector("nav:not(.floating) .chart-body");
    const k = b?.querySelector('[data-testid="sidebar-kinds"]');
    if (!k) return null;
    return [Math.round(k.getBoundingClientRect().bottom - b.getBoundingClientRect().top + b.scrollTop), b.clientHeight];`);

async function shots(app, label) {
  for (const theme of ["light", "dark"]) {
    await setTheme(app, theme);
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

describe("collapsible sidebar and long context names", { timeout: 15 * 60_000 }, () => {
  after(() => rmSync(dir, { recursive: true, force: true }));
  const s = appSession("sidebar-collapse", () => ({ kubeconfig: longNames() }));

  it("shows short, distinct names for long contexts, the full name in the tooltip", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.waitFor(async () => (await nodeName(app, LONG)) !== null, { message: "the 60-character context's node" });
    const prod = await nodeName(app, PROD);
    const staging = await nodeName(app, STAGING);
    const long = await nodeName(app, LONG);
    console.log(`tree: ${JSON.stringify({ prod, staging, long })}`);
    assert.equal(prod[0], "payments-prod");
    assert.equal(staging[0], "payments-staging");
    assert.ok(long[0].includes("…") && long[0].endsWith("0123456789ab"), long[0]);
    assert.ok(prod[1].startsWith(PROD) && long[1].startsWith(LONG), "full names in the tooltips");
    const status = await statusCluster(app);
    console.log(`status bar: ${JSON.stringify(status)}`);
    assert.equal(status[0], "payments-prod");
    assert.ok(status[1].includes(PROD));
    const options = await app.js(`return Array.from(document.querySelectorAll('select[aria-label="Cluster context"] option'), (o) => o.textContent.trim())`);
    console.log(`selector: ${JSON.stringify(options)}`);
    assert.ok(options.includes("payments-prod") && options.includes("payments-staging"));
    await app.nav("Pods");
    await waitLive(app);
    await shots(app, "expanded");
  });

  it("selecting the other ARN shows its own name in the status bar", T, async () => {
    const { app } = s;
    await app.js(`document.querySelector(arguments[0] + " > .row .name").click()`, treeNode(STAGING));
    await app.waitFor(async () => (await statusCluster(app))?.[0] === "payments-staging", { message: "payments-staging in the status bar" });
    await waitLive(app);
    await app.js(`document.querySelector(arguments[0] + " > .row .name").click()`, treeNode(PROD));
    await app.waitFor(async () => (await statusCluster(app))?.[0] === "payments-prod", { message: "payments-prod in the status bar" });
    await waitLive(app);
  });

  it("collapses every section but Workloads, by click and keyboard, and fits 800 px", T, async () => {
    const { app } = s;
    for (const title of COLLAPSE.filter((t) => t !== "Network")) assert.ok(await toggle(app, title), `the ${title} head`);
    // Network by the keyboard: focus its head and press Enter.
    const head = await app.js(
      `return Array.from(document.querySelectorAll('[data-testid="sidebar-kinds"] h4 button.section')).find((b) => b.querySelector(".title").textContent.trim() === "Network")`,
    );
    await app.js("arguments[0].focus()", head);
    await app.driver.actions().sendKeys(Key.ENTER).perform();
    await app.waitFor(async () => (await sections(app)).Network === "false", { message: "Network collapsed by Enter" });
    const state = await sections(app);
    console.log(`sections: ${JSON.stringify(state)}`);
    for (const title of COLLAPSE) assert.equal(state[title], "false", `${title} collapsed`);
    assert.equal(state.Workloads, "true");
    await app.nav("Overview");
    // payments-staging stayed expanded from the switch: fold it again.
    await app.js(`document.querySelector(arguments[0] + " > .row .chevron[aria-expanded=true]")?.click()`, treeNode(STAGING));
    const [bottom, client] = await kindsFit(app);
    console.log(`sidebar: kinds end at ${bottom}, column height ${client}`);
    assert.ok(bottom <= client, `the kinds fit: ${bottom} <= ${client}`);
    await shots(app, "collapsed");
  });

  it("the collapsed sections survive a restart, and open again", T, async () => {
    const { app } = s;
    await app.restart();
    await app.waitFor(async () => Object.keys(await sections(app)).length > 0, { timeout: 60_000, message: "the sidebar" });
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    const state = await sections(app);
    for (const title of COLLAPSE) assert.equal(state[title], "false", `${title} still collapsed`);
    const saved = app.profile.settings().collapsed_sections;
    console.log(`settings.json collapsed_sections: ${JSON.stringify(saved)}`);
    assert.equal(saved.length, COLLAPSE.length);
    await shots(app, "collapsed-after-restart");
    assert.ok(await toggle(app, "Network"));
    await app.waitFor(async () => (await sections(app)).Network === "true", { message: "Network expanded" });
    await app.nav("Services");
    await waitLive(app);
  });
});

// QA area 1 (#83): switching contexts in one window (#18, #19, #21).
// Checks: with two contexts the context select shows and lists both;
// switching closes the open panel, resets the view to the Overview, reloads
// the Overview, re-runs discovery (which kinds are greyed out) and reloads the
// namespace list; switching back restores the admin view of the cluster.
//
// The second context is the namespace-scoped user from limited-user.sh
// (KUBELOUPE_LIMITED_KUBECONFIG), on the same kind cluster, so discovery and
// the namespace list really differ. Without it, the second context is the
// admin context under another name, and only the reset and reload are
// checked. Only reads the cluster.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT } from "../lib/app.mjs";
import { podNames } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { namespaceLabel, namespaceOptions, openNamespacePicker, closeNamespacePicker } from "../lib/table.mjs";

const T = { timeout: 150_000 };
const limited = process.env.KUBELOUPE_LIMITED_KUBECONFIG;
const hasLimited = !!limited && existsSync(limited);

const dir = mkdtempSync(join(tmpdir(), "kubeloupe-qa-area1-"));
const view = (args, env = {}) =>
  execFileSync("kubectl", ["config", "view", "--flatten", ...args], { encoding: "utf8", env: { ...process.env, ...env } });

/** A kubeconfig with the admin context first and a second one. */
function twoContexts() {
  const admin = join(dir, "admin");
  writeFileSync(admin, view(["--minify", "--context", CONTEXT]), { mode: 0o600 });
  let other;
  let second;
  if (hasLimited) {
    other = limited;
    second = execFileSync("kubectl", ["config", "current-context"], { encoding: "utf8", env: { ...process.env, KUBECONFIG: limited } }).trim();
  } else {
    second = `${CONTEXT}-qa-alias`;
    other = join(dir, "alias");
    // Every name (context, cluster, user) renamed; the server is the same.
    writeFileSync(other, view(["--minify", "--context", CONTEXT]).replaceAll(CONTEXT, second), { mode: 0o600 });
  }
  const path = join(dir, "kubeconfig");
  writeFileSync(path, view([], { KUBECONFIG: `${admin}:${other}` }), { mode: 0o600 });
  return { path, second };
}

const { path: kubeconfig, second: SECOND } = twoContexts();

const panelTitle = (app) => app.js(`return document.querySelector('[data-testid="detail-panel"] .title')?.textContent ?? ""`);
const activeView = (app) => app.js(`return document.querySelector("nav button.active")?.textContent.trim() ?? ""`);
const denied = (app) => app.js(`return Array.from(document.querySelectorAll("nav button.denied"), (b) => b.childNodes[0].textContent.trim())`);
const cards = (app) =>
  app.js(`return Array.from(document.querySelectorAll(".overview .card .label"), (l) => l.textContent.trim())`);

async function switchTo(app, name) {
  const select = await app.find(By.css('select[aria-label="Cluster context"]'));
  await app.js('arguments[0].value = arguments[1]; arguments[0].dispatchEvent(new Event("change", { bubbles: true }))', select, name);
  await app.waitFor(async () => (await select.getAttribute("value")) === name, { message: `context ${name} selected` });
}

describe("area 1: switching contexts", { timeout: 10 * 60_000 }, () => {
  after(() => rmSync(dir, { recursive: true, force: true }));
  const s = appSession("area-1-contexts", { kubeconfig });

  it("the context select shows both contexts", T, async () => {
    const { app } = s;
    await waitLive(app);
    const select = await app.find(By.css('select[aria-label="Cluster context"]'));
    assert.doesNotMatch(await select.getAttribute("class"), /invisible/);
    const options = await app.js("return Array.from(arguments[0].options, (o) => o.value)", select);
    assert.deepEqual(options.sort(), [CONTEXT, SECOND].sort());
    assert.equal(await select.getAttribute("value"), CONTEXT);
  });

  it(`switching to ${SECOND} closes the panel, resets the view and reloads everything`, T, async () => {
    const { app } = s;
    const [pod] = podNames("demo", "app=web");
    await app.openDetail("Pods", "demo", pod);
    await switchTo(app, SECOND);
    await app.waitFor(async () => (await activeView(app)) === "Overview", { message: "the Overview view" });
    assert.equal(await panelTitle(app), "", "the detail panel closed");
    await waitLive(app);
    await app.find(By.css(".overview .card"));
    if (hasLimited) {
      // Discovery and access checks for the new user.
      await app.waitFor(async () => (await denied(app)).includes("Nodes"), { timeout: 30_000, message: "Nodes greyed out" });
      await app.waitFor(async () => (await cards(app)).includes("Pods in team-a"), { message: "the team-a Overview" });
      assert.ok(!(await cards(app)).includes("Namespaces"));
      await app.nav("Pods");
      await waitLive(app);
      assert.equal(await namespaceLabel(app), "team-a");
      const pop = await openNamespacePicker(app);
      assert.equal(await (await pop.findElement(By.css("input"))).getAttribute("placeholder"), "Type a namespace…");
      assert.deepEqual(await namespaceOptions(app), ["team-a"]);
      await app.shot("limited-namespaces");
      await closeNamespacePicker(app);
    } else {
      assert.ok((await cards(app)).includes("Namespaces"));
    }
  });

  it(`switching back to ${CONTEXT} restores the admin view`, T, async () => {
    const { app } = s;
    await switchTo(app, CONTEXT);
    await app.waitFor(async () => (await activeView(app)) === "Overview", { message: "the Overview view" });
    await waitLive(app);
    await app.waitFor(async () => (await cards(app)).includes("Namespaces"), { message: "the Namespaces card" });
    await app.waitFor(async () => (await denied(app)).length === 0, { timeout: 30_000, message: "nothing greyed out" });
    await app.nav("Pods");
    await waitLive(app);
    assert.equal(await namespaceLabel(app), "All namespaces");
    await openNamespacePicker(app);
    const options = await namespaceOptions(app);
    assert.ok(["default", "demo", "kube-system"].every((n) => options.includes(n)), `options: ${options}`);
    await closeNamespacePicker(app);
  });
});

// Plain error messages (#131, #103, #99). Checks, in both themes:
// - no kubeconfig at all (KUBECONFIG unset, no ~/.kube/config in the app's
//   own HOME): the banner says "No kubeconfig found (looked at …)" and what
//   to do, the status says "No kubeconfig"; no in-cluster attempt, no Rust
//   debug text
// - as the namespace-scoped user (skipped unless KUBELOUPE_LIMITED_KUBECONFIG
//   names limited-user.sh's kubeconfig): the 403 banners carry the API
//   server's message once, without kube's `ErrorResponse { … }` dump; the
//   "Pods in team-a" card label stays on one line
// - Create with a field of the wrong type: "The cluster rejected the YAML:
//   .data.k: expected string, got a list.", not "The API server failed (500)"
//
// The Create check uses its own temporary namespace.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { bannerText, closeNamespacePicker, openNamespacePicker } from "../lib/table.mjs";
import { editor, openKind, setEditorValue, setTheme } from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RAW = /ErrorResponse|ApiError|in-cluster|failed to infer|valueUnstructured|\\\\/;

async function bothThemes(app, label) {
  for (const theme of ["light", "dark"]) {
    await setTheme(app, theme);
    await sleep(300);
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

describe("errors: no kubeconfig at all", { timeout: 10 * 60_000 }, () => {
  // A kubeconfig path is needed so the harness does not write its own; the
  // app then gets no KUBECONFIG, and its HOME has no .kube/config.
  const s = appSession("errors-no-kubeconfig", {
    kubeconfig: "/nonexistent-qa-errors/config",
    env: { KUBECONFIG: undefined },
  });

  it("says no kubeconfig was found, where it looked, and what to do", T, async () => {
    const { app } = s;
    const text = await app.waitFor(
      async () => {
        const t = await bannerText(app);
        return t.length > 0 ? t : null;
      },
      { timeout: 60_000, message: "an error banner" },
    );
    console.log(`banner: ${text}`);
    console.log(`status: ${await app.statusText()}`);
    assert.match(text, /No kubeconfig found \(looked at .*\.kube[/\\]config; KUBECONFIG is not set\)\./);
    assert.match(text, /Open the cluster catalog/);
    assert.doesNotMatch(text, RAW);
    assert.doesNotMatch(text, /Could not reach the cluster/);
    assert.equal(await app.statusText(), "No kubeconfig");
    await bothThemes(app, "no-kubeconfig");
  });
});

const limited = process.env.KUBELOUPE_LIMITED_KUBECONFIG;
const skipLimited = limited && existsSync(limited) ? false : "set KUBELOUPE_LIMITED_KUBECONFIG (limited-user.sh)";

describe("errors: 403s as the namespace-scoped user", { timeout: 10 * 60_000, skip: skipLimited }, () => {
  const s = appSession("errors-limited", { kubeconfig: limited });

  it('the "Pods in team-a" card label stays on one line', T, async () => {
    const { app } = s;
    await waitLive(app);
    const label = await app.waitFor(
      () =>
        app.js(`
          const l = Array.from(document.querySelectorAll(".overview .card .label")).find((l) => l.textContent.trim() === "Pods in team-a");
          if (!l) return null;
          return { height: l.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(l).lineHeight) || 16,
                   clipped: l.scrollWidth > l.clientWidth, title: l.closest(".card").title };`),
      { message: 'the "Pods in team-a" card' },
    );
    console.log(`label: ${JSON.stringify(label)}`);
    assert.ok(label.height < label.lineHeight * 1.5, `one line: ${JSON.stringify(label)}`);
    assert.equal(label.clipped, false, "the whole label shows");
    assert.equal(label.title, "Pods in team-a");
    await bothThemes(app, "overview-card");
  });

  it("All namespaces: the banner has the API server's message once, no debug dump", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await waitLive(app);
    await openNamespacePicker(app);
    await app.js(`document.querySelector('[aria-label="Namespaces"] .option.all input').click()`);
    await closeNamespacePicker(app);
    await app.waitFor(async () => (await app.statusText()) === "Not allowed", { message: 'status "Not allowed"' });
    const text = await bannerText(app);
    console.log(`banner: ${text}`);
    assert.match(text, /^You can't list Pods across all namespaces\. Pick a namespace you have access to\. \(pods is forbidden: /);
    assert.doesNotMatch(text, RAW);
    assert.doesNotMatch(text, /initial object list/);
    assert.equal(text.split("pods is forbidden").length - 1, 1, "the API message appears once");
    await bothThemes(app, "all-namespaces-forbidden");
  });
});

describe("errors: Create with a field of the wrong type", { timeout: 10 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-errors");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("errors-create");

  it("says the cluster rejected the YAML and why, not that the server failed", T, async () => {
    const { app } = s;
    await waitLive(app);
    await openKind(app, "Config Maps", ns);
    await (await app.find(By.xpath("//button[normalize-space()='+ Create']"))).click();
    await app.find(byTestId("create-dialog"));
    const el = await editor(app, "create-editor");
    await setEditorValue(app, el, "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: qa-bad\ndata:\n  k: [not, a, string]\n");
    await (
      await app.find(By.xpath(`//*[@data-testid='create-dialog']//button[normalize-space()=${xq("Validate")}]`))
    ).click();
    const result = await app.waitFor(
      async () => {
        const r = await app.js(
          `return Array.from(document.querySelectorAll('[data-testid="create-result"]'), (r) => r.innerText.replace(/\\s+/g, " ").trim()).join("\\n")`,
        );
        return /Failed/.test(r) ? r : null;
      },
      { timeout: 60_000, message: "a failed result" },
    );
    console.log(`result: ${result}`);
    assert.match(result, /The cluster rejected the YAML: \.data\.k: expected string, got a list\./);
    assert.doesNotMatch(result, /API server failed|valueUnstructured|typed patch/);
    await bothThemes(app, "create-wrong-type");
  });
});

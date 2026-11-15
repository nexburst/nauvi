// QA area 5 (#83): the cluster catalog and per-cluster settings (PR #102)
// beyond catalog.test.mjs.
// Checks: the catalog table and a cluster's settings page at 1280x800 in
// Dark and Light (screenshots); display name and colour show in the context
// selector; Pinned puts the cluster in a "Pinned" group of the selector and
// first in the palette; a file added to a watched folder while the app runs
// shows up in the selector within seconds; the default namespace is where
// the added cluster opens; a local terminal on the added context: kubectl
// uses the file's context name, in the cluster's working directory.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { CONTEXT, byTestId } from "../lib/app.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { namespaceLabel } from "../lib/table.mjs";
import { terminal } from "../lib/terminal.mjs";
import { resizeWindow, selectContext } from "../lib/window.mjs";

const T = { timeout: 120_000 };
const dir = mkdtempSync(join(tmpdir(), "kubeloupe-qa-area5-catalog-"));
const folder = join(dir, "clusters");
const cwd = join(dir, "work dir");
const ADDED = "qa-area5-cat";
const LATER = "qa-area5-later";
const NAME = "QA Area Five";
const COLOUR = "#22c55e";
mkdirSync(folder, { recursive: true });
mkdirSync(cwd, { recursive: true });

/** The test context, renamed to `name`, as `file`. */
function writeRenamed(file, name) {
  writeFileSync(file, execFileSync("kubectl", ["config", "view", "--minify", "--flatten", "--context", CONTEXT], { encoding: "utf8" }), {
    mode: 0o600,
  });
  execFileSync("kubectl", ["--kubeconfig", file, "config", "rename-context", CONTEXT, name], { stdio: "pipe" });
}
writeRenamed(join(folder, "cat.yaml"), ADDED);

const click = (app, css) =>
  app.js(
    `const el = document.querySelector(arguments[0]); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true;`,
    css,
  );
const options = (app) =>
  app.js(`return Array.from(document.querySelectorAll('select[aria-label="Cluster context"] option'), (o) => ({
    value: o.value, text: o.textContent.trim(), group: o.parentElement.tagName === "OPTGROUP" ? o.parentElement.label : "" }));`);
const row = (id) => `[data-testid="catalog-row"][data-context=${JSON.stringify(id)}]`;

async function openCatalog(app) {
  await click(app, 'button[aria-label="Cluster catalog"]');
  await app.find(byTestId("catalog"));
}

async function setTheme(app, theme) {
  await app.js("document.activeElement?.blur()");
  await app.driver.actions().keyDown(Key.CONTROL).sendKeys(",").keyUp(Key.CONTROL).perform();
  await app.find(byTestId("settings"));
  await app.js(`document.querySelector('[data-testid="settings"] input[name="theme"][value="${theme}"]').click()`);
  await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
}

describe("area 5: cluster catalog and per-cluster settings", { timeout: 15 * 60_000 }, () => {
  after(() => rmSync(dir, { recursive: true, force: true }));
  const s = appSession("area-5-catalog");

  it("adds a folder; the catalog at 1280x800 (dark)", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    await openCatalog(app);
    await app.waitFor(
      () =>
        app.js(
          `const b = Array.from(document.querySelectorAll('[data-testid="catalog"] button')).find((b) => b.textContent.trim() === "Add kubeconfig…");
           b?.click();
           return !!b;`,
        ),
      { message: "the Add kubeconfig… button" },
    );
    await app.setValue(await app.find(By.css('input[aria-label="Kubeconfig file or folder"]')), folder);
    await click(app, 'form[aria-label="Add kubeconfig"] button[type="submit"]');
    await app.waitFor(
      async () => (await app.js(`return document.querySelector(arguments[0])?.querySelector('[data-testid="catalog-status"]')?.innerText.trim() ?? ""`, row(ADDED))) === "Connected",
      { timeout: 40_000, message: `${ADDED} connected` },
    );
    const overflow = await app.js(`const c = document.querySelector('[data-testid="catalog"]'); return { scrollW: c.scrollWidth, clientW: c.clientWidth };`);
    console.log(`catalog: ${JSON.stringify(overflow)}`);
  });

  it("a cluster's settings: display name, colour, pinned, default namespace, folder (dark)", T, async () => {
    const { app } = s;
    await click(app, `${row(ADDED)} button[aria-label="Settings for ${ADDED}"]`);
    const dialog = await app.find(byTestId("cluster-settings"));
    const input = async (label) => dialog.findElement(By.css(`input[aria-label="${label}"]`));
    await app.setValue(await input("Display name"), NAME);
    await app.setValue(await input("Default namespace"), "demo");
    await app.setValue(await input("Working directory"), cwd);
    await (await dialog.findElement(By.css(`button[aria-label="Colour ${COLOUR}"]`))).click();
    await app.js(
      `Array.from(arguments[0].querySelectorAll("label.choice")).find((l) => l.textContent.includes("Pinned")).querySelector("input").click()`,
      dialog,
    );
    await app.waitFor(
      () => {
        const c = app.profile.settings()?.contexts?.[ADDED];
        return c?.display_name === NAME && c.color === COLOUR && c.default_namespace === "demo" && c.shell_cwd === cwd;
      },
      { message: "the cluster's settings saved" },
    );
    assert.deepEqual(app.profile.settings().favourites, [ADDED]);
    console.log(`settings: ${JSON.stringify(app.profile.settings().contexts[ADDED])}`);
  });

  it("the selector shows the name in a Pinned group; the palette lists it first", T, async () => {
    const { app } = s;
    await (await app.find(By.xpath("//*[@data-testid='cluster-settings']//button[normalize-space()='Close']"))).click();
    const opts = await options(app);
    console.log(`selector: ${JSON.stringify(opts)}`);
    const pinned = opts.find((o) => o.value === ADDED);
    assert.equal(pinned.text, NAME);
    assert.equal(pinned.group, "Pinned");
    await app.js("document.activeElement?.blur()");
    await app.driver.actions().keyDown(Key.CONTROL).sendKeys("k").keyUp(Key.CONTROL).perform();
    const input = await app.find(By.css('[data-testid="command-palette"] input[role="combobox"]'));
    await input.sendKeys("ctx ");
    await app.waitFor(
      async () => (await app.js(`return document.querySelector('[data-testid="command-palette"] [role="option"]')?.textContent ?? ""`)).includes(NAME),
      { message: `${NAME} first among the contexts` },
    );
    await app.shot("palette-pinned");
    await input.sendKeys(Key.ESCAPE);
    await app.shot("catalog-dark");
  });

  it("opens the added cluster in its default namespace with its colour", T, async () => {
    const { app } = s;
    await selectContext(app, ADDED);
    await waitLive(app);
    await app.nav("Pods");
    await app.waitFor(async () => (await namespaceLabel(app)).includes("demo"), { message: "namespace demo" });
    const swatch = await app.js(`return getComputedStyle(document.querySelector('[data-testid="context-color"]')).backgroundColor`);
    console.log(`namespace: ${await namespaceLabel(app)}, swatch ${swatch}`);
    assert.equal(swatch, "rgb(34, 197, 94)");
  });

  it("a local terminal uses the file's context and the cluster's folder", T, async () => {
    const { app } = s;
    await app.palette("local term", "New local terminal");
    const term = terminal(app);
    await term.waitForPrompt(30_000);
    const ctx = await term.run("kubectl config current-context");
    const pwd = await term.run("pwd");
    console.log(`current-context ${ctx}, pwd ${pwd}`);
    assert.equal(ctx, ADDED);
    assert.equal(pwd, cwd);
    assert.match(await term.run("kubectl get ns demo -o name"), /^namespace\/demo$/);
  });

  it("a file added to the folder shows up in the selector", T, async () => {
    const { app } = s;
    const t0 = Date.now();
    writeRenamed(join(folder, "later.yaml"), LATER);
    await app.waitFor(async () => (await options(app)).some((o) => o.value === LATER), { timeout: 20_000, message: `${LATER} in the selector` });
    console.log(`${LATER} appeared after ${Date.now() - t0} ms`);
  });

  it("the catalog and a cluster's settings in Light", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await openCatalog(app);
    await app.waitFor(async () => (await app.js(`return document.querySelectorAll('[data-testid="catalog-row"]').length`)) >= 3, {
      message: "three clusters",
    });
    await app.shot("catalog-light");
    await click(app, `${row(ADDED)} button[aria-label="Settings for ${NAME}"]`);
    await app.find(byTestId("cluster-settings"));
  });
});

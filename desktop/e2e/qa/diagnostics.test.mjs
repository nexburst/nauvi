// #208: the app log, the Help menu and About in WebKitGTK.
// - the app writes nauvi.log in its log folder (0600, the folder 0700),
//   starting with the version, commit, OS and webview
// - Help (header) lists Documentation, Report a bug, Open log folder and
//   About; each opens what it says (the xdg-open recorder sees the README,
//   a prefilled new-issue URL and the log folder)
// - About (Settings) shows the version and commit; Copy diagnostics copies
//   them with the OS and webview, and nothing about the user or the cluster
// - an uncaught error in the page reaches the log, with a token in it masked,
//   on one line: newlines, bidi overrides and line separators flattened (#264)
// Screenshots: the Help menu and About at 1280x800, dark and light.

import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId, CONTEXT } from "../lib/app.mjs";
import { hookClipboard, hookedClipboard, readSystemClipboard } from "../lib/clipboard.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 120_000 };
const README = "https://github.com/nexburst/nauvi#readme";
const NEW_ISSUE = "https://github.com/nexburst/nauvi/issues/new?";

const logDir = (app) => join(app.profile.home, ".local", "share", "com.nauvi.app", "logs");
const logText = (app) => readFileSync(join(logDir(app), "nauvi.log"), "utf8");

async function openHelp(app) {
  await (await app.find(byTestId("help-menu-button"))).click();
  return app.find(byTestId("context-menu"));
}

async function pickHelp(app, label) {
  const menu = await openHelp(app);
  await (await menu.findElement(By.xpath(`.//button[@role='menuitem'][normalize-space()=${JSON.stringify(label)}]`))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("context-menu"))).length === 0, {
    message: "the Help menu closed",
  });
}

async function closeSettings(app) {
  await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("settings"))).length === 0, {
    message: "Settings closed",
  });
}

describe("diagnostics: app log, Help menu, About", { timeout: 8 * 60_000 }, () => {
  const s = appSession("diagnostics");

  it("the app log is private and starts with the version", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    const dir = logDir(app);
    const file = join(dir, "nauvi.log");
    await app.waitFor(() => existsSync(file), { message: `${file} exists` });
    assert.equal(statSync(dir).mode & 0o777, 0o700, "the log folder is 0700");
    assert.equal(statSync(file).mode & 0o777, 0o600, "the log is 0600");
    const first = logText(app).split("\n")[0];
    console.log(`log line 1: ${first}`);
    assert.match(first, /nauvi \d+\.\d+\.\d+ \([0-9a-z]+\) starting on .+, webview WebKitGTK/);
  });

  it("Help menu (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    const menu = await openHelp(app);
    const items = await app.js(
      "return Array.from(arguments[0].querySelectorAll('[role=menuitem]'), (b) => b.textContent.trim())",
      menu,
    );
    assert.deepEqual(items, ["Documentation", "Report a bug…", "Open log folder", "About nauvi"]);
    // In the window, under the header.
    const rect = await app.js("return arguments[0].getBoundingClientRect().toJSON()", menu);
    assert.ok(rect.right <= 1280 && rect.top >= 40, `menu at ${JSON.stringify(rect)}`);
  });

  it("each Help item opens what it says", T, async () => {
    const { app } = s;
    await app.driver.actions().sendKeys("").perform(); // Escape
    await pickHelp(app, "Documentation");
    await pickHelp(app, "Report a bug…");
    await pickHelp(app, "Open log folder");
    const opened = await app.waitFor(() => (app.profile.opened().length >= 3 ? app.profile.opened() : null), {
      message: "three URLs opened",
    });
    console.log(`opened: ${opened.map((u) => u.slice(0, 120)).join(" | ")}`);
    assert.equal(opened[0], README);
    assert.ok(opened[1].startsWith(NEW_ISSUE), opened[1]);
    const body = new URL(opened[1]).searchParams.get("body");
    assert.match(body, /Commit: [0-9a-z]+/);
    assert.match(body, /Webview: WebKitGTK/);
    assert.ok(!body.includes(app.profile.home), "no home folder in the bug report");
    assert.ok(!body.includes(CONTEXT), "no context name in the bug report");
    assert.equal(opened[2], logDir(app));
    // No error notice.
    assert.equal((await app.driver.findElements(By.css('[role="alert"]'))).length, 0);
  });

  it("About (dark)", T, async () => {
    const { app } = s;
    await pickHelp(app, "About nauvi");
    const about = await app.find(byTestId("about-settings"));
    await app.waitFor(async () => (await about.getText()).includes("commit"), { message: "the version shown" });
    await app.waitFor(
      () =>
        app.js(
          "const r = arguments[0].getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight",
          about,
        ),
      { message: "About scrolled into view" },
    );
    console.log(`about: ${await (await app.find(byTestId("about-version"))).getText()}`);
  });

  it("Copy diagnostics has no user, path or cluster in it", T, async () => {
    const { app } = s;
    await hookClipboard(app);
    const expected = await (await app.find(byTestId("diagnostics-text"))).getText();
    await (await app.find(By.xpath("//*[@data-testid='about-settings']//button[normalize-space()='Copy diagnostics']"))).click();
    await app.waitFor(async () => (await (await app.find(byTestId("diagnostics-copied"))).getText()) !== "", {
      message: "the copy result",
    });
    const status = await (await app.find(byTestId("diagnostics-copied"))).getText();
    assert.equal(status, "Copied.");
    const sys = readSystemClipboard();
    const text = sys !== null ? sys : (await hookedClipboard(app)).at(-1);
    console.log(`copied (${sys !== null ? "system" : "hook"}):\n${text}`);
    assert.equal(text.trim(), expected.trim());
    for (const line of ["nauvi ", "Commit: ", "OS: ", "Webview: WebKitGTK"]) assert.ok(text.includes(line), line);
    assert.ok(!text.includes(app.profile.home), "no home folder");
    assert.ok(!text.includes(CONTEXT), "no context name");
    assert.ok(!/https?:\/\//.test(text), "no server URL");
  });

  it("About (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await app.js(`document.querySelector('[data-testid="about-settings"]').scrollIntoView({ block: "center" })`);
  });

  it("Help menu (light)", T, async () => {
    const { app } = s;
    await closeSettings(app);
    await openHelp(app);
  });

  it("an uncaught page error reaches the log, its token masked", T, async () => {
    const { app } = s;
    await app.driver.actions().sendKeys("").perform();
    await app.js(`setTimeout(() => { throw new Error("qa208 boom token=qa208-not-for-logs"); })`);
    await app.waitFor(() => logText(app).includes("qa208 boom"), { message: "the UI error in the log" });
    const line = logText(app).split("\n").find((l) => l.includes("qa208 boom"));
    console.log(`log: ${line}`);
    assert.match(line, /UI error \(error\) in window main: Error: qa208 boom token=\[redacted\]/);
    assert.ok(!logText(app).includes("qa208-not-for-logs"), "the token is not in the log");
    await setTheme(app, null);
  });

  // #264: a message can't forge a log line or hide text with bidi controls.
  it("an error with newlines, bidi overrides and line separators is one log line", T, async () => {
    const { app } = s;
    const forged = "2026-01-01T00:00:00.000000Z  INFO nauvi: qa264 forged";
    await app.js(
      `const e = new Error("qa264 start\\n" + arguments[0] + "\\r\\nqa264 \\u202Eevil\\u202C \\u2066iso\\u2069 \\u2028sep\\u2029end");
       e.stack = "Error: qa264\\n    at one (a.js:1:1)\\n    at two (b.js:2:2)";
       setTimeout(() => { throw e; });`,
      forged,
    );
    await app.waitFor(() => logText(app).includes("qa264 start"), { message: "the qa264 error in the log" });
    const text = logText(app);
    const lines = text.split("\n").filter((l) => l.includes("qa264"));
    console.log(`log: ${JSON.stringify(lines)}`);
    assert.equal(lines.length, 1, "one line for the whole error");
    assert.ok(!text.split("\n").some((l) => l.startsWith(forged)), "no line starts with the forged text");
    assert.match(lines[0], /UI error \(error\) in window main: .*qa264 start 2026-01-01T00:00:00\.000000Z {2}INFO/);
    assert.match(lines[0], /qa264 {2}evil  {2}iso {3}sep end/);
    assert.ok(!/[\u202A-\u202E\u2066-\u2069\u2028\u2029\r]/.test(text), "no bidi controls or separators in the log");
  });
});

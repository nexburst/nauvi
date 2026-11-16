// Starts the real desktop app under tauri-driver and wraps the WebDriver
// session in a few helpers. Used by smoke.test.mjs, bench.mjs and the QA
// scenarios in qa/.
//
// Environment (all optional):
//   KUBELOUPE_APP   path to the built app (default: <target>/debug/kubeloupe-desktop)
//   TAURI_DRIVER    path to tauri-driver (default: on PATH)
//   WEBKIT_DRIVER   path to WebKitWebDriver (default: tauri-driver's lookup on PATH)
//   NATIVE_DRIVER   same, for any platform (Windows: msedgedriver.exe)
//   E2E_CONTEXT     kube context to test against (default: kind-kubeloupe-test)
//   E2E_ARTIFACTS   where screenshots and logs go (default: desktop/e2e/artifacts)
//   E2E_DRIVER_PORT port for tauri-driver (default: 4444; the native driver gets +1)

import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Builder, By, Key } from "selenium-webdriver";
import { createProfile } from "./profile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const E2E_DIR = resolve(here, "..");
export const REPO = resolve(E2E_DIR, "../..");
export const CONTEXT = process.env.E2E_CONTEXT || "kind-kubeloupe-test";
export const ARTIFACTS = resolve(process.env.E2E_ARTIFACTS || join(E2E_DIR, "artifacts"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function appBinary() {
  if (process.env.KUBELOUPE_APP) return resolve(process.env.KUBELOUPE_APP);
  const target = process.env.CARGO_TARGET_DIR ? resolve(process.env.CARGO_TARGET_DIR) : join(REPO, "target");
  return join(target, "debug", process.platform === "win32" ? "kubeloupe-desktop.exe" : "kubeloupe-desktop");
}

/**
 * A kubeconfig holding only the given contexts (default: the test context),
 * so the app picks the first one no matter what the developer's own
 * kubeconfig has as current.
 */
function testKubeconfig(contexts = [CONTEXT]) {
  // Holds credentials: private directory, removed when the app stops.
  const dir = mkdtempSync(join(tmpdir(), "kubeloupe-e2e-"));
  const parts = contexts.map((ctx, i) => {
    const part = join(dir, `part-${i}`);
    const yaml = execFileSync("kubectl", ["config", "view", "--minify", "--flatten", "--context", ctx], {
      encoding: "utf8",
    });
    writeFileSync(part, yaml, { mode: 0o600 });
    return part;
  });
  // kubectl merges KUBECONFIG lists; the first file's current-context wins.
  const merged = execFileSync("kubectl", ["config", "view", "--flatten"], {
    encoding: "utf8",
    env: { ...process.env, KUBECONFIG: parts.join(delimiter) },
  });
  const path = join(dir, "kubeconfig");
  writeFileSync(path, merged, { mode: 0o600 });
  for (const part of parts) rmSync(part);
  return { dir, path };
}

/**
 * Process groups of running apps, killed when this process exits however it
 * exits. qa.sh also gets them through $QA_RUN_DIR, for a `kill -9` of node.
 */
const groups = new Set();
const WINDOWS = process.platform === "win32";

/** Kill tauri-driver and everything under it (the native driver, the app). */
function killTree(pid) {
  try {
    if (WINDOWS) execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

process.once("exit", () => {
  for (const pgid of groups) killTree(pgid);
});

function trackGroup(pgid) {
  groups.add(pgid);
  if (process.env.QA_RUN_DIR) writeFileSync(join(process.env.QA_RUN_DIR, `pgid-${pgid}`), String(pgid));
}

function untrackGroup(pgid) {
  groups.delete(pgid);
  if (process.env.QA_RUN_DIR) rmSync(join(process.env.QA_RUN_DIR, `pgid-${pgid}`), { force: true });
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolvePromise, reject) => {
    const attempt = () => {
      const sock = connect(port, "127.0.0.1");
      sock.once("connect", () => {
        sock.destroy();
        resolvePromise();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error(`nothing listens on port ${port}`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

/**
 * Start tauri-driver and open a session, which launches the app. `name`
 * prefixes the log and screenshot files.
 *
 * Options (all optional):
 *   kubeconfig  use this kubeconfig file as-is (e.g. the limited user)
 *   contexts    otherwise: a kubeconfig made of these contexts (default [E2E_CONTEXT])
 *   profile     a Profile (lib/profile.mjs) to reuse: same HOME, settings and
 *               Downloads. Default: a new one, removed by close().
 *   env         extra environment for the app, e.g. { SHELL: "/bin/sh" }
 *   shellEnv    true to let the app import the login shell's environment
 *               (off by default, so the app sees exactly this environment)
 *   args        command-line arguments for the app (e.g. a kubeloupe:// link)
 */
export async function launch(name, opts = {}) {
  const ownProfile = !opts.profile;
  const profile = opts.profile ?? createProfile();
  const app = new App(name, { ...opts, profile }, ownProfile);
  try {
    await app.start();
  } catch (e) {
    if (ownProfile) profile.remove();
    throw e;
  }
  return app;
}

async function startSession(name, opts) {
  const app = appBinary();
  if (!existsSync(app)) {
    throw new Error(
      `${app} does not exist. Build it first:\n` +
        `  npm --prefix desktop/ui-src run build\n` +
        `  cargo build -p kubeloupe-desktop --features tauri/custom-protocol`,
    );
  }
  mkdirSync(ARTIFACTS, { recursive: true });
  const port = Number(process.env.E2E_DRIVER_PORT || 4444);
  const args = ["--port", String(port), "--native-port", String(port + 1)];
  const native = process.env.NATIVE_DRIVER || process.env.WEBKIT_DRIVER;
  if (native) args.push("--native-driver", native);

  // The app inherits this environment through tauri-driver and WebKitWebDriver.
  const kubeconfig = opts.kubeconfig ? null : testKubeconfig(opts.contexts);
  const env = {
    ...process.env,
    ...opts.profile.env(),
    KUBECONFIG: opts.kubeconfig ?? kubeconfig.path,
    ...(opts.shellEnv ? {} : { KUBELOUPE_NO_SHELL_ENV: "1" }),
    ...opts.env,
  };
  // Windows names are case-insensitive: a PATH from `opts.env` must replace
  // the inherited `Path`, not sit next to it.
  if (WINDOWS) {
    for (const key of Object.keys(opts.env ?? {})) {
      for (const other of Object.keys(env)) {
        if (other !== key && other.toLowerCase() === key.toLowerCase()) delete env[other];
      }
    }
  }
  const log = createWriteStream(join(ARTIFACTS, `${name}-app.log`), { flags: "a" });
  // Its own process group: WebKitWebDriver and the app inherit it, and ending
  // the session does not always stop the app, so stop() kills the group.
  const driverProc = spawn(process.env.TAURI_DRIVER || "tauri-driver", args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    // (On Windows, `detached` would open a console; taskkill /T stops the tree.)
    detached: !WINDOWS,
  });
  trackGroup(driverProc.pid);
  driverProc.stdout.pipe(log);
  driverProc.stderr.pipe(log);
  driverProc.once("error", (e) => log.write(`tauri-driver: ${e}\n`));
  const stop = async () => {
    killTree(driverProc.pid);
    untrackGroup(driverProc.pid);
    driverProc.stdout.destroy();
    driverProc.stderr.destroy();
    log.end();
    if (kubeconfig) rmSync(kubeconfig.dir, { recursive: true, force: true });
    // Let the ports go before a restart binds them again.
    await sleep(300);
  };

  try {
    await waitForPort(port, 15_000);
    // tauri-driver proxies to the native driver it started; on a busy machine
    // that one can still be starting ("connection refused" -> ECONNRESET).
    await waitForPort(port + 1, 15_000).catch(() => {});
    const build = () =>
      new Builder()
        .usingServer(`http://127.0.0.1:${port}/`)
        .withCapabilities({ browserName: "wry", "tauri:options": { application: app, args: opts.args ?? [] } })
        .build();
    let driver;
    try {
      driver = await build();
    } catch (e) {
      if (!/ECONNRESET|ECONNREFUSED|socket hang up/i.test(String(e))) throw e;
      log.write(`session failed (${e.message}), retrying once\n`);
      await sleep(2000);
      driver = await build();
    }
    return {
      driver,
      close: async () => {
        await Promise.race([driver.quit().catch(() => {}), sleep(5000)]);
        await stop();
      },
    };
  } catch (e) {
    await stop();
    throw e;
  }
}

/** XPath string literal (handles both quote kinds). */
export function xq(s) {
  if (!s.includes("'")) return `'${s}'`;
  if (!s.includes('"')) return `"${s}"`;
  return `concat('${s.split("'").join(`', "'", '`)}')`;
}

export const byTestId = (id) => By.css(`[data-testid="${id}"]`);

export class App {
  #shots = 0;
  #session = null;

  constructor(name, opts, ownProfile) {
    this.name = name;
    this.opts = opts;
    /** @type {import("./profile.mjs").Profile} */
    this.profile = opts.profile;
    this.ownProfile = ownProfile;
    /** @type {import("selenium-webdriver").WebDriver} */
    this.driver = null;
  }

  async start() {
    this.#session = await startSession(this.name, this.opts);
    this.driver = this.#session.driver;
  }

  /** Stop the app (and remove its profile unless the caller passed one). */
  async close() {
    await this.#session?.close();
    this.#session = null;
    if (this.ownProfile) this.profile.remove();
  }

  /**
   * Quit and start the app again with the same profile (settings, Downloads)
   * and options. `wait` gives debounced settings writes time to land first;
   * `beforeStart` runs while the app is stopped (e.g. to edit settings.json).
   */
  async restart({ wait = 1000, beforeStart } = {}) {
    await sleep(wait);
    await this.#session?.close();
    this.#session = null;
    await beforeStart?.();
    await this.start();
  }

  /**
   * Poll `fn` until it returns something truthy and return that. Errors
   * (stale elements, not-found) count as "not yet".
   */
  async waitFor(fn, { timeout = 20_000, interval = 250, message = "condition" } = {}) {
    const deadline = Date.now() + timeout;
    let lastErr;
    for (;;) {
      try {
        const v = await fn();
        if (v) return v;
        lastErr = undefined;
      } catch (e) {
        lastErr = e;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out after ${timeout} ms waiting for ${message}${lastErr ? `: ${lastErr.message}` : ""}`);
      }
      await sleep(interval);
    }
  }

  /** Wait for a visible element. */
  async find(locator, opts = {}) {
    return this.waitFor(
      async () => {
        const el = await this.driver.findElement(locator);
        return (await el.isDisplayed()) ? el : null;
      },
      { message: String(locator), ...opts },
    );
  }

  js(script, ...args) {
    return this.driver.executeScript(script, ...args);
  }

  /** Screenshot plus the page's visible text, numbered in the order taken. */
  async shot(label) {
    const n = String(++this.#shots).padStart(2, "0");
    const base = join(ARTIFACTS, `${this.name}-${n}-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`);
    try {
      writeFileSync(`${base}.png`, await this.driver.takeScreenshot(), "base64");
      writeFileSync(`${base}.txt`, await this.js("return document.body.innerText"));
    } catch (e) {
      writeFileSync(`${base}.txt`, `screenshot failed: ${e}\n`);
    }
  }

  // --- App-specific helpers -------------------------------------------------

  async statusText() {
    return (await this.driver.findElement(byTestId("connection-status"))).getText();
  }

  /** The sidebar button of a kind (or Overview), by its label (in a span for kinds; a count or problem badge may follow it). */
  navButton(label) {
    return By.xpath(
      `//nav//button[normalize-space()=${xq(label)} or normalize-space(text()[1])=${xq(label)} or normalize-space(span[1])=${xq(label)}]`,
    );
  }

  /** Click a kind (or Overview) in the sidebar. */
  async nav(label) {
    const button = await this.find(this.navButton(label));
    // The sidebar scrolls (more so with the dock open); WebKitGTK's driver
    // refuses to click a button that is only partly visible.
    await this.js("arguments[0].scrollIntoView({ block: 'center' })", button);
    await button.click();
  }

  /** Set an input's value the way typing would (fires `input`). */
  async setValue(el, value) {
    await this.js(
      `const el = arguments[0];
       const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
       Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, arguments[1]);
       el.dispatchEvent(new Event("input", { bubbles: true }));
       el.dispatchEvent(new Event("change", { bubbles: true }));`,
      el,
      value,
    );
  }

  /**
   * Run a command palette entry: Ctrl+K, type `query`, wait for the first
   * option to contain `option`, then Enter.
   */
  async palette(query, option = query) {
    // Not from inside a terminal, which keeps most keys.
    await this.js("document.activeElement?.blur()");
    await this.driver.actions().keyDown(Key.CONTROL).sendKeys("k").keyUp(Key.CONTROL).perform();
    const dialog = await this.find(byTestId("command-palette"));
    const input = await dialog.findElement(By.css('input[role="combobox"]'));
    await input.sendKeys(query);
    await this.waitFor(
      async () =>
        (
          await this.js(
            `return document.querySelector('[data-testid="command-palette"] [role="option"]')?.textContent ?? ""`,
          )
        ).includes(option),
      { message: `palette option "${option}"` },
    );
    await input.sendKeys(Key.ENTER);
    await this.waitFor(async () => (await this.driver.findElements(byTestId("command-palette"))).length === 0, {
      message: "the palette to close",
    });
  }

  /** Type into the table's filter box. */
  async filter(text) {
    await this.setValue(await this.find(By.css('input[aria-label="Filter"]')), text);
  }

  /** [name, namespace] of every rendered table row. */
  rows() {
    return this.js(
      `return Array.from(document.querySelectorAll('[data-testid="resource-row"]'), (r) => {
         const c = r.querySelectorAll('[role="gridcell"]');
         return [c[1]?.textContent.trim() ?? "", c[2]?.textContent.trim() ?? ""];
       });`,
    );
  }

  /** The table row whose Name cell is `name` (and Namespace cell `namespace`). */
  row(name, namespace) {
    const cell = (v) => `[*[@role='gridcell'][normalize-space()=${xq(v)}]]`;
    return By.xpath(`//*[@data-testid='resource-row']${cell(name)}${namespace ? cell(namespace) : ""}`);
  }

  /** Open a kind, filter to `name` and click its row; waits for the detail panel. */
  async openDetail(kindLabel, namespace, name) {
    await this.nav(kindLabel);
    await this.filter(name);
    await (await this.find(this.row(name, namespace))).click();
    await this.waitFor(
      async () =>
        (await (await this.driver.findElement(By.css('[data-testid="detail-panel"] .title'))).getText()).includes(
          `${namespace}/${name}`,
        ),
      { message: `detail panel of ${namespace}/${name}` },
    );
  }
}

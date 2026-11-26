// Uses helm (qa.sh puts one on PATH, from the cache if needed).
// Checks (#80): add a chart repository, open a chart's README, install it with
// edited values after a dry run, then upgrade the release to another version
// with new values after a dry-run diff. #497: the dry-run line says which
// objects would change, the same ones the diff shows (light and dark shots),
// and that nothing has been applied yet.
//
// The repository is demo-chart (0.1.0 and 0.2.0) packaged into a temp dir and
// served from 127.0.0.1 by this process: no internet. The app's helm gets its
// own HELM_CONFIG_HOME/HELM_CACHE_HOME/HELM_DATA_HOME, so your own helm
// repositories are never read or changed.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, REPO, byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHART = `${REPO}/scripts/test-cluster/charts/demo-chart`;
const RELEASE = "qa-chart";
let skip = false;
try {
  execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
} catch {
  skip = "helm is not on PATH";
}

let ns;
let dir;
let server;
let url;
let repo;

/** helm with its own homes (the app's), against the test context. */
function helm(args) {
  return execFileSync("helm", [...args, "--kube-context", CONTEXT], {
    env: { ...process.env, ...helmEnv() },
    encoding: "utf8",
  });
}

/** Only the helm variables: the app's profile sets HOME, PATH and the rest. */
function helmEnv() {
  return {
    HELM_CONFIG_HOME: join(dir, "config"),
    HELM_CACHE_HOME: join(dir, "cache"),
    HELM_DATA_HOME: join(dir, "data"),
    HELM_REPOSITORY_CONFIG: join(dir, "config", "repositories.yaml"),
    HELM_REPOSITORY_CACHE: join(dir, "cache", "repository"),
  };
}

/** The button with this text inside the element with `testid`. */
const button = (testid, text) => By.xpath(`//*[@data-testid=${xq(testid)}]//button[normalize-space()=${xq(text)}]`);

describe("helm charts", { timeout: 15 * 60_000, skip }, () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "nauvi-qa-helm-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    for (const version of ["0.1.0", "0.2.0"]) {
      execFileSync("helm", ["package", CHART, "--version", version, "-d", repo], { stdio: "pipe" });
    }
    server = createServer((req, res) => {
      try {
        const body = readFileSync(join(repo, basename(decodeURIComponent(req.url ?? "/"))));
        res.writeHead(200, { "Content-Length": body.length });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${server.address().port}`;
    execFileSync("helm", ["repo", "index", repo, "--url", url], { stdio: "pipe" });
    ns = tempNamespace("qa-charts");
  });
  after(() => {
    try {
      helm(["uninstall", RELEASE, "-n", ns]);
    } catch {
      // Not installed (an earlier step failed); the namespace goes anyway.
    }
    deleteNamespace(ns);
    server?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const s = appSession("helm-charts", () => ({ env: helmEnv() }));

  /** Replace the text of the CodeMirror editor with `testid`. */
  async function setEditor(testid, text) {
    const { app } = s;
    const editor = await app.find(byTestId(testid));
    await app.waitFor(async () => (await app.js("return !!arguments[0].nauviEditor", editor)), {
      message: `the ${testid} editor to load`,
    });
    await app.js("arguments[0].nauviEditor.setValue(arguments[1])", editor, text);
  }

  async function selectOption(el, value) {
    await s.app.js(
      `arguments[0].value = arguments[1];
       arguments[0].dispatchEvent(new Event("change", { bubbles: true }));`,
      el,
      value,
    );
  }

  /** A shot in light and in dark theme, then back to the system theme. */
  async function shots(label) {
    for (const theme of ["light", "dark"]) {
      await setTheme(s.app, theme);
      await sleep(500); // let WebKitGTK repaint before the shot
      await s.app.shot(`${label}-${theme}`);
    }
    await setTheme(s.app, null);
  }

  async function textOf(testid) {
    return s.app.js(`return document.querySelector('[data-testid="${testid}"]')?.innerText ?? ""`);
  }

  it("adds the local repository and shows its chart with the README", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.nav("Charts");
    await app.find(byTestId("helm-charts"));
    // No repositories yet: the panel is open.
    const repos = await app.find(byTestId("helm-repos"));
    await app.setValue(await repos.findElement(By.css('input[aria-label="Repository name"]')), "qa-local");
    await app.setValue(await repos.findElement(By.css('input[aria-label="Repository URL"]')), url);
    await (await app.find(By.xpath("//*[@data-testid='helm-repos']//button[normalize-space()='Add']"))).click();
    const row = await app.find(
      By.xpath("//*[@data-testid='chart-row'][*[@role='gridcell'][1][normalize-space()='qa-local/demo-chart']]"),
      { timeout: 60_000 },
    );
    await row.click();
    await app.find(byTestId("chart-readme"), { timeout: 60_000 });
    await app.waitFor(async () => (await textOf("chart-readme")).includes("tiny local chart"), {
      message: "the chart README",
    });
    // The repository is in the app's helm config, not yours.
    const list = JSON.parse(helm(["repo", "list", "-o", "json"]));
    if (!list.some((r) => r.name === "qa-local" && r.url === url)) throw new Error(`repo list: ${JSON.stringify(list)}`);
  });

  it("installs 0.1.0 with edited values after a dry run of the manifest", T, async () => {
    const { app } = s;
    const version = await app.find(By.css('[data-testid="chart-detail"] select[aria-label="Chart version"]'));
    await selectOption(version, "0.1.0");
    await app.waitFor(async () => (await textOf("chart-version")) === "0.1.0", { message: "version 0.1.0 shown" });
    await (await app.find(button("chart-detail", "Install…"))).click();
    const dialog = await app.find(byTestId("helm-deploy"));
    await app.setValue(await dialog.findElement(By.css('input[aria-label="Release name"]')), RELEASE);
    await app.setValue(await dialog.findElement(By.css('input[aria-label="Namespace"]')), ns);
    // Wait for the chart's defaults, then replace them.
    await app.waitFor(
      async () =>
        (await app.js(
          `return document.querySelector('[data-testid="deploy-values"]')?.nauviEditor?.getValue() ?? ""`,
        )).includes("greeting: hello"),
      { message: "the chart defaults in the values editor" },
    );
    await setEditor("deploy-values", "greeting: from-qa\n");
    await (await app.find(byTestId("deploy-preview"))).click();
    await app.waitFor(async () => /^Dry run: /.test(await textOf("deploy-summary")), {
      timeout: 60_000,
      message: "the dry-run summary",
    });
    const line = await textOf("deploy-summary");
    if (line !== "Dry run: 3 objects would be created. Nothing has been applied yet.") {
      throw new Error(`install dry-run line: ${line}`);
    }
    await shots("install-dry-run");
    const manifest = await app.js(
      `return document.querySelector('[data-testid="deploy-manifest"]')?.nauviEditor?.getValue() ?? ""`,
    );
    if (!manifest.includes('greeting: "from-qa"')) throw new Error(`dry-run manifest:\n${manifest}`);
    // Nothing installed yet.
    if (JSON.parse(helm(["list", "-n", ns, "-o", "json"])).length) throw new Error("the dry run installed something");

    await (await app.find(byTestId("deploy-confirm"))).click();
    await app.waitFor(async () => /Installed .* \(revision 1\)/.test(await textOf("deploy-result")), {
      timeout: 120_000,
      message: "the install result",
    });
    const values = JSON.parse(helm(["get", "values", RELEASE, "-n", ns, "-o", "json"]));
    if (values.greeting !== "from-qa") throw new Error(`installed values: ${JSON.stringify(values)}`);
  });

  it("upgrades to 0.2.0 with new values after a dry-run diff", T, async () => {
    const { app } = s;
    await (await app.find(button("helm-deploy", "Open release"))).click();
    await app.waitFor(async () => (await textOf("helm-detail")).includes(`${ns}/${RELEASE}`), {
      message: "the release detail",
    });
    // Enabled once the release has loaded.
    const upgrade = await app.find(button("helm-detail", "Upgrade…"));
    await app.waitFor(() => upgrade.isEnabled(), { message: "Upgrade… to be enabled" });
    await upgrade.click();
    const dialog = await app.find(byTestId("helm-deploy"));
    const version = await dialog.findElement(By.css('select[aria-label="Chart version"]'));
    await app.waitFor(async () => (await app.js("return arguments[0].options.length", version)) >= 2, {
      message: "the versions from the repository",
    });
    await selectOption(version, "0.2.0");
    await app.waitFor(
      async () =>
        (await app.js(
          `return document.querySelector('[data-testid="deploy-values"]')?.nauviEditor?.getValue() ?? ""`,
        )).includes("greeting: from-qa"),
      { message: "the release's values prefilled" },
    );
    await setEditor("deploy-values", "greeting: upgraded\nreplicas: 0\n");
    await (await app.find(byTestId("deploy-preview"))).click();
    await app.waitFor(async () => /^Dry run: /.test(await textOf("deploy-summary")), {
      timeout: 60_000,
      message: "the upgrade dry run",
    });
    // #497: the line names what the diff below changes (greeting in the
    // ConfigMap, replicas in the Deployment); the Secret stays as it is.
    const line = await textOf("deploy-summary");
    const want = `Dry run: 2 of 3 objects would change (ConfigMap ${RELEASE}-config, Deployment ${RELEASE}-app). Nothing has been applied yet.`;
    if (line !== want) throw new Error(`upgrade dry-run line: ${line}`);
    // The diff shows the new greeting.
    await app.waitFor(
      async () => (await app.js(`return document.querySelector('[data-testid="helm-deploy"] .cm-editor')?.innerText ?? ""`)).includes("upgraded"),
      { message: "the manifest diff" },
    );
    await shots("upgrade-dry-run");
    await (await app.find(byTestId("deploy-confirm"))).click();
    await app.waitFor(async () => /Upgraded .* to revision 2/.test(await textOf("deploy-result")), {
      timeout: 120_000,
      message: "the upgrade result",
    });
    const [rel] = JSON.parse(helm(["list", "-n", ns, "-o", "json"]));
    if (rel?.revision !== "2" || rel?.chart !== "demo-chart-0.2.0") throw new Error(`release: ${JSON.stringify(rel)}`);
    const values = JSON.parse(helm(["get", "values", RELEASE, "-n", ns, "-o", "json"]));
    if (values.greeting !== "upgraded" || values.replicas !== 0) throw new Error(`values: ${JSON.stringify(values)}`);
    await (await app.find(button("helm-deploy", "Close"))).click();
  });

  it("an upgrade dry run with the same values says nothing would change", T, async () => {
    const { app } = s;
    const upgrade = await app.find(button("helm-detail", "Upgrade…"));
    await app.waitFor(() => upgrade.isEnabled(), { message: "Upgrade… to be enabled" });
    await upgrade.click();
    await app.find(byTestId("helm-deploy"));
    await app.waitFor(
      async () =>
        (await app.js(
          `return document.querySelector('[data-testid="deploy-values"]')?.nauviEditor?.getValue() ?? ""`,
        )).includes("greeting: upgraded"),
      { message: "the release's values prefilled" },
    );
    await (await app.find(byTestId("deploy-preview"))).click();
    await app.waitFor(async () => /^Dry run: /.test(await textOf("deploy-summary")), {
      timeout: 60_000,
      message: "the no-change dry run",
    });
    const line = await textOf("deploy-summary");
    if (line !== "Dry run: none of the 3 objects would change. Nothing has been applied yet.") {
      throw new Error(`no-change dry-run line: ${line}`);
    }
    await shots("upgrade-dry-run-unchanged");
    await (await app.find(button("helm-deploy", "Cancel"))).click();
  });

  // QA area 5 (#83, PR #94 "not verified"): the repository Update and Remove
  // buttons, the Settings section and the error paths, in WebKitGTK.

  it("an invalid values document gets a plain error, not helm's", T, async () => {
    const { app } = s;
    await app.nav("Charts");
    await (await app.find(By.xpath("//*[@data-testid='chart-row'][*[@role='gridcell'][1][normalize-space()='qa-local/demo-chart']]"))).click();
    await app.find(byTestId("chart-readme"), { timeout: 60_000 });
    const install = await app.find(button("chart-detail", "Install…"));
    await app.waitFor(() => install.isEnabled(), { message: "Install… enabled" });
    await install.click();
    const dialog = await app.find(byTestId("helm-deploy"), { timeout: 30_000 });
    await app.setValue(await dialog.findElement(By.css('input[aria-label="Namespace"]')), ns);
    await app.setValue(await dialog.findElement(By.css('input[aria-label="Release name"]')), "qa-bad-values");
    await app.waitFor(
      async () =>
        (await app.js(`return document.querySelector('[data-testid="deploy-values"]')?.nauviEditor?.getValue() ?? ""`)).includes("greeting"),
      { message: "the chart defaults" },
    );
    await setEditor("deploy-values", "- just\n- a list\n");
    await (await app.find(byTestId("deploy-preview"))).click();
    const error = await app.waitFor(async () => textOf("deploy-error"), { timeout: 30_000, message: "the values error" });
    console.log(`values error: ${error}`);
    if (!/mapping/i.test(error) || /Error:|INSTALLATION FAILED/.test(error)) throw new Error(`error text: ${error}`);
    await app.shot("deploy-values-error");
    await (await app.find(button("helm-deploy", "Cancel"))).click();
  });

  it("Update in the repositories panel picks up a new chart version", T, async () => {
    const { app } = s;
    execFileSync("helm", ["package", CHART, "--version", "0.3.0", "-d", repo], { stdio: "pipe" });
    execFileSync("helm", ["repo", "index", repo, "--url", url], { stdio: "pipe" });
    await app.js(`document.querySelector('[data-testid="chart-detail"] button[aria-label="Close details"]')?.click()`);
    const toggle = await app.find(By.xpath("//*[@data-testid='helm-charts']//button[normalize-space()='Manage repositories']"));
    await toggle.click();
    await (await app.find(By.xpath("//*[@data-testid='helm-repo'][span[normalize-space()='qa-local']]/button[normalize-space()='Update']"))).click();
    await app.waitFor(
      async () =>
        (await app.js(
          `return Array.from(document.querySelectorAll('[data-testid="chart-row"]'), (r) => r.innerText).find((t) => t.includes("qa-local/demo-chart")) ?? ""`,
        )).includes("0.3.0"),
      { timeout: 60_000, message: "demo-chart 0.3.0 listed after Update" },
    );
  });

  it("an unreachable repository gets a plain error", T, async () => {
    const { app } = s;
    const repos = await app.find(byTestId("helm-repos"));
    await app.setValue(await repos.findElement(By.css('input[aria-label="Repository name"]')), "qa-unreachable");
    await app.setValue(await repos.findElement(By.css('input[aria-label="Repository URL"]')), "http://127.0.0.1:1/charts");
    await (await app.find(By.xpath("//*[@data-testid='helm-repos']//button[normalize-space()='Add']"))).click();
    const text = await app.waitFor(
      async () =>
        app.js(
          `return Array.from(document.querySelectorAll('[data-testid="helm-repos"] [role="alert"], [data-testid="helm-repo-warning"]'), (e) => e.innerText).join(" | ")`,
        ),
      { timeout: 60_000, message: "an error for the unreachable repository" },
    );
    console.log(`unreachable repository: ${text}`);
    await app.shot("repo-unreachable");
    const list = JSON.parse(helm(["repo", "list", "-o", "json"]));
    if (list.some((r) => r.name === "qa-unreachable")) throw new Error(`added anyway: ${JSON.stringify(list)}`);
  });

  it("Settings lists the repository and removes it", T, async () => {
    const { app } = s;
    await app.js("document.activeElement?.blur()");
    await app.driver.actions().keyDown("").sendKeys(",").keyUp("").perform();
    await app.find(byTestId("settings"));
    const section = await app.find(byTestId("helm-repo-settings"));
    await app.js("arguments[0].scrollIntoView()", section);
    await app.waitFor(async () => (await app.js("return arguments[0].innerText", section)).includes("qa-local"), {
      message: "qa-local in Settings",
    });
    await app.shot("settings-helm-repos");
    const remove = await section.findElement(By.css('button[aria-label="Remove qa-local"]'));
    await remove.click();
    await (await section.findElement(By.css('button[aria-label="Confirm removing qa-local"]'))).click();
    const names = () => {
      try {
        return JSON.parse(helm(["repo", "list", "-o", "json"])).map((r) => r.name);
      } catch {
        return []; // "no repositories to show"
      }
    };
    await app.waitFor(() => !names().includes("qa-local"), {
      timeout: 30_000,
      message: "qa-local removed from helm's repositories",
    });
    await (await app.find(By.xpath("//*[@data-testid='settings']//button[normalize-space()='Close']"))).click();
    await app.waitFor(async () => /No chart repositories configured/.test(await textOf("helm-charts")), {
      message: "the Charts view without repositories",
    });
  });
});

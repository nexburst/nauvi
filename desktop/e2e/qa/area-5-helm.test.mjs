// Uses helm (qa.sh puts one on PATH, from the cache if needed).
// QA area 5 (#83): Helm releases (PR #71) in WebKitGTK, on a context that
// only exists in a kubeconfig file added in the catalog (#78), so every helm
// call needs `--kubeconfig <file> --kube-context <name>`.
// Checks: the releases list (Secret and ConfigMap storage); the History
// tab's values and manifest diffs in the detail panel; Rollback and
// Uninstall from the GUI (helm's own history/list agree); a release stored
// with HELM_DRIVER=configmap opens and uninstalls; 100 releases list (time
// logged); helm found through the login shell's PATH (#32) when the app's
// own PATH has none.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, REPO, byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";

const T = { timeout: 240_000 };
const CHART = `${REPO}/scripts/test-cluster/charts/demo-chart`;
const ADDED = "qa-area5-added";
const MANY = 100;
let skip = false;
try {
  execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
} catch {
  skip = "helm is not on PATH";
}

const helm = (args, env = {}) =>
  execFileSync("helm", ["--kube-context", CONTEXT, ...args], { encoding: "utf8", env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });

/** A chart with one ConfigMap, for many cheap releases. */
function tinyChart(dir) {
  const chart = join(dir, "tiny");
  mkdirSync(join(chart, "templates"), { recursive: true });
  writeFileSync(join(chart, "Chart.yaml"), "apiVersion: v2\nname: tiny\nversion: 0.1.0\n");
  writeFileSync(join(chart, "templates", "cm.yaml"), "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: {{ .Release.Name }}\ndata:\n  a: b\n");
  return chart;
}

const textOf = (app, testid) => app.js(`return document.querySelector('[data-testid="${testid}"]')?.innerText ?? ""`);
const button = (testid, text) => By.xpath(`//*[@data-testid=${xq(testid)}]//button[normalize-space()=${xq(text)}]`);
const releaseRow = (name, ns) =>
  By.xpath(`//*[@data-testid='helm-row'][*[@role='gridcell'][1][normalize-space()=${xq(name)}]][*[@role='gridcell'][2][normalize-space()=${xq(ns)}]]`);

async function openRelease(app, name, ns) {
  await app.filter(name);
  await (await app.find(releaseRow(name, ns), { timeout: 60_000 })).click();
  await app.waitFor(async () => (await textOf(app, "helm-detail")).includes(`${ns}/${name}`), { message: `${ns}/${name} detail` });
  await app.waitFor(async () => (await textOf(app, "helm-status")) !== "", { message: "the release loaded" });
}

async function tab(app, label) {
  await (await app.find(By.xpath(`//*[@data-testid='helm-detail']//*[@role='tab'][normalize-space()=${xq(label)}]`))).click();
}

let dir;
let ns;
let profile;

describe("area 5: helm releases on an added kubeconfig's context", { timeout: 25 * 60_000, skip }, () => {
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "kubeloupe-qa-area5-helm-"));
    // The test context, renamed, in a file of its own: only the catalog knows it.
    const file = join(dir, "added.yaml");
    writeFileSync(file, execFileSync("kubectl", ["config", "view", "--minify", "--flatten", "--context", CONTEXT], { encoding: "utf8" }), {
      mode: 0o600,
    });
    execFileSync("kubectl", ["--kubeconfig", file, "config", "rename-context", CONTEXT, ADDED], { stdio: "pipe" });
    profile = createProfile();
    profile.writeSettings({ kubeconfig_sources: [file], last_context: ADDED });

    ns = tempNamespace("qa-area5-helm");
    helm(["-n", ns, "install", "qa-rel", CHART, "--set", "greeting=first", "--set", "replicas=0"]);
    helm(["-n", ns, "upgrade", "qa-rel", CHART, "--set", "greeting=second", "--set", "replicas=0"]);
    helm(["-n", ns, "install", "qa-cm-rel", CHART, "--set", "replicas=0"], { HELM_DRIVER: "configmap" });
  });
  after(() => {
    deleteNamespace(ns);
    if (dir) rmSync(dir, { recursive: true, force: true });
    profile?.remove();
  });
  const s = appSession("area-5-helm", () => ({ profile }));

  it("opens on the added context and lists both releases", T, async () => {
    const { app } = s;
    await app.waitFor(async () => (await app.js(`return document.querySelector('select[aria-label="Cluster context"]')?.value`)) === ADDED, {
      timeout: 30_000,
      message: `context ${ADDED}`,
    });
    await waitLive(app);
    await app.nav("Releases");
    await pickNamespaces(app, [ns]);
    await app.find(releaseRow("qa-rel", ns), { timeout: 60_000 });
    await app.find(releaseRow("qa-cm-rel", ns));
    console.log(await textOf(app, "helm-releases"));
  });

  it("History: values and manifest diffs of revisions 1 and 2 in the panel", T, async () => {
    const { app } = s;
    await openRelease(app, "qa-rel", ns);
    await tab(app, "History");
    await app.find(byTestId("helm-history"));
    await app.waitFor(async () => (await textOf(app, "helm-history")).includes("superseded"), { message: "revision 1 superseded" });
    const diff = await app.find(byTestId("helm-diff"));
    await app.waitFor(async () => /first[\s\S]*second|second[\s\S]*first/.test(await app.js("return arguments[0].innerText", diff)), {
      message: "greeting first -> second in the values diff",
    });
    const width = await app.js(`return Math.round(document.querySelector('[data-testid="helm-detail"]').getBoundingClientRect().width)`);
    const overflow = await app.js(`
      const d = document.querySelector('[data-testid="helm-detail"]');
      return { scrollW: d.scrollWidth, clientW: d.clientWidth };`);
    console.log(`helm detail width ${width}px, ${JSON.stringify(overflow)}`);
    assert.ok(overflow.scrollW <= overflow.clientW + 1, "the panel does not scroll sideways");
    await app.shot("history-values-diff");
    await (await app.find(button("helm-history", "Manifest"))).click();
    await app.waitFor(async () => (await textOf(app, "helm-diff")).includes("greeting"), { message: "the manifest diff" });
    await app.shot("history-manifest-diff");
  });

  it("the releases table's header stays left of the detail panel", { ...T, todo: "#123: Status/Updated headers drawn over the panel" }, async () => {
    const { app } = s;
    const over = await app.js(`
      const panel = document.querySelector('[data-testid="helm-detail"]').getBoundingClientRect();
      return Array.from(document.querySelectorAll('[data-testid="helm-releases"] [role="columnheader"]'))
        .filter((h) => {
          // Painted on top of the panel: the header is what is under its own centre there.
          const r = h.getBoundingClientRect();
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          return x > panel.left && h.contains(document.elementFromPoint(x, y));
        })
        .map((h) => h.textContent.trim());`);
    assert.deepEqual(over, [], `headers over the panel: ${JSON.stringify(over)}`);
  });

  it("rolls back to revision 1 from the GUI", T, async () => {
    const { app } = s;
    await (await app.find(button("helm-history", "Roll back to 1…"))).click();
    const dialog = await app.find(byTestId("helm-dialog"));
    assert.match(await app.js("return arguments[0].innerText", dialog), /Roll back qa-rel to revision 1\?/);
    await (await app.find(byTestId("helm-confirm"))).click();
    await app.waitFor(async () => (await app.driver.findElements(byTestId("helm-dialog"))).length === 0, {
      timeout: 120_000,
      message: "the rollback to finish",
    });
    const history = JSON.parse(helm(["-n", ns, "history", "qa-rel", "-o", "json"]));
    console.log(`helm history: ${JSON.stringify(history.map((h) => [h.revision, h.status, h.description]))}`);
    assert.equal(history.at(-1).revision, 3);
    assert.match(history.at(-1).description, /Rollback to 1/);
    assert.equal(JSON.parse(helm(["-n", ns, "get", "values", "qa-rel", "-o", "json"])).greeting, "first");
    await app.waitFor(async () => /\b3\b/.test(await textOf(app, "helm-history")), { message: "revision 3 in the History tab" });
  });

  it("uninstalls from the GUI after typing the name", T, async () => {
    const { app } = s;
    await (await app.find(button("helm-detail", "Uninstall…"))).click();
    await app.find(byTestId("helm-dialog"));
    const confirm = await app.find(byTestId("helm-confirm"));
    assert.equal(await confirm.isEnabled(), false, "Uninstall disabled until the name is typed");
    await app.setValue(await app.find(By.css('[data-testid="helm-dialog"] input')), "qa-rel");
    await app.waitFor(() => confirm.isEnabled(), { message: "Uninstall enabled" });
    await confirm.click();
    await app.waitFor(async () => (await app.driver.findElements(byTestId("helm-dialog"))).length === 0, {
      timeout: 120_000,
      message: "the uninstall to finish",
    });
    const left = JSON.parse(helm(["-n", ns, "list", "-a", "-o", "json"])).map((r) => r.name);
    assert.ok(!left.includes("qa-rel"), `helm list: ${left}`);
    await app.waitFor(async () => (await app.driver.findElements(releaseRow("qa-rel", ns))).length === 0, { message: "the row gone" });
  });

  it("a release stored in ConfigMaps opens and uninstalls", { ...T, todo: "#122: helm runs without HELM_DRIVER=configmap" }, async () => {
    const { app } = s;
    await openRelease(app, "qa-cm-rel", ns);
    assert.match(await textOf(app, "helm-detail"), /Storage\s+ConfigMaps/);
    await (await app.find(button("helm-detail", "Uninstall…"))).click();
    await app.setValue(await app.find(By.css('[data-testid="helm-dialog"] input')), "qa-cm-rel");
    await (await app.find(byTestId("helm-confirm"))).click();
    const outcome = await app.waitFor(
      async () => {
        if ((await app.driver.findElements(byTestId("helm-dialog"))).length === 0) return "closed";
        const err = await app.js(`return document.querySelector('[data-testid="helm-dialog"] [role="alert"]')?.innerText ?? ""`);
        return err ? `error: ${err}` : null;
      },
      { timeout: 120_000, message: "the uninstall to finish or fail" },
    );
    console.log(`configmap release uninstall: ${outcome}`);
    const left = JSON.parse(helm(["-n", ns, "list", "-a", "-o", "json"], { HELM_DRIVER: "configmap" })).map((r) => r.name);
    assert.equal(outcome, "closed");
    assert.ok(!left.includes("qa-cm-rel"), `helm list (configmap driver): ${left}`);
  });

  it(`lists ${MANY} releases`, T, async () => {
    const { app } = s;
    const chart = tinyChart(dir);
    const t0 = Date.now();
    // Four installs at a time.
    const names = Array.from({ length: MANY }, (_, i) => `qa-many-${String(i).padStart(3, "0")}`);
    const { spawn } = await import("node:child_process");
    const run = (name) =>
      new Promise((ok, fail) => {
        const p = spawn("helm", ["--kube-context", CONTEXT, "-n", ns, "install", name, chart], { stdio: "ignore" });
        p.on("exit", (code) => (code === 0 ? ok() : fail(new Error(`helm install ${name}: ${code}`))));
      });
    for (let i = 0; i < names.length; i += 4) await Promise.all(names.slice(i, i + 4).map(run));
    console.log(`${MANY} installs in ${Date.now() - t0} ms`);
    await (await app.find(By.css('[data-testid="helm-detail"] button[aria-label="Close details"]'))).click().catch(() => {});
    await app.filter("qa-many-");
    const t1 = Date.now();
    await app.js(`Array.from(document.querySelectorAll("button")).find((b) => b.textContent.trim() === "Refresh")?.click()`);
    await app.waitFor(
      async () => (await app.js(`return document.querySelector('[role="grid"][aria-label="Helm releases"]')?.getAttribute("aria-rowcount")`)) == MANY + 1,
      { timeout: 120_000, message: `${MANY} rows` },
    );
    console.log(`${MANY} releases listed ${Date.now() - t1} ms after Refresh`);
    await app.shot("many-releases");
  });
});

/** PATH without any directory that has a `helm`. */
function pathWithoutHelm() {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((d) => {
      try {
        accessSync(join(d, "helm"), constants.X_OK);
        return false;
      } catch {
        return true;
      }
    })
    .join(delimiter);
}

function helmDir() {
  return execFileSync("sh", ["-c", "dirname \"$(command -v helm)\""], { encoding: "utf8" }).trim();
}

for (const login of [false, true]) {
  describe(`area 5: helm ${login ? "from the login shell's PATH" : "missing from PATH"}`, { timeout: 5 * 60_000, skip }, () => {
    let p;
    before(() => {
      p = createProfile();
      // `sh -l` reads ~/.profile: helm's directory is only there.
      writeFileSync(join(p.home, ".profile"), `PATH="${helmDir()}:$PATH"; export PATH\n`);
    });
    after(() => p?.remove());
    const s = appSession(`area-5-helm-${login ? "login-shell" : "no-helm"}`, () => ({
      profile: p,
      shellEnv: login,
      env: { PATH: `${p.bin}${delimiter}${pathWithoutHelm()}`, SHELL: "/bin/sh" },
    }));

    it(login ? "finds helm through the login shell" : "says helm is missing", T, async () => {
      const { app } = s;
      await waitLive(app);
      await app.nav("Charts");
      await app.find(byTestId("helm-charts"));
      if (login) {
        await app.find(byTestId("helm-repos"));
        // Give a missing-helm banner time to show up.
        await new Promise((r) => setTimeout(r, 3000));
        assert.equal((await app.driver.findElements(byTestId("helm-missing"))).length, 0, await textOf(app, "helm-missing"));
      } else {
        await app.find(byTestId("helm-missing"), { timeout: 30_000 });
        console.log(`missing: ${await textOf(app, "helm-missing")}`);
      }
    });
  });
}

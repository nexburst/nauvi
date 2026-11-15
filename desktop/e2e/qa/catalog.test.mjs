// Helpers: appSession, waitLive (lib/qa.mjs), App.restart and
// profile.settings() (lib/profile.mjs).
// Checks (#78): adding a folder of kubeconfigs in the cluster catalog brings
// in a context whose name clashes with the default one, as `name (file)`;
// each cluster gets a status (connected / unreachable); the added context
// connects through its own file and lists pods; the source survives a
// restart; the kubeconfig files are byte for byte unchanged.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT } from "../lib/app.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const T = { timeout: 120_000 };
const dir = mkdtempSync(join(tmpdir(), "kubeloupe-qa-catalog-"));
const folder = join(dir, "clusters");
const team = join(folder, "team.yaml");
const broken = join(folder, "broken.yaml");
const ADDED = `${CONTEXT} (team.yaml)`;
const BROKEN = "issue78-unreachable";

/** The test context alone, as a file of its own; `kubectl` edits only that file. */
function writeCopy(path) {
  const yaml = execFileSync("kubectl", ["config", "view", "--minify", "--flatten", "--context", CONTEXT], {
    encoding: "utf8",
  });
  writeFileSync(path, yaml, { mode: 0o600 });
}
mkdirSync(folder, { recursive: true });
writeCopy(team);
writeCopy(broken);
const kc = (args) => execFileSync("kubectl", ["--kubeconfig", broken, "config", ...args], { encoding: "utf8" });
kc(["rename-context", CONTEXT, BROKEN]);
const cluster = kc(["view", "-o", "jsonpath={.clusters[0].name}"]).trim();
kc(["set-cluster", cluster, "--server=https://127.0.0.1:1"]);

const sha = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const before = { team: sha(team), broken: sha(broken) };

const row = (id) => `[data-testid="catalog-row"][data-context=${JSON.stringify(id)}]`;
const statusOf = (app, id) =>
  app.js(`return document.querySelector(arguments[0])?.querySelector('[data-testid="catalog-status"]')?.innerText.trim() ?? ""`, row(id));
const click = (app, css) =>
  app.js(
    `const el = document.querySelector(arguments[0]); if (!el) return false; el.scrollIntoView({ block: "center" }); el.click(); return true;`,
    css,
  );

describe("cluster catalog", { timeout: 10 * 60_000 }, () => {
  const s = appSession("catalog");
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("adds a folder of kubeconfigs and checks every cluster", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.find(By.css('button[aria-label="Cluster catalog"]'));
    await click(app, 'button[aria-label="Cluster catalog"]');
    await app.find(By.css('[data-testid="catalog"]'));
    await app.waitFor(async () => (await statusOf(app, CONTEXT)) === "Connected", { timeout: 30_000, message: `${CONTEXT} connected` });

    await app.waitFor(
      () =>
        app.js(
          `const b = Array.from(document.querySelectorAll('[data-testid="catalog"] button')).find((b) => b.textContent.trim() === "Add kubeconfig…");
           b?.click();
           return !!b;`,
        ),
      { message: "the Add kubeconfig… button" },
    );
    const input = await app.find(By.css('input[aria-label="Kubeconfig file or folder"]'));
    await app.setValue(input, folder);
    await click(app, 'form[aria-label="Add kubeconfig"] button[type="submit"]');

    await app.waitFor(async () => (await statusOf(app, ADDED)) === "Connected", { timeout: 40_000, message: `${ADDED} connected` });
    await app.waitFor(async () => (await statusOf(app, BROKEN)).startsWith("Unreachable"), {
      timeout: 40_000,
      message: `${BROKEN} unreachable`,
    });
    const sources = await app.js(
      `return Array.from(document.querySelectorAll('[data-testid="catalog-source"]'), (li) => li.innerText.replace(/\\s+/g, " "))`,
    );
    console.log(`sources: ${JSON.stringify(sources)}`);
    assert.ok(sources.some((t) => t.includes(folder) && t.includes("2 contexts in 2 files")), JSON.stringify(sources));
  });

  it("opens the added context through its own file and lists pods", T, async () => {
    const { app } = s;
    await click(app, `${row(ADDED)} button[aria-label=${JSON.stringify(`Open ${ADDED}`)}]`);
    await app.waitFor(
      async () => (await app.js(`return document.querySelector('select[aria-label="Cluster context"]').value`)) === ADDED,
      { message: `context select on ${ADDED}` },
    );
    await waitLive(app);
    await app.nav("Pods");
    await app.filter("web-");
    await app.waitFor(async () => (await app.rows()).some(([n, ns]) => ns === "demo" && n.startsWith("web-")), {
      timeout: 40_000,
      message: "demo/web pods through the added file",
    });
  });

  it("keeps the source across a restart and never writes the kubeconfig files", T, async () => {
    const { app } = s;
    await app.restart();
    await app.find(By.css("nav"));
    const settings = app.profile.settings();
    console.log(`kubeconfig_sources: ${JSON.stringify(settings.kubeconfig_sources)}`);
    assert.deepEqual(settings.kubeconfig_sources, [folder]);
    await app.waitFor(
      async () =>
        await app.js(
          `return Array.from(document.querySelectorAll('select[aria-label="Cluster context"] option'), (o) => o.value).includes(arguments[0])`,
          ADDED,
        ),
      { message: `${ADDED} in the context selector after the restart` },
    );
    assert.equal(sha(team), before.team, "team.yaml changed");
    assert.equal(sha(broken), before.broken, "broken.yaml changed");
  });
});

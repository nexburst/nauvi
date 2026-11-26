// First run and empty states (#485). Checks, at 1280x800 in both themes:
// - no kubeconfig at all (KUBECONFIG unset, no ~/.kube/config in the app's
//   own HOME), first run: the welcome screen says "No kubeconfig found",
//   where nauvi looked, and offers Add a kubeconfig; no banner, the header
//   says "No kubeconfig"
// - first run with kind: the welcome screen lists the test kubeconfig and
//   its context; opening it shows the Overview with the tips strip; ✕ hides
//   the tips for good; settings.json remembers both; a restart opens on the
//   Overview with neither
// - an empty namespace (its own temporary one): "No Deployments in namespace
//   …" with All namespaces and Create…
// - a filter that hides everything, carried from one kind to the next:
//   "No Pods match …" with Clear filter, which brings the rows back
// - Helm Charts with no repository: one empty state with one-click
//   repositories and no empty table (skipped without helm)

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId, CONTEXT, xq } from "../lib/app.mjs";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { bannerText } from "../lib/table.mjs";
import { pickNamespace } from "./area-2-helpers.mjs";
import { setTheme } from "../lib/theme.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bothThemes(app, label) {
  for (const theme of ["light", "dark"]) {
    await setTheme(app, theme);
    // The empty state's water draws itself in once.
    await sleep(1600);
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

const textOf = (app, testid) =>
  app.js(`return document.querySelector('[data-testid="${testid}"]')?.innerText ?? ""`);

async function waitText(app, testid, pattern, message, timeout = 30_000) {
  return app.waitFor(
    async () => {
      const t = await textOf(app, testid);
      return pattern.test(t) ? t : null;
    },
    { timeout, message },
  );
}

describe("first run: no kubeconfig at all", { timeout: 10 * 60_000 }, () => {
  // A kubeconfig path is needed so the harness does not write its own; the
  // app then gets no KUBECONFIG, and its HOME has no .kube/config.
  const s = appSession("first-run-no-kubeconfig", {
    kubeconfig: "/nonexistent-qa-485/config",
    env: { KUBECONFIG: undefined },
    firstRun: true,
  });

  it("the welcome screen says where nauvi looked and how to add a kubeconfig", T, async () => {
    const { app } = s;
    const text = await waitText(app, "welcome", /No kubeconfig found[\s\S]*does not exist/, "the welcome's no-kubeconfig state", 60_000);
    console.log(`welcome: ${text}`);
    assert.match(await textOf(app, "welcome-looked"), /\.kube[/\\]config\s+the file does not exist/);
    assert.match(text, /Add a kubeconfig/);
    assert.match(text, /Next steps/);
    assert.equal(await bannerText(app), "", "no banner: the welcome says it");
    assert.equal(await app.statusText(), "No kubeconfig");
    await app.find(By.css('[data-testid="welcome"] input[aria-label="Kubeconfig file or folder"]'));
    await bothThemes(app, "no-kubeconfig");
  });
});

describe("first run: with kind", { timeout: 10 * 60_000 }, () => {
  const s = appSession("first-run-kind", { firstRun: true });

  it("opens on the welcome screen with the kubeconfig it read and its cluster", T, async () => {
    const { app } = s;
    const text = await waitText(app, "welcome", /Pick a cluster to start/, "the welcome screen", 60_000);
    console.log(`welcome: ${text}`);
    assert.match(await textOf(app, "welcome-looked"), /1 context/);
    assert.match(await textOf(app, "welcome-clusters"), new RegExp(CONTEXT));
    assert.equal((await app.driver.findElements(byTestId("tips-strip"))).length, 0, "no tips on the welcome");
    await waitLive(app);
    await bothThemes(app, "welcome");
  });

  it("opening the cluster shows the Overview, with the tips strip", T, async () => {
    const { app } = s;
    const open = await app.find(
      By.xpath(`//*[@data-testid='welcome-clusters']//button[.//*[normalize-space()=${xq(CONTEXT)}]]`),
    );
    await open.click();
    await app.waitFor(async () => (await app.driver.findElements(byTestId("welcome"))).length === 0, {
      message: "the welcome screen gone",
    });
    await waitLive(app);
    const tips = await waitText(app, "tips-strip", /every kind/, "the tips strip");
    console.log(`tips: ${tips}`);
    assert.match(tips, /Ctrl\+K/);
    await bothThemes(app, "overview-tips");
  });

  it("✕ hides the tips for good; a restart opens on the Overview with neither", T, async () => {
    const { app } = s;
    await (await app.find(By.css('[data-testid="tips-strip"] button[aria-label="Hide the tips"]'))).click();
    await app.waitFor(async () => (await app.driver.findElements(byTestId("tips-strip"))).length === 0, {
      message: "the tips strip gone",
    });
    await app.waitFor(
      () => {
        const saved = app.profile.settings();
        return saved?.welcomed === true && saved?.tips_left === 0;
      },
      { timeout: 10_000, message: "settings.json with welcomed and no tips left" },
    );
    await app.restart();
    await waitLive(app);
    await sleep(1500);
    assert.equal((await app.driver.findElements(byTestId("welcome"))).length, 0, "no welcome after the first run");
    assert.equal((await app.driver.findElements(byTestId("tips-strip"))).length, 0, "no tips once hidden");
  });
});

describe("empty states", { timeout: 10 * 60_000 }, () => {
  let ns = "";
  before(() => {
    ns = tempNamespace("qa-empty");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("first-run-empty");

  it("an empty namespace says so and offers All namespaces and Create", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.nav("Deployments");
    await pickNamespace(app, ns);
    const text = await waitText(app, "empty-state", new RegExp(`No Deployments in namespace ${ns}`), "the empty namespace");
    console.log(`empty: ${text}`);
    assert.match(text, /All namespaces/);
    assert.match(text, /Create…/);
    await bothThemes(app, "empty-namespace");
  });

  it("a filter that hides everything says so on the next kind too, and Clear filter brings the rows back", T, async () => {
    const { app } = s;
    await (await app.find(By.xpath("//*[@data-testid='empty-state']//button[normalize-space()='All namespaces']"))).click();
    await app.waitFor(async () => (await app.rows()).length > 0, { message: "Deployments in all namespaces" });
    await app.filter("zz-no-such-485");
    await waitText(app, "empty-state", /No Deployments match "zz-no-such-485"/, "the filtered-out Deployments");
    await app.nav("Pods");
    const text = await waitText(app, "empty-state", /No Pods match "zz-no-such-485"/, "the filter carried to Pods");
    console.log(`empty: ${text}`);
    assert.match(text, /The filter hides all \d+/);
    await bothThemes(app, "filter-hides-all");
    await (await app.find(byTestId("clear-filter"))).click();
    await app.waitFor(async () => (await app.rows()).length > 0, { message: "the pods back" });
  });

  it("Helm Charts with no repository: one empty state, suggestions, no table", T, async () => {
    const { app } = s;
    await app.nav("Charts");
    await app.find(byTestId("helm-charts"));
    const state = await app.waitFor(
      async () => {
        if ((await app.driver.findElements(byTestId("helm-missing"))).length) return "missing";
        return (await textOf(app, "empty-state")).includes("No chart repositories yet") ? "empty" : null;
      },
      { timeout: 30_000, message: "the Charts empty state" },
    );
    if (state === "missing") {
      console.log("skipped: helm is not installed");
      return;
    }
    const text = await textOf(app, "helm-charts");
    console.log(`charts: ${text}`);
    assert.equal(text.match(/no chart repositories/gi)?.length, 1, "said once");
    assert.equal((await app.driver.findElements(By.css('[data-testid="helm-charts"] [role="grid"]'))).length, 0);
    assert.match(text, /Add bitnami/);
    await bothThemes(app, "charts-no-repos");
  });
});

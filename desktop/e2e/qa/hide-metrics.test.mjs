// "Hide metrics" per cluster (#327), in the real app against kind:
// - shown (the default): the Pods table has CPU and Memory with values from
//   metrics-server, the overview's capacity says how much is used
// - hidden from the cluster settings page: no CPU / Memory columns in Pods
//   and Nodes, a "Metrics hidden for this cluster — Settings" note there, in
//   the pod panel instead of the usage charts and in the overview's
//   capacity; saved per context in settings.json and kept after a restart
// - shown again from the note's Settings link: the columns come back
// Light and dark theme at 1280x800. Reads the cluster only.
// Needs metrics-server (kind setup.sh installs it).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, byTestId } from "../lib/app.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { tableData } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };

const noteText = (app, css = "") =>
  app.js(`return document.querySelector(${JSON.stringify(`${css} [data-testid="metrics-hidden"]`.trim())})?.innerText.trim() ?? ""`);

const capacityText = (app) =>
  app.js(`return document.querySelector('section[aria-label="Capacity"]')?.innerText ?? ""`);

async function waitHeaders(app, want, message) {
  return app.waitFor(
    async () => {
      const t = await tableData(app);
      return t && t.rows.length > 0 && want(t.headers) ? t : null;
    },
    { timeout: 60_000, message },
  );
}

/** Tick or untick "Hide metrics" on this cluster's settings page, then close it. */
async function setHidden(app, hidden, { fromNote = false } = {}) {
  if (fromNote) {
    await (await app.find(By.css('[data-testid="metrics-hidden"] button'))).click();
  } else {
    await app.palette("cluster settings", "Cluster settings");
  }
  const dialog = await app.find(byTestId("cluster-settings"));
  const box = await dialog.findElement(By.css('input[aria-label="Hide metrics"]'));
  if ((await box.isSelected()) !== hidden) await box.click();
  await app.waitFor(async () => (await box.isSelected()) === hidden, { message: `Hide metrics ${hidden}` });
  await (await dialog.findElement(By.xpath(".//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("cluster-settings"))).length === 0, {
    message: "the cluster settings to close",
  });
}

describe("hide metrics per cluster", { timeout: 15 * 60_000 }, () => {
  const s = appSession("hide-metrics");

  it("shown by default: Pods have CPU and Memory, the overview its usage (light)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "light");
    await waitLive(app);
    await app.waitFor(async () => /used \(/.test(await capacityText(app)), {
      timeout: 90_000,
      message: "the overview's usage from metrics-server",
    });
    assert.equal(await noteText(app), "");
    await app.nav("Pods");
    const t = await app.waitFor(
      async () => {
        const d = await tableData(app);
        return d?.headers.includes("CPU") && d.rows.some((r) => r.CPU && r.CPU !== "—") ? d : null;
      },
      { timeout: 90_000, message: "CPU values in the Pods table" },
    );
    assert.ok(t.headers.includes("Memory"));
    assert.equal(await noteText(app), "");
  });

  it("hidden from the cluster settings: no metric columns in Pods, a note (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await setHidden(app, true);
    const t = await waitHeaders(app, (h) => !h.includes("CPU"), "the CPU column to go");
    assert.ok(!t.headers.includes("Memory"), `headers: ${t.headers}`);
    assert.match(await noteText(app), /Metrics hidden for this cluster\s+—\s+Settings/);
    // Saved for this context only, after the debounced write.
    await app.waitFor(() => s.app.profile.settings()?.contexts?.[CONTEXT]?.hide_metrics === true, {
      message: "hide_metrics in settings.json",
    });
  });

  it("hidden: Nodes have no CPU, Memory or Disk either (dark)", T, async () => {
    const { app } = s;
    await app.nav("Nodes");
    const t = await waitHeaders(app, (h) => h.includes("Ready"), "the Nodes table");
    for (const h of ["CPU", "Memory", "Disk"]) assert.ok(!t.headers.includes(h), `headers: ${t.headers}`);
    assert.match(await noteText(app), /Metrics hidden for this cluster/);
  });

  it("hidden: the pod panel shows the note instead of usage charts (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await app.nav("Pods");
    await app.filter("logger");
    const row = await app.find(By.css('[data-testid="resource-row"]'));
    await row.click();
    await app.find(By.css('[data-testid="detail-panel"] [data-testid="usage-charts"]'));
    await app.waitFor(async () => (await noteText(app, '[data-testid="usage-charts"]')) !== "", {
      message: "the note in the pod panel",
    });
    assert.equal((await app.driver.findElements(byTestId("usage-chart-cpu"))).length, 0);
    await app.filter("");
  });

  it("hidden: the overview shows requests, no usage, and the note (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await app.nav("Overview");
    await app.waitFor(async () => /requested/.test(await capacityText(app)), { message: "the capacity section" });
    const text = await capacityText(app);
    assert.doesNotMatch(text, /used \(/);
    assert.match(text, /Metrics hidden for this cluster/);
  });

  it("still hidden after a restart (light)", T, async () => {
    const { app } = s;
    await app.restart();
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "light");
    await waitLive(app);
    await app.nav("Pods");
    const t = await waitHeaders(app, (h) => h.includes("Name"), "the Pods table");
    assert.ok(!t.headers.includes("CPU"), `headers: ${t.headers}`);
    assert.match(await noteText(app), /Metrics hidden for this cluster/);
  });

  it("shown again from the note's Settings link: the columns come back (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    await setHidden(app, false, { fromNote: true });
    await app.waitFor(
      async () => {
        const d = await tableData(app);
        return d?.headers.includes("CPU") && d.rows.some((r) => r.CPU && r.CPU !== "—");
      },
      { timeout: 90_000, message: "CPU values back in the Pods table" },
    );
    assert.equal(await noteText(app), "");
    await app.waitFor(() => s.app.profile.settings()?.contexts?.[CONTEXT]?.hide_metrics === false, {
      message: "hide_metrics false in settings.json",
    });
  });
});

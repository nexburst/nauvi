// Area 3 of #83, as the namespace-scoped user from
// scripts/test-cluster/limited-user.sh (edit in team-a only):
// - PR #87: the ServiceAccount team-a/limited shows its RoleBindings (or the
//   group's own error), and "Cluster role bindings" shows a forbidden error
//   in the group instead of failing the panel
// - PR #64: per-group 403s stay in their group (a Deployment panel)
// - PR #92: the Workloads overview is scoped to team-a and says what it
//   could not see; a Deployment's charts still load
// Skipped unless NAUVI_LIMITED_KUBECONFIG names that kubeconfig.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { panelText, relatedGroups, usageCharts, waitRelatedGroup } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 120_000 };
const kubeconfig = process.env.NAUVI_LIMITED_KUBECONFIG;
const skip = kubeconfig && existsSync(kubeconfig) ? false : "set NAUVI_LIMITED_KUBECONFIG (limited-user.sh)";

function summary(groups) {
  return groups.map((g) => ({ title: g.title, error: g.error, rows: g.rows.length }));
}

describe("area 3: detail panels as the namespace-scoped user", { timeout: 10 * 60_000, skip }, () => {
  const s = appSession("area-3-limited", { kubeconfig });

  it("ServiceAccount team-a/limited: RoleBindings, and a forbidden Cluster role bindings group", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.openDetail("Service Accounts", "team-a", "limited");
    const crb = await waitRelatedGroup(app, "Cluster role bindings");
    const groups = await relatedGroups(app);
    console.log(`limited SA: ${JSON.stringify(summary(groups))}`);
    assert.match(crb.error, /forbidden|not allowed|can't|cannot/i, "the group says it was forbidden");
    const rb = groups.find((g) => g.title === "Role bindings");
    assert.ok(rb, "a Role bindings group");
    assert.ok(rb.error || rb.rows.some((r) => r.includes("limited-edit")), "limited-edit or the group's error");
    // The rest of the panel still renders.
    assert.match(await panelText(app), /Labels|Created|Name/);
  });

  it("Deployment team-a/hello: related groups and usage charts load", T, async () => {
    const { app } = s;
    await app.openDetail("Deployments", "team-a", "hello");
    await waitRelatedGroup(app, "Pods");
    const groups = await relatedGroups(app);
    console.log(`limited Deployment: ${JSON.stringify(summary(groups))}`);
    assert.ok(groups.find((g) => g.title === "Pods").rows.length >= 1);
    const u = await app.waitFor(
      async () => {
        const v = await usageCharts(app);
        return v && !v.text.includes("Loading") ? v : null;
      },
      { timeout: 60_000, message: "the usage charts" },
    );
    console.log(`limited Deployment charts: ${JSON.stringify({ ...u, text: undefined })}`);
    assert.ok(u.since || u.source || u.empty, "a chart state");
    await app.js(`document.querySelector('[data-testid="detail-panel"] [data-testid="usage-charts"]')?.scrollIntoView()`);
  });

  it("the Workloads overview is scoped to team-a with its notes", T, async () => {
    const { app } = s;
    await (await app.find(By.css('nav button[aria-label="Workloads overview"]'))).click();
    await app.find(byTestId("workloads-overview"));
    const text = await app.waitFor(
      async () => {
        const t = await app.js(`return document.querySelector('[data-testid="workloads-overview"]').innerText`);
        return t.includes("Deployments") ? t : null;
      },
      { timeout: 30_000, message: "workload counts" },
    );
    console.log(`limited workloads overview:\n${text}`);
    assert.match(text, /Workloads in namespace team-a/);
    const card = await app.js(
      `return document.querySelector('[data-testid="workloads-overview"] section.card[data-kind="Deployment"] .total')?.textContent.trim()`,
    );
    // hello, plus whatever other QA runs put in team-a meanwhile.
    assert.ok(Number(card) >= 1, `Deployments card: ${card}`);
  });
});

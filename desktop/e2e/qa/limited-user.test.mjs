// Helper: launching with a given KUBECONFIG (`launch(name, { kubeconfig })`).
// Checks (#56): as the namespace-scoped user from
// scripts/test-cluster/limited-user.sh, the app opens on team-a, Pods list
// and go Live, and Nodes is greyed out with a reason.
//
// Skipped unless KUBELOUPE_LIMITED_KUBECONFIG names that kubeconfig.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { appSession, waitLive } from "../lib/qa.mjs";

const T = { timeout: 120_000 };
const kubeconfig = process.env.KUBELOUPE_LIMITED_KUBECONFIG;
const skip = kubeconfig && existsSync(kubeconfig) ? false : "set KUBELOUPE_LIMITED_KUBECONFIG (limited-user.sh)";

describe("namespace-scoped user", { timeout: 10 * 60_000, skip }, () => {
  const s = appSession("limited-user", { kubeconfig });

  it("greys out Nodes with the reason", T, async () => {
    const { app } = s;
    const nodes = await app.find(By.xpath("//nav//button[normalize-space()='Nodes']"));
    await app.waitFor(async () => (await nodes.getAttribute("class")).includes("denied"), {
      timeout: 30_000,
      message: "Nodes greyed out",
    });
    assert.equal(await nodes.getAttribute("title"), "You are not allowed to list Nodes");
  });

  it("lists the pods of team-a and goes Live", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await waitLive(app);
    const ns = await app.find(By.css('button[aria-label="Namespace"]'));
    assert.equal((await ns.getText()).trim(), "team-a");
    await app.waitFor(async () => (await app.rows()).some(([, n]) => n === "team-a"), { message: "a pod in team-a" });
  });
});

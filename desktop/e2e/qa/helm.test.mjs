// Uses helm (qa.sh puts one on PATH, from the cache if needed).
// Checks (#46): a release installed with helm in a temp namespace is listed
// under Helm > Releases and opens its detail with the history.

import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, REPO, byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const T = { timeout: 120_000 };
const CHART = `${REPO}/scripts/test-cluster/charts/demo-chart`;
let skip = false;
try {
  execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
} catch {
  skip = "helm is not on PATH";
}
let ns;

describe("helm releases", { timeout: 10 * 60_000, skip }, () => {
  before(() => {
    ns = tempNamespace("qa-helm");
    execFileSync("helm", ["--kube-context", CONTEXT, "-n", ns, "install", "qa-demo", CHART, "--wait", "--timeout", "180s"], {
      stdio: "pipe",
    });
  });
  after(() => deleteNamespace(ns));
  const s = appSession("helm");

  it("lists the release and opens its history", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.nav("Releases");
    const row = await app.find(
      By.xpath(`//*[@data-testid='helm-row'][*[@role='gridcell'][1][normalize-space()='qa-demo']][*[@role='gridcell'][2][normalize-space()=${xq(ns)}]]`),
    );
    await row.click();
    const detail = await app.find(byTestId("helm-detail"));
    await (await detail.findElement(By.xpath(".//*[@role='tab'][normalize-space()='History']"))).click();
    const history = await app.find(byTestId("helm-history"));
    await app.waitFor(async () => /\b1\s+deployed\b/.test(await app.js("return arguments[0].innerText", history)), {
      message: "revision 1 deployed in the history",
    });
  });
});

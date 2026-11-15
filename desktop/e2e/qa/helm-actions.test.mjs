// Uses helm (qa.sh puts one on PATH, from the cache if needed).
// Checks (#122): a release stored in ConfigMaps (HELM_DRIVER=configmap) is
// rolled back and uninstalled from the GUI, where it is stored (helm's own
// history and list, with the ConfigMap driver, agree). A release stored in
// Secrets next to it is left alone.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, REPO, byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";

const T = { timeout: 180_000 };
const CHART = `${REPO}/scripts/test-cluster/charts/demo-chart`;
const CM = { HELM_DRIVER: "configmap" };
let skip = false;
try {
  execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
} catch {
  skip = "helm is not on PATH";
}

const helm = (args, env = {}) =>
  execFileSync("helm", ["--kube-context", CONTEXT, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });

const textOf = (app, testid) => app.js(`return document.querySelector('[data-testid="${testid}"]')?.innerText ?? ""`);
const button = (testid, text) => By.xpath(`//*[@data-testid=${xq(testid)}]//button[normalize-space()=${xq(text)}]`);
const releaseRow = (name, ns) =>
  By.xpath(`//*[@data-testid='helm-row'][*[@role='gridcell'][1][normalize-space()=${xq(name)}]][*[@role='gridcell'][2][normalize-space()=${xq(ns)}]]`);

async function openRelease(app, name, ns) {
  await (await app.find(releaseRow(name, ns), { timeout: 60_000 })).click();
  await app.waitFor(async () => (await textOf(app, "helm-detail")).includes(`${ns}/${name}`), { message: `${ns}/${name} detail` });
  await app.waitFor(async () => (await textOf(app, "helm-status")) !== "", { message: "the release loaded" });
}

/** The dialog closed ("closed"), or the error it shows. */
function dialogOutcome(app, what) {
  return app.waitFor(
    async () => {
      if ((await app.driver.findElements(byTestId("helm-dialog"))).length === 0) return "closed";
      const err = await app.js(`return document.querySelector('[data-testid="helm-dialog"] [role="alert"]')?.innerText ?? ""`);
      return err ? `error: ${err}` : null;
    },
    { timeout: 120_000, message: `the ${what} to finish or fail` },
  );
}

let ns;

describe("helm actions on a release stored in ConfigMaps (#122)", { timeout: 10 * 60_000, skip }, () => {
  before(() => {
    ns = tempNamespace("qa-helm-actions");
    helm(["-n", ns, "install", "qa-cm", CHART, "--set", "greeting=first", "--set", "replicas=0"], CM);
    helm(["-n", ns, "upgrade", "qa-cm", CHART, "--set", "greeting=second", "--set", "replicas=0"], CM);
    helm(["-n", ns, "install", "qa-secret", CHART, "--set", "replicas=0"]);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("helm-actions");

  it("lists both releases; the ConfigMap one says where it is stored", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.nav("Releases");
    await pickNamespaces(app, [ns]);
    await app.find(releaseRow("qa-secret", ns), { timeout: 60_000 });
    await openRelease(app, "qa-cm", ns);
    assert.match(await textOf(app, "helm-detail"), /Storage\s+ConfigMaps/);
  });

  it("rolls the ConfigMap release back to revision 1", T, async () => {
    const { app } = s;
    await (await app.find(By.xpath(`//*[@data-testid='helm-detail']//*[@role='tab'][normalize-space()='History']`))).click();
    await (await app.find(button("helm-history", "Roll back to 1…"))).click();
    await (await app.find(byTestId("helm-confirm"))).click();
    const outcome = await dialogOutcome(app, "rollback");
    console.log(`rollback: ${outcome}`);
    assert.equal(outcome, "closed");
    const history = JSON.parse(helm(["-n", ns, "history", "qa-cm", "-o", "json"], CM));
    console.log(`helm history (configmap driver): ${JSON.stringify(history.map((h) => [h.revision, h.status, h.description]))}`);
    assert.equal(history.at(-1).revision, 3);
    assert.match(history.at(-1).description, /Rollback to 1/);
    await app.waitFor(async () => /\b3\b/.test(await textOf(app, "helm-history")), { message: "revision 3 in the History tab" });
  });

  it("uninstalls the ConfigMap release", T, async () => {
    const { app } = s;
    await (await app.find(button("helm-detail", "Uninstall…"))).click();
    await app.setValue(await app.find(By.css('[data-testid="helm-dialog"] input')), "qa-cm");
    await (await app.find(byTestId("helm-confirm"))).click();
    const outcome = await dialogOutcome(app, "uninstall");
    console.log(`uninstall: ${outcome}`);
    assert.equal(outcome, "closed");
    const left = JSON.parse(helm(["-n", ns, "list", "-a", "-o", "json"], CM)).map((r) => r.name);
    assert.ok(!left.includes("qa-cm"), `helm list (configmap driver): ${left}`);
    await app.waitFor(async () => (await app.driver.findElements(releaseRow("qa-cm", ns))).length === 0, { message: "the row gone" });
    // The Secret release is still there.
    await app.find(releaseRow("qa-secret", ns));
    const secrets = JSON.parse(helm(["-n", ns, "list", "-a", "-o", "json"])).map((r) => r.name);
    assert.deepEqual(secrets, ["qa-secret"]);
  });
});

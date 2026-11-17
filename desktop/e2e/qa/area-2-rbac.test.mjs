// Area 2 of #83, PR #23, and #340: a user without delete rights gets no
// delete. Since #340 the bulk bar and the row menu refuse it up front, with
// the missing permission, and no dialog opens (when the access check cannot
// be made, the per-object 403 list still shows; see actions.spec.ts in
// Playwright). The scenario makes its own read-only user: a
// ServiceAccount bound to `view` in a temp namespace, with a short token in a
// private kubeconfig (it never touches ~/.kube/config).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { closeMenu, contextMenu, openKind } from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };
const CONFIGMAPS = ["qa-ro-a", "qa-ro-b", "qa-ro-c"];
let ns;
let dir;

function viewerKubeconfig(namespace) {
  kubectl(
    ["-n", namespace, "apply", "-f", "-"],
    `apiVersion: v1
kind: ServiceAccount
metadata: { name: qa-viewer }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: qa-viewer }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: view }
subjects: [{ kind: ServiceAccount, name: qa-viewer, namespace: ${namespace} }]
`,
  );
  const token = kubectl(["-n", namespace, "create", "token", "qa-viewer", "--duration=1h"]);
  const server = kubectl(["config", "view", "--minify", "--flatten", "-o", "jsonpath={.clusters[0].cluster.server}"]);
  const ca = kubectl(["config", "view", "--minify", "--flatten", "-o", "jsonpath={.clusters[0].cluster.certificate-authority-data}"]);
  dir = mkdtempSync(join(tmpdir(), "qa-area2-viewer-"));
  const path = join(dir, "kubeconfig");
  writeFileSync(
    path,
    `apiVersion: v1
kind: Config
clusters: [{ name: qa, cluster: { server: "${server}", certificate-authority-data: "${ca}" } }]
users: [{ name: qa-viewer, user: { token: "${token}" } }]
contexts: [{ name: qa-viewer, context: { cluster: qa, user: qa-viewer, namespace: ${namespace} } }]
current-context: qa-viewer
`,
    { mode: 0o600 },
  );
  return path;
}

describe("area 2: bulk delete without delete rights", { timeout: 10 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace(
      "qa-area2-rbac",
      CONFIGMAPS.map((n) => `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: ${n} }\ndata: { k: v }`).join("\n---\n"),
    );
  });
  after(() => {
    deleteNamespace(ns);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const s = appSession("area-2-rbac", () => ({ kubeconfig: viewerKubeconfig(ns) }));

  it("refuses the delete up front, with the missing permission", T, async () => {
    const { app } = s;
    const reason = `Not allowed: you can't delete configmaps in namespace ${ns}`;
    await openKind(app, "Config Maps", ns, "qa-ro-");
    await waitLive(app);
    await app.waitFor(async () => (await app.rows()).length === CONFIGMAPS.length, { message: "3 ConfigMaps" });

    // The row menu: Delete greyed, with the reason under it.
    await contextMenu(app, "qa-ro-a", ns);
    const item = await app.waitFor(
      () =>
        app.js(`
          const b = Array.from(document.querySelectorAll('[data-testid="context-menu"] [role="menuitem"]'))
            .find((b) => b.textContent.trim() === "Delete");
          const r = b && document.getElementById(b.getAttribute("aria-describedby") ?? "");
          return r ? { disabled: b.disabled, reason: r.textContent.trim() } : null;`),
      { message: "the row menu's Delete greyed" },
    );
    console.log(`menu Delete for a viewer: ${JSON.stringify(item)}`);
    assert.deepEqual(item, { disabled: true, reason });
    await app.shot("forbidden-menu");
    await closeMenu(app);

    // The bulk bar: Delete 3 greyed, with the reason; clicking opens nothing.
    await (await app.driver.findElement(By.css('input[aria-label="Select all visible rows"]'))).click();
    const bulk = await app.waitFor(
      () => app.js(`return document.querySelector('[data-testid="bulk-reason"]')?.textContent.trim() ?? null`),
      { message: "the selection bar's reason" },
    );
    console.log(`selection bar: ${bulk}`);
    assert.equal(bulk, reason);
    const del = await app.find(
      By.xpath("//*[@aria-label='Selection']//button[starts-with(normalize-space(),'Delete 3')]"),
    );
    assert.equal(await del.getAttribute("aria-disabled"), "true");
    await del.click();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await app.driver.findElements(By.css('[data-testid="action-dialog"]'))).length, 0, "no dialog");
    await app.shot("forbidden-bulk");
    assert.equal((await app.rows()).length, CONFIGMAPS.length, "nothing was deleted");
  });
});

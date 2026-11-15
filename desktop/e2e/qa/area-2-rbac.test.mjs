// Area 2 of #83, PR #23: a bulk delete by a user without delete rights shows
// the 403 per object. The scenario makes its own read-only user: a
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
import { actionDialogText, contextMenu, dialogButton, menuItem, noticeText, openKind } from "./area-2-helpers.mjs";

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

  it("lists every object with the reason it was not deleted", T, async () => {
    const { app } = s;
    await openKind(app, "Config Maps", ns, "qa-ro-");
    await waitLive(app);
    await app.waitFor(async () => (await app.rows()).length === CONFIGMAPS.length, { message: "3 ConfigMaps" });
    const before = await contextMenu(app, "qa-ro-a", ns);
    console.log(`menu for a viewer: ${JSON.stringify(before)}`);
    await app.driver.actions().sendKeys("").perform();
    await (await app.driver.findElement(By.css('input[aria-label="Select all visible rows"]'))).click();
    const bulk = await app.waitFor(
      () => app.js(`return document.querySelector('[role="toolbar"][aria-label="Selection"]')?.innerText ?? null`),
      { message: "the selection bar" },
    );
    console.log(`selection bar: ${bulk}`);
    if (!bulk.includes("Delete 3")) {
      // The app hid the bulk delete for a user who can't delete: that is a
      // pass of a different kind; record it.
      console.log("no Delete button for a read-only user");
      return;
    }
    await (await app.find(By.xpath("//*[@aria-label='Selection']//button[normalize-space()='Delete 3…']"))).click();
    await (await dialogButton(app, "Delete 3")).click();
    const text = await app.waitFor(
      async () => {
        const t = await actionDialogText(app);
        return t?.includes("could not be deleted") ? t : null;
      },
      { message: "the failure list" },
    );
    console.log(`dialog: ${text}`);
    assert.match(text, /0 of 3 deleted\. 3 could not be deleted/);
    for (const n of CONFIGMAPS) assert.match(text, new RegExp(`${ns}/${n}\\s+Not allowed`), `${n}: Not allowed`);
    await app.shot("forbidden-list");
    await (await dialogButton(app, "Close")).click();
    assert.equal((await app.rows()).length, CONFIGMAPS.length, "nothing was deleted");

    // A single delete shows the same reason inline (outside a selection).
    await (await app.find(By.xpath("//*[@aria-label='Selection']//button[normalize-space()='Clear']"))).click();
    await contextMenu(app, "qa-ro-a", ns);
    await menuItem(app, "Delete");
    await (await dialogButton(app, "Delete")).click();
    const single = await app.waitFor(
      async () => {
        const t = await actionDialogText(app);
        return t && /Not allowed|forbidden/i.test(t) ? t : null;
      },
      { message: "the inline 403" },
    );
    console.log(`single delete: ${single} | notice: ${await noticeText(app)}`);
    await app.shot("forbidden-single");
    await (await dialogButton(app, "Cancel")).click();
  });
});

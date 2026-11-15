// QA area 1 (#83): the generic resource browser (#21).
// Checks: every built-in kind in the sidebar lists without an error; a CRD
// applied with kubectl shows under Custom Resources by API group after
// Refresh, and its objects list; a ConfigMap and a Deployment open the
// generic panel, show YAML, save an edit twice in a row (no 409) and delete;
// kubectl create/delete of a ConfigMap shows without Refresh, and scaling a
// Deployment changes its Ready column; owner links go pod -> ReplicaSet ->
// Deployment; a Secret's values are hidden, Review stays disabled until
// Reveal, and a save after Reveal works.
//
// Objects live in a temporary qa-area1-* namespace; the CRD has a unique
// name and is deleted afterwards.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, kubectl, podNames, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { bannerText, tableData } from "../lib/table.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const suffix = `${Date.now().toString(36)}${process.pid.toString(36)}`;
const GROUP = `qa-area1-${suffix}.kubeloupe.dev`;
const CRD = `gadgets.${GROUP}`;

const fixtures = `
apiVersion: v1
kind: ConfigMap
metadata:
  name: qa-area1-cm
data:
  greeting: hello
---
apiVersion: v1
kind: Secret
metadata:
  name: qa-area1-secret
stringData:
  password: s3cret-qa-value
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: qa-area1-dep
spec:
  replicas: 1
  selector:
    matchLabels:
      app: qa-area1-dep
  template:
    metadata:
      labels:
        app: qa-area1-dep
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: app
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "sleep 3600"]
`;

const crdYaml = `
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: ${CRD}
spec:
  group: ${GROUP}
  scope: Namespaced
  names:
    plural: gadgets
    singular: gadget
    kind: Gadget
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          x-kubernetes-preserve-unknown-fields: true
`;

/** Kinds that fail for a known, filed reason; checked by their own todo test. */
const KNOWN = {};

/** The header status of a kind without the watch verb, listed every 30 s (#95). */
const POLLING = "Not live: refreshed every 30 s";

/** Wait until the table is live, or polled for a kind that cannot be watched. */
function waitListed(app, timeout) {
  return app.waitFor(async () => ["Live", POLLING].includes(await app.statusText()), {
    timeout,
    message: `header status "Live" or "${POLLING}"`,
  });
}

/** Open a kind and return what is wrong with its table, or "". */
async function kindProblem(app, label) {
  await app.js(`document.querySelectorAll("nav details").forEach((d) => (d.open = true))`);
  await app.nav(label);
  try {
    await app.find(By.css(`[data-testid="resource-table"] [role="grid"][aria-label=${JSON.stringify(label)}]`));
    await waitListed(app, 30_000);
  } catch {
    await app.shot(`kind-${label}`);
    return `${label}: ${await app.statusText().catch(() => "?")} ${await bannerText(app)}`;
  }
  const banner = await bannerText(app);
  return banner ? `${label}: ${banner}` : "";
}

const panelText = (app) =>
  app.js(`return document.querySelector('[data-testid="detail-panel"]')?.innerText ?? ""`);

async function openTab(app, label) {
  await (
    await app.find(By.xpath(`//*[@data-testid='detail-panel']//button[@role='tab'][normalize-space()=${xq(label)}]`))
  ).click();
}

/** The YAML in the panel's editor once it contains `needle`. */
async function editorValue(app, needle) {
  const editor = await app.find(byTestId("yaml-editor"));
  return app.waitFor(
    async () => {
      const v = await app.js("return arguments[0].kubeloupeEditor?.getValue() ?? null", editor);
      return v?.includes(needle) ? v : null;
    },
    { message: `"${needle}" in the editor` },
  );
}

/** Replace the editor text, Review, Save and wait for "Saved". */
async function saveYaml(app, text) {
  const editor = await app.find(byTestId("yaml-editor"));
  await app.js("arguments[0].kubeloupeEditor.setValue(arguments[1])", editor, text);
  const review = await app.find(byTestId("yaml-review"));
  await app.waitFor(() => review.isEnabled(), { message: "Review enabled by the edit" });
  await review.click();
  await (await app.find(byTestId("yaml-save"))).click();
  return app.waitFor(
    async () => {
      const status = await app.js(`return document.querySelector('[data-testid="yaml-status"]')?.textContent.trim() ?? ""`);
      const err = await app.js(
        `return document.querySelector('[data-testid="detail-panel"] .banner.error, [data-testid="detail-panel"] .banner.conflict')?.innerText ?? ""`,
      );
      if (err) throw new Error(`save failed: ${err}`);
      return /saved/i.test(status) ? status : null;
    },
    { message: "Saved" },
  );
}

/** Delete the object in the panel through its Delete action. */
async function deleteFromPanel(app) {
  const del = await app.find(
    By.xpath("//*[@data-testid='detail-panel']//*[@role='toolbar']//button[starts-with(normalize-space(),'Delete')]"),
  );
  await del.click();
  const confirm = await app.find(byTestId("action-confirm"));
  await app.waitFor(() => confirm.isEnabled(), { message: "the Delete confirm button" });
  await confirm.click();
}

describe("area 1: the generic resource browser", { timeout: 20 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-area1-res", fixtures);
    kubectl(["-n", ns, "rollout", "status", "deploy/qa-area1-dep", "--timeout=180s"]);
  });
  after(() => {
    deleteNamespace(ns);
    try {
      kubectl(["delete", "crd", CRD, "--ignore-not-found", "--wait=false"]);
    } catch (e) {
      console.error(`could not delete ${CRD}: ${e.message}`);
    }
  });
  const s = appSession("area-1-resources");

  it("every built-in kind in the sidebar lists without an error", { timeout: 600_000 }, async () => {
    const { app } = s;
    await waitLive(app);
    // Open the API group folds (Custom Resources, Other), and take each
    // label once (metrics.k8s.io has its own Nodes and Pods). Views that are
    // not a kind's table are left out: the Overviews, Port Forwards and the
    // Helm section.
    const labels = await app.js(
      `document.querySelectorAll("nav details").forEach((d) => (d.open = true));
       let section = "";
       const all = [];
       for (const el of document.querySelectorAll("nav h4, nav button")) {
         if (el.tagName === "H4") { section = el.textContent.trim(); continue; }
         const label = el.childNodes[0]?.textContent.trim() ?? "";
         if (label && section !== "Helm" && label !== "Overview" && label !== "Port Forwards") all.push(label);
       }
       return [...new Set(all)];`,
    );
    console.log(`kinds: ${labels.length}: ${labels.join(", ")}`);
    assert.ok(labels.length >= 30, `only ${labels.length} kinds in the sidebar`);
    const problems = [];
    for (const label of labels.filter((l) => !KNOWN[l])) {
      const problem = await kindProblem(app, label);
      if (problem) problems.push(problem);
    }
    assert.deepEqual(problems, []);
  });

  it("Component Statuses (no watch verb) lists and says it is not live", T, async () => {
    const { app } = s;
    // Matches the label before and after the sidebar-name fix (#96).
    const label = await app.js(
      `document.querySelectorAll("nav details").forEach((d) => (d.open = true));
       return [...document.querySelectorAll("nav button")]
         .map((b) => b.childNodes[0]?.textContent.trim() ?? "")
         .find((l) => /^component ?statuses$/i.test(l)) ?? "";`,
    );
    assert.ok(label, "Component Statuses in the sidebar");
    assert.equal(await kindProblem(app, label), "");
    await app.waitFor(async () => (await tableData(app)).rows.some((r) => r.Name === "scheduler"), {
      message: "the scheduler row",
    });
    assert.equal(await app.statusText(), POLLING);
    assert.equal(await bannerText(app), "");
    await app.shot("componentstatuses-polled");
  });

  it("sidebar names are readable, unique and fit the sidebar (#96)", T, async () => {
    const { app } = s;
    await app.js(`document.querySelectorAll("nav details").forEach((d) => (d.open = true))`);
    const kinds = await app.js(
      `const nav = document.querySelector("nav").getBoundingClientRect();
       return Array.from(document.querySelectorAll("nav button.kind"), (b) => {
         const label = b.querySelector(".label");
         return {
           label: label.textContent.trim(),
           title: b.title,
           clipped: label.scrollHeight > label.clientHeight + 1 || label.scrollWidth > label.clientWidth + 1,
           wrapped: label.getClientRects().length > 0 && label.clientHeight > 1.5 * parseFloat(getComputedStyle(label).lineHeight),
           inside: b.getBoundingClientRect().right <= nav.right + 0.5,
         };
       });`,
    );
    const labels = kinds.map((k) => k.label);
    console.log(`sidebar kinds: ${labels.join(", ")}`);
    const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
    assert.deepEqual(dupes, [], "two sidebar entries with the same name");
    for (const name of ["Component Statuses", "Controller Revisions", "Mutating Admission Policies", "Node Metrics", "Pod Metrics"]) {
      assert.ok(labels.includes(name), `"${name}" in the sidebar`);
    }
    // No run-together plural like "Componentstatuses" or "Csinodes".
    const runTogether = labels.filter((l) => /^[A-Z][a-z]{13,}$/.test(l) || /^Csi|^Api[a-z]|^Ip[a-z]/.test(l));
    assert.deepEqual(runTogether, []);
    // Long names wrap onto a second line; every built-in name fits in full.
    assert.deepEqual(
      kinds.filter((k) => !k.inside || k.clipped).map((k) => k.label),
      [],
      "every label in full inside the sidebar",
    );
    console.log(`wrapped: ${kinds.filter((k) => k.wrapped).map((k) => k.label).join(", ")}`);
    for (const k of kinds) assert.ok(k.title.startsWith(`${k.label}: `), `tooltip of ${k.label}: ${k.title}`);
    const long = await app.find(app.navButton("Validating Admission Policy Bindings"));
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", long);
    await app.shot("sidebar-names");
  });

  it("a new CRD shows under Custom Resources by API group after Refresh", T, async () => {
    const { app } = s;
    kubectl(["apply", "-f", "-"], crdYaml);
    kubectl(["wait", "--for=condition=Established", `crd/${CRD}`, "--timeout=60s"]);
    kubectl(
      ["-n", ns, "apply", "-f", "-"],
      `apiVersion: ${GROUP}/v1\nkind: Gadget\nmetadata:\n  name: qa-area1-gadget\nspec:\n  size: 3\n`,
    );
    await (await app.find(By.xpath("//header//button[normalize-space()='Refresh']"))).click();
    const group = await app.find(By.xpath(`//nav//details/summary[normalize-space()=${xq(GROUP)}]`), {
      timeout: 60_000,
    });
    const heading = await app.js(
      `let e = arguments[0].parentElement; while (e && e.tagName !== "H4") e = e.previousElementSibling; return e?.textContent.trim() ?? "";`,
      group,
    );
    assert.equal(heading, "Custom Resources");
    await app.js("arguments[0].parentElement.open = true", group);
    await app.nav("Gadgets");
    await waitLive(app);
    await app.waitFor(async () => (await tableData(app)).rows.some((r) => r.Name === "qa-area1-gadget" && r.Namespace === ns), {
      message: "the Gadget object in its table",
    });
    await app.shot("crd-instances");
  });

  it("ConfigMap: generic panel, YAML, two saves in a row without a 409", T, async () => {
    const { app } = s;
    await app.openDetail("Config Maps", ns, "qa-area1-cm");
    assert.match(await panelText(app), /qa-area1-cm/);
    await openTab(app, "YAML");
    const yaml = await editorValue(app, "greeting: hello");
    await saveYaml(app, yaml.replace("greeting: hello", "greeting: first"));
    assert.equal(kubectl(["-n", ns, "get", "cm", "qa-area1-cm", "-o", "jsonpath={.data.greeting}"]), "first");
    // Again, without reloading: the editor must hold the new resourceVersion.
    await sleep(500);
    const second = await editorValue(app, "greeting: first");
    await saveYaml(app, second.replace("greeting: first", "greeting: second"));
    assert.equal(kubectl(["-n", ns, "get", "cm", "qa-area1-cm", "-o", "jsonpath={.data.greeting}"]), "second");
  });

  it("Deployment: YAML save, and scaling changes Ready live", T, async () => {
    const { app } = s;
    await app.openDetail("Deployments", ns, "qa-area1-dep");
    await openTab(app, "YAML");
    const yaml = await editorValue(app, "name: qa-area1-dep");
    await saveYaml(app, yaml.replace(/^metadata:\n/m, "metadata:\n  labels:\n    qa-area1: edited\n"));
    assert.equal(kubectl(["-n", ns, "get", "deploy", "qa-area1-dep", "-o", "jsonpath={.metadata.labels.qa-area1}"]), "edited");
    const ready = async () => (await tableData(app)).rows.find((r) => r.Name === "qa-area1-dep")?.Ready;
    await app.waitFor(async () => (await ready()) === "1/1", { message: "Ready 1/1" });
    kubectl(["-n", ns, "scale", "deploy/qa-area1-dep", "--replicas=2"]);
    await app.waitFor(async () => /\/2$/.test((await ready()) ?? ""), { message: "Ready x/2 after scaling" });
    // The new pod's start depends on the (shared, sometimes busy) cluster.
    kubectl(["-n", ns, "rollout", "status", "deploy/qa-area1-dep", "--timeout=300s"]);
    await app.waitFor(async () => (await ready()) === "2/2", { timeout: 30_000, message: "Ready 2/2" });
    await app.shot("deployment-scaled");
  });

  it("owner links go pod -> ReplicaSet -> Deployment", T, async () => {
    const { app } = s;
    const [pod] = podNames(ns, "app=qa-area1-dep");
    await app.openDetail("Pods", ns, pod);
    const owner = async (kind) =>
      app.find(By.xpath(`//*[@data-testid='detail-panel']//button[contains(@class,'link')][starts-with(normalize-space(),${xq(`${kind}/`)})]`));
    const rsLink = await owner("ReplicaSet");
    const rs = (await rsLink.getText()).replace("ReplicaSet/", "").trim();
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", rsLink);
    await rsLink.click();
    await app.waitFor(async () => (await panelText(app)).includes(`${ns}/${rs}`), { message: "the ReplicaSet panel" });
    await app.shot("replicaset-panel");
    const depLink = await owner("Deployment");
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", depLink);
    await depLink.click();
    await app.waitFor(async () => (await panelText(app)).includes(`${ns}/qa-area1-dep`), { message: "the Deployment panel" });
    assert.match(
      await app.js(`return document.querySelector("nav button.active")?.textContent.trim() ?? ""`),
      /^Deployments/,
    );
  });

  it("Secret: values hidden, editing locked until Reveal, save after Reveal", T, async () => {
    const { app } = s;
    await app.openDetail("Secrets", ns, "qa-area1-secret");
    const overview = await app.waitFor(
      async () => {
        const t = await panelText(app);
        return /password/.test(t) ? t : null;
      },
      { message: "the password key in the Secret panel" },
    );
    assert.doesNotMatch(overview, /s3cret-qa-value|czNjcmV0LXFhLXZhbHVl/);
    await openTab(app, "YAML");
    const hidden = await editorValue(app, "qa-area1-secret");
    assert.doesNotMatch(hidden, /s3cret-qa-value|czNjcmV0LXFhLXZhbHVl/);
    assert.equal(await (await app.find(byTestId("yaml-review"))).isEnabled(), false, "Review disabled while hidden");
    assert.match(await app.js(`return document.querySelector('[data-testid="yaml-status"]').textContent`), /hidden/i);
    await app.shot("secret-hidden");
    await (await app.find(By.xpath("//*[@data-testid='detail-panel']//button[normalize-space()='Reveal values']"))).click();
    const revealed = await editorValue(app, "czNjcmV0LXFhLXZhbHVl");
    await saveYaml(app, revealed.replace("czNjcmV0LXFhLXZhbHVl", Buffer.from("changed-qa").toString("base64")));
    const got = kubectl(["-n", ns, "get", "secret", "qa-area1-secret", "-o", "jsonpath={.data.password}"]);
    assert.equal(Buffer.from(got, "base64").toString(), "changed-qa");
  });

  it("kubectl create and delete of a ConfigMap shows without Refresh", T, async () => {
    const { app } = s;
    await app.nav("Config Maps");
    await waitLive(app);
    await app.filter("qa-area1-live");
    kubectl(["-n", ns, "create", "configmap", "qa-area1-live", "--from-literal=a=b"]);
    await app.waitFor(async () => (await tableData(app)).rows.some((r) => r.Name === "qa-area1-live"), {
      message: "the new ConfigMap row",
    });
    kubectl(["-n", ns, "delete", "configmap", "qa-area1-live"]);
    await app.waitFor(async () => !(await tableData(app)).rows.some((r) => r.Name === "qa-area1-live"), {
      message: "the ConfigMap row gone",
    });
  });

  it("deletes a ConfigMap and a Deployment from their panels", T, async () => {
    const { app } = s;
    for (const [label, kind, name] of [
      ["Config Maps", "cm", "qa-area1-cm"],
      ["Deployments", "deploy", "qa-area1-dep"],
    ]) {
      await app.openDetail(label, ns, name);
      await deleteFromPanel(app);
      await app.waitFor(() => kubectl(["-n", ns, "get", kind, name, "--ignore-not-found", "-o", "name"]).trim() === "", {
        timeout: 60_000,
        message: `${name} deleted`,
      });
      await app.waitFor(async () => !(await tableData(app)).rows.some((r) => r.Name === name), {
        message: `${name} gone from the table`,
      });
      await app.shot(`deleted-${kind}`);
    }
  });
});

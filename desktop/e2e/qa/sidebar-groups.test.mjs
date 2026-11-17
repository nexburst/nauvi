// Checks (#332): the admission policies sit under Config and the Dynamic
// Resource Allocation kinds (resource.k8s.io) under their own Device
// Resources group, in WebKitGTK against kind.
// - Config lists the Validating/Mutating Admission Policies and bindings,
//   and Other no longer does.
// - Device Resources lists Device Classes, Resource Claims, Resource Claim
//   Templates and Resource Slices; on a cluster without the API they stay
//   there greyed out (served on kind >= 1.34, so the greyed state is covered
//   by the Playwright test sidebar-groups.spec.ts).
// - A ResourceClaim in a temp namespace shows State "Pending" (no driver
//   allocates it); a claim template lists its request and class; Device
//   Classes is an empty table on kind.
// Screenshots at 1280x800 in dark and light.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/theme.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces, tableData } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const CLASS = "qa-332.example.com";
const request = (indent) =>
  [
    "devices:",
    "  requests:",
    "  - name: gpu",
    "    exactly:",
    `      deviceClassName: ${CLASS}`,
  ]
    .map((l) => " ".repeat(indent) + l)
    .join("\n");
const DRA_OBJECTS = `---
apiVersion: resource.k8s.io/v1
kind: ResourceClaim
metadata:
  name: qa-claim
spec:
${request(2)}
---
apiVersion: resource.k8s.io/v1
kind: ResourceClaimTemplate
metadata:
  name: qa-template
spec:
  spec:
${request(4)}
`;

let ns;
let draServed = false;

/** The labels of the sidebar entries under the heading `title`, and whether each is greyed out. */
function section(app, title) {
  return app.js(
    `const h = Array.from(document.querySelectorAll("nav h4")).find((h) => h.textContent === arguments[0]);
     const out = [];
     for (let el = h?.nextElementSibling; el && el.tagName !== "H4"; el = el.nextElementSibling)
       if (el.tagName === "BUTTON") out.push({ label: el.textContent.trim(), absent: el.classList.contains("absent") });
     return out;`,
    title,
  );
}

/** Scroll the sidebar so `title` is at its top. */
function scrollTo(app, title) {
  return app.js(
    `Array.from(document.querySelectorAll("nav h4")).find((h) => h.textContent === arguments[0])?.scrollIntoView({ block: "start" });`,
    title,
  );
}

async function shots(app, label) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

describe("sidebar groups (#332)", { timeout: 15 * 60_000 }, () => {
  before(() => {
    draServed = kubectl(["api-resources", "--api-group=resource.k8s.io", "-o", "name"]).includes("resourceclaims");
    ns = tempNamespace("qa-sidebar-groups", draServed ? DRA_OBJECTS : "");
  });
  after(() => deleteNamespace(ns));
  const s = appSession("sidebar-groups");

  it("Config lists the admission policies, Other no longer does", T, async () => {
    const { app } = s;
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    await app.waitFor(async () => (await section(app, "Config")).length > 0, { message: "Config section" });
    const config = (await section(app, "Config")).map((e) => e.label);
    for (const label of [
      "Mutating Webhook Configs",
      "Validating Webhook Configs",
      "Validating Admission Policies",
      "Validating Admission Policy Bindings",
    ]) {
      assert.ok(config.includes(label), `Config has ${label}: ${config.join(", ")}`);
    }
    const other = (await section(app, "Other")).map((e) => e.label);
    assert.ok(!other.some((l) => /Admission Polic|Device Class|Resource (Claim|Slice)/.test(l)), other.join(", "));
    await scrollTo(app, "Config");
    await shots(app, "config");
  });

  it("Device Resources lists the DRA kinds", T, async () => {
    const { app } = s;
    const devices = await section(app, "Device Resources");
    const labels = devices.map((e) => e.label);
    for (const label of ["Device Classes", "Resource Claims", "Resource Claim Templates", "Resource Slices"]) {
      assert.ok(labels.includes(label), `Device Resources has ${label}: ${labels.join(", ")}`);
    }
    // On kind (>= 1.34) every one is served, so none is greyed out.
    if (draServed) assert.deepEqual(devices.filter((e) => e.absent), []);
    else assert.ok(devices.every((e) => e.absent), JSON.stringify(devices));
    await scrollTo(app, "Device Resources");
    await shots(app, "device-resources");
  });

  it("a ResourceClaim shows its state, a template its request", T, async (t) => {
    if (!draServed) return t.skip("the cluster does not serve resource.k8s.io");
    const { app } = s;
    await app.nav("Resource Claims");
    await pickNamespaces(app, [ns]);
    const claim = await app.waitFor(async () => (await tableData(app))?.rows.find((r) => r.Name === "qa-claim"), {
      message: "qa-claim row",
    });
    assert.equal(claim.State, "Pending");
    assert.equal(claim["Reserved For"], "");
    await shots(app, "resource-claims");

    await app.nav("Resource Claim Templates");
    const tpl = await app.waitFor(async () => (await tableData(app))?.rows.find((r) => r.Name === "qa-template"), {
      message: "qa-template row",
    });
    assert.equal(tpl.Requests, `gpu (${CLASS})`);
  });

  it("Device Classes is an empty table on kind", T, async (t) => {
    if (!draServed) return t.skip("the cluster does not serve resource.k8s.io");
    const { app } = s;
    if (kubectl(["get", "deviceclasses", "-o", "name"])) return t.skip("the cluster has DeviceClasses");
    await app.nav("Device Classes");
    const data = await app.waitFor(async () => {
      const d = await tableData(app);
      return d?.empty ? d : null;
    }, { message: "empty Device Classes table" });
    assert.deepEqual(data.headers.slice(0, 2), ["Name", "Selectors"]);
    await shots(app, "device-classes-empty");
  });
});

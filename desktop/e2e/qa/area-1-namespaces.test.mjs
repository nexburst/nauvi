// QA area 1 (#83): several namespaces at once (#66), as the admin user (#56).
// Checks: the admin context starts on All namespaces with nothing greyed
// out; picking demo and default in Pods shows the demo pods and hungry;
// dropping demo (its chip) leaves only hungry; the popover and chips render
// in WebKitGTK, in the dark and the light theme; the toolbar wraps with many
// chips in a narrow window; at most 10 namespaces can be picked.
//
// Only reads the cluster.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { kubectl } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import {
  closeNamespacePicker,
  namespaceChips,
  namespaceLabel,
  openNamespacePicker,
  pickNamespaces,
  tableData,
} from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 120_000 };

async function setTheme(app, label) {
  await (await app.find(By.css('header button[aria-label="Settings"]'))).click();
  const dialog = await app.find(byTestId("settings"));
  const radio = await dialog.findElement(By.xpath(`.//label[normalize-space()='${label}']/input`));
  await app.js("arguments[0].click()", radio);
  const value = label.toLowerCase();
  await app.waitFor(async () => (await app.js("return document.documentElement.dataset.theme ?? ''")) === value, {
    message: `data-theme=${value}`,
  });
  await (await dialog.findElement(By.xpath(".//button[normalize-space()='Close']"))).click();
  await app.driver.actions().sendKeys("").perform(); // Escape
  await app.waitFor(async () => (await app.driver.findElements(byTestId("settings"))).length === 0, {
    message: "Settings to close",
  });
}

describe("area 1: several namespaces at once", { timeout: 10 * 60_000 }, () => {
  const s = appSession("area-1-namespaces");

  it("the admin context starts on All namespaces with nothing greyed out", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.nav("Pods");
    await waitLive(app);
    assert.equal(await namespaceLabel(app), "All namespaces");
    const denied = await app.js(`return Array.from(document.querySelectorAll("nav button.denied"), (b) => b.textContent.trim())`);
    assert.deepEqual(denied, []);
  });

  it("demo + default shows the demo pods and hungry; dropping demo leaves hungry", T, async () => {
    const { app } = s;
    await pickNamespaces(app, ["demo", "default"]);
    await waitLive(app);
    assert.equal(await namespaceLabel(app), "2 namespaces");
    assert.deepEqual((await namespaceChips(app)).sort(), ["default", "demo"]);
    const want = kubectl(["get", "pods", "-n", "demo", "-o", "jsonpath={.items[*].metadata.name}"]).split(/\s+/);
    await app.waitFor(
      async () => {
        const rows = (await tableData(app)).rows;
        const nss = new Set(rows.map((r) => r.Namespace));
        return (
          rows.some((r) => r.Name === "hungry" && r.Namespace === "default") &&
          want.every((n) => rows.some((r) => r.Name === n && r.Namespace === "demo")) &&
          [...nss].every((n) => n === "demo" || n === "default")
        );
      },
      { message: "the demo pods and default/hungry, nothing else" },
    );
    await app.shot("demo-and-default");
    // The chip's × drops demo.
    await (await app.find(By.css('[aria-label="Selected namespaces"] button[aria-label="Remove demo"]'))).click();
    await app.waitFor(
      async () => {
        const rows = (await tableData(app)).rows;
        return rows.length > 0 && rows.every((r) => r.Namespace === "default") && rows.some((r) => r.Name === "hungry");
      },
      { message: "only default pods (hungry)" },
    );
    assert.equal(await namespaceLabel(app), "default");
    assert.deepEqual(await namespaceChips(app), []);
  });

  it("the popover and chips in the dark and light themes", T, async () => {
    const { app } = s;
    await pickNamespaces(app, ["demo", "default", "kube-system"]);
    for (const theme of ["Dark", "Light"]) {
      await setTheme(app, theme);
      await openNamespacePicker(app);
      await app.shot(`popover-${theme.toLowerCase()}`);
      const box = await app.js(`
        const p = document.querySelector('[aria-label="Namespaces"]').getBoundingClientRect();
        return { w: p.width, h: p.height, bg: getComputedStyle(document.querySelector('[aria-label="Namespaces"]')).backgroundColor };`);
      console.log(`${theme} popover: ${JSON.stringify(box)}`);
      assert.ok(box.w > 200 && box.h > 80, "the popover has a size");
      await closeNamespacePicker(app);
    }
    await setTheme(app, "Dark");
  });

  it("many chips wrap the toolbar in a narrow window; 10 at most", T, async () => {
    const { app } = s;
    const all = kubectl(["get", "ns", "-o", "jsonpath={.items[*].metadata.name}"]).split(/\s+/).sort();
    const many = all.slice(0, Math.min(all.length, 10));
    await resizeWindow(app, 900, 700);
    await pickNamespaces(app, many);
    const chips = await namespaceChips(app);
    assert.equal(chips.length, many.length);
    const layout = await app.js(`
      const tb = document.querySelector(".toolbar").getBoundingClientRect();
      const chips = Array.from(document.querySelectorAll('[aria-label="Selected namespaces"] li'), (c) => c.getBoundingClientRect());
      const tops = new Set(chips.map((c) => Math.round(c.top)));
      const filter = document.querySelector('input[aria-label="Filter"]').getBoundingClientRect();
      return { toolbarRight: tb.right, width: innerWidth, chipLines: tops.size,
               maxChipRight: Math.max(...chips.map((c) => c.right)), filterRight: filter.right,
               docScrollX: document.documentElement.scrollWidth > innerWidth };`);
    console.log(`layout: ${JSON.stringify(layout)}`);
    await app.shot("many-chips-narrow");
    assert.ok(layout.chipLines > 1, "the chips wrap onto several lines");
    assert.ok(layout.maxChipRight <= layout.width, "no chip is cut off on the right");
    assert.ok(layout.filterRight <= layout.width, "the filter box stays in the window");
    const create = await app.js(`
      const b = Array.from(document.querySelectorAll(".toolbar button")).find((b) => b.textContent.includes("Create"));
      const c = Array.from(document.querySelectorAll(".toolbar button")).find((b) => b.textContent.trim() === "Columns");
      return { create: b.getBoundingClientRect().height, columns: c.getBoundingClientRect().height };`);
    console.log(`button heights: ${JSON.stringify(create)}`);
    if (create.create > create.columns + 4) console.log("known issue #97: + Create wraps onto two lines");
    if (many.length === 10) {
      await openNamespacePicker(app);
      const disabled = await app.js(
        `return Array.from(document.querySelectorAll('[aria-label="Namespace list"] input:disabled')).length`,
      );
      const note = await app.js(`return document.querySelector('[aria-label="Namespaces"] .note')?.textContent ?? ""`);
      await app.shot("ten-namespaces-cap");
      assert.match(note, /At most 10 namespaces/);
      if (all.length > 10) assert.ok(disabled > 0, "the other namespaces are disabled");
      await closeNamespacePicker(app);
    }
    await pickNamespaces(app, []);
    await resizeWindow(app, 1600, 1000);
  });
});

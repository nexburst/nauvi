// #177: namespaces created after the app started reach the namespace control
// and the palette's `ns` search; deleted ones leave after Refresh.
// Checks: a namespace created with kubectl while the app runs is offered when
// the picker opens and found by `ns <name>` in the palette (and picking it
// shows only it); after it is deleted, Refresh drops it from the picker.
//
// Creates and deletes its own temporary namespace.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { closeNamespacePicker, namespaceLabel, namespaceOptions, openNamespacePicker } from "../lib/table.mjs";

const T = { timeout: 180_000 };

function nsExists(name) {
  try {
    kubectl(["get", "namespace", name, "-o", "name"]);
    return true;
  } catch {
    return false;
  }
}

describe("namespaces created while the app runs (#177)", { timeout: 10 * 60_000 }, () => {
  const s = appSession("namespaces-live");
  let ns = "";

  it("a namespace created after the start is offered in the picker", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.nav("Pods");
    await waitLive(app);
    // The list the app started with.
    await openNamespacePicker(app);
    const before = await namespaceOptions(app);
    await closeNamespacePicker(app);

    ns = tempNamespace("qa177");
    assert.ok(!before.includes(ns), "the new namespace was not listed at the start");
    await app.waitFor(
      async () => {
        await openNamespacePicker(app);
        const found = (await namespaceOptions(app)).includes(ns);
        if (!found) await closeNamespacePicker(app);
        return found;
      },
      { timeout: 30_000, message: `${ns} in the namespace picker` },
    );
    await app.shot("picker-lists-new-namespace");
    await closeNamespacePicker(app);
  });

  it("the palette's ns search finds it, and picking it shows only it", T, async () => {
    const { app } = s;
    await app.js("document.activeElement?.blur()");
    await app.driver.actions().keyDown(Key.CONTROL).sendKeys("k").keyUp(Key.CONTROL).perform();
    const dialog = await app.find(byTestId("command-palette"));
    const input = await dialog.findElement(By.css('input[role="combobox"]'));
    await input.sendKeys(`ns ${ns}`);
    await app.waitFor(
      async () =>
        (await app.js(`return document.querySelector('[data-testid="command-palette"] [role="option"]')?.textContent ?? ""`)).includes(ns),
      { timeout: 30_000, message: `palette option ${ns}` },
    );
    // Let WebKitGTK paint the results before the screenshot (it showed an
    // earlier frame without this).
    await app.driver.executeAsyncScript(
      "const done = arguments[0]; requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 500)));",
    );
    await app.shot("palette-finds-new-namespace");
    await input.sendKeys(Key.ENTER);
    await app.waitFor(async () => (await namespaceLabel(app)) === ns, { message: `the namespace control shows ${ns}` });
  });

  it("after it is deleted, Refresh drops it from the picker", T, async () => {
    const { app } = s;
    // Back to all namespaces first, so the picked one does not linger as selected.
    await openNamespacePicker(app);
    await app.js(`
      const all = document.querySelector('[aria-label="Namespaces"] .option.all input');
      if (!all.checked) all.click();
    `);
    await closeNamespacePicker(app);
    deleteNamespace(ns);
    const deadline = Date.now() + 120_000;
    while (nsExists(ns) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000));
    if (nsExists(ns)) {
      console.log(`${ns} is still terminating after 120 s; not checking that it leaves the picker`);
      return;
    }
    await (await app.find(By.xpath("//header//button[normalize-space()='Refresh']"))).click();
    await app.waitFor(
      async () => {
        await openNamespacePicker(app);
        const gone = !(await namespaceOptions(app)).includes(ns);
        await closeNamespacePicker(app);
        return gone;
      },
      { timeout: 30_000, message: `${ns} gone from the namespace picker` },
    );
    ns = "";
  });

  after(() => deleteNamespace(ns));
});

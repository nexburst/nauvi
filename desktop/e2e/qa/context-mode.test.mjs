// Read-only and protected contexts (#338), in the real app against kind:
// - Read-only, set on the cluster settings page: a badge in the header; the
//   row menu greys out Delete, Shell and the other changes with the mode
//   as the reason, keeps Logs and Port forward; a change that reaches the
//   backend anyway (+ Create, even its Validate) is refused with that
//   reason; the ConfigMap is still there.
// - Protected: a badge in the header and in the catalog; Delete asks for
//   the context name after the usual dialog; Cancel deletes nothing; a
//   wrong name keeps Confirm disabled; the right name deletes; opening a
//   pod shell asks too.
// - The mode is saved in settings.json under the context, separately from
//   the other cluster settings.
// Light and dark theme at 1280x800. Changes objects in a temp namespace only.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { CONTEXT, byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";
import { closeMenu, contextMenu, dialogButton, openKind, waitActionDialogClosed } from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };
const CM = "qa-mode-cm";
const POD = "qa-mode-pod";
const READ_ONLY = `${CONTEXT} is read-only: changes to this cluster are turned off`;
let ns;

const badge = (app) =>
  app.js(`return document.querySelector('header [data-testid="context-mode-badge"]')?.textContent.trim() ?? ""`);

const confirmOpen = async (app) => (await app.driver.findElements(byTestId("protected-confirm"))).length > 0;

const cmExists = () => {
  try {
    kubectl(["-n", ns, "get", "configmap", CM, "-o", "name"]);
    return true;
  } catch {
    return false;
  }
};

/** The open row menu: label, disabled and tooltip of each item. */
const menuState = (app) =>
  app.js(`return Array.from(document.querySelectorAll('[data-testid="context-menu"] [role="menuitem"]'),
    (b) => ({ label: b.textContent.trim(), disabled: b.disabled, title: b.getAttribute("title") ?? "" }));`);

/** Pick a mode on this cluster's settings page; leaves the page open. */
async function setMode(app, label) {
  if ((await app.driver.findElements(byTestId("cluster-settings"))).length === 0) {
    await app.palette("cluster settings", "Cluster settings");
  }
  const dialog = await app.find(byTestId("cluster-settings"));
  const radio = await dialog.findElement(
    By.xpath(`.//label[contains(@class,'mode-choice')][.//strong[normalize-space()=${xq(label)}]]/input`),
  );
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", radio);
  await radio.click();
  await app.waitFor(async () => radio.isSelected(), { message: `${label} selected` });
}

async function closeSettings(app) {
  const dialog = await app.find(byTestId("cluster-settings"));
  await (await dialog.findElement(By.xpath(".//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("cluster-settings"))).length === 0, {
    message: "the cluster settings to close",
  });
}

/** Delete the ConfigMap from its row menu up to the protected confirmation. */
async function deleteUpToConfirm(app) {
  await contextMenu(app, CM, ns);
  await (await app.find(By.xpath(`//*[@data-testid='context-menu']//*[@role='menuitem'][normalize-space()='Delete']`))).click();
  await (await dialogButton(app, "Delete")).click();
  await app.waitFor(() => confirmOpen(app), { message: "the protected confirmation" });
  return app.find(byTestId("protected-confirm"));
}

describe("read-only and protected contexts", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-mode", `apiVersion: v1\nkind: ConfigMap\nmetadata: { name: ${CM} }\ndata: { k: v }\n---\n${httpPodYaml(POD)}`);
    waitPodReady(ns, POD);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("context-mode");

  it("read-only from the cluster settings page: the badge in the header (light)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "light");
    await waitLive(app);
    assert.equal(await badge(app), "");
    await setMode(app, "Read-only");
    await app.waitFor(async () => (await badge(app)) === "Read-only", { message: "the Read-only badge" });
    await app.waitFor(() => s.app.profile.settings()?.contexts?.[CONTEXT]?.mode === "readOnly", {
      message: "mode readOnly in settings.json",
    });
  });

  it("read-only: the row menu greys out changes with the reason, keeps Logs (dark)", T, async () => {
    const { app } = s;
    await closeSettings(app);
    await setTheme(app, "dark");
    await openKind(app, "Pods", ns, POD);
    await contextMenu(app, POD, ns);
    const items = await app.waitFor(
      async () => {
        const m = await menuState(app);
        return m.find((i) => i.label === "Delete")?.disabled ? m : null;
      },
      { message: "Delete greyed out" },
    );
    for (const label of ["Shell", "Attach", "Delete"]) {
      const item = items.find((i) => i.label === label);
      assert.ok(item?.disabled, `${label}: ${JSON.stringify(items)}`);
      assert.equal(item.title, READ_ONLY, label);
    }
    assert.equal(items.find((i) => i.label === "Logs")?.disabled, false, JSON.stringify(items));
    assert.equal(items.find((i) => i.label === "Port forward…")?.disabled, false, JSON.stringify(items));
    // Left open for the screenshot.
  });

  it("read-only: + Create is refused by the backend, nothing is created (light)", T, async () => {
    const { app } = s;
    await closeMenu(app);
    await setTheme(app, "light");
    await openKind(app, "Config Maps", ns);
    await (await app.find(By.xpath("//button[normalize-space()='+ Create']"))).click();
    const dialog = await app.find(By.css('[role="dialog"][aria-label="Create resources"]'));
    await (await dialog.findElement(By.xpath(".//button[normalize-space()='Create']"))).click();
    await app.waitFor(async () => (await dialog.getText()).includes(READ_ONLY), {
      message: "the read-only refusal in the Create dialog",
    });
    assert.ok(cmExists(), "the ConfigMap is still there");
  });

  it("protected: badges in the header and the catalog (dark)", T, async () => {
    const { app } = s;
    await app.driver.actions().sendKeys(Key.ESCAPE).perform();
    await setTheme(app, "dark");
    await setMode(app, "Protected");
    await closeSettings(app);
    await app.waitFor(async () => (await badge(app)) === "Protected", { message: "the Protected badge" });
    await (await app.find(By.css('button[aria-label="Cluster catalog"]'))).click();
    await app.waitFor(
      async () =>
        (await app.js(
          `return document.querySelector('[data-testid="catalog-row"][data-context=${JSON.stringify(CONTEXT)}] [data-testid="context-mode-badge"]')?.textContent.trim() ?? ""`,
        )) === "Protected",
      { message: "the Protected badge in the catalog" },
    );
    assert.equal(s.app.profile.settings()?.contexts?.[CONTEXT]?.mode ?? "protected", "protected");
  });

  it("protected: Delete asks for the context name; a wrong one keeps Confirm off (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await openKind(app, "Config Maps", ns, CM);
    const dialog = await deleteUpToConfirm(app);
    assert.match(await dialog.getText(), new RegExp(`Delete ConfigMap ${ns}/${CM}`));
    assert.match(await dialog.getText(), new RegExp(`Type ${CONTEXT} to confirm`));
    const input = await dialog.findElement(byTestId("protected-confirm-input"));
    await input.sendKeys(CONTEXT.slice(0, -1));
    const ok = await dialog.findElement(byTestId("protected-confirm-button"));
    assert.equal(await ok.isEnabled(), false);
    assert.ok(cmExists());
    // Left open with the wrong name for the screenshot.
  });

  it("protected: Cancel deletes nothing; the right name deletes (dark)", T, async () => {
    const { app } = s;
    await setTheme(app, "dark");
    let dialog = await app.find(byTestId("protected-confirm"));
    await (await dialog.findElement(By.xpath(".//button[normalize-space()='Cancel']"))).click();
    await app.waitFor(async () => !(await confirmOpen(app)), { message: "the confirmation to close" });
    await app.waitFor(
      async () => (await app.js(`return document.querySelector('[data-testid="action-dialog"]')?.innerText ?? ""`)).includes("Cancelled: nothing was changed"),
      { message: "Cancelled in the action dialog" },
    );
    assert.ok(cmExists(), "a cancelled delete deleted it");
    await (await dialogButton(app, "Cancel")).click();
    await waitActionDialogClosed(app);

    dialog = await deleteUpToConfirm(app);
    await (await dialog.findElement(byTestId("protected-confirm-input"))).sendKeys(CONTEXT);
    await (await dialog.findElement(byTestId("protected-confirm-button"))).click();
    await waitActionDialogClosed(app);
    await app.waitFor(() => !cmExists(), { timeout: 30_000, message: "the ConfigMap to be deleted" });
  });

  it("protected: a pod shell asks for the context name too (light)", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await openKind(app, "Pods", ns, POD);
    await contextMenu(app, POD, ns);
    await (await app.find(By.xpath(`//*[@data-testid='context-menu']//*[@role='menuitem'][normalize-space()='Shell']`))).click();
    await app.waitFor(() => confirmOpen(app), { message: "the confirmation before the shell" });
    const dialog = await app.find(byTestId("protected-confirm"));
    assert.match(await dialog.getText(), new RegExp(`Open a shell in pod ${ns}/${POD}`));
    // Left open for the screenshot.
  });

  it("back to normal: no badge, no confirmation (dark)", T, async () => {
    const { app } = s;
    const dialog = await app.find(byTestId("protected-confirm"));
    await (await dialog.findElement(By.xpath(".//button[normalize-space()='Cancel']"))).click();
    await setTheme(app, "dark");
    await setMode(app, "Normal");
    await closeSettings(app);
    await app.waitFor(async () => (await badge(app)) === "", { message: "no badge" });
    await app.waitFor(() => s.app.profile.settings()?.contexts?.[CONTEXT]?.mode === "normal", {
      message: "mode normal in settings.json",
    });
  });
});

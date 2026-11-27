// Confirm dialogs from the keyboard, and the k9s keys (#575), in WebKitGTK
// against kind, at 1280x800 in the dark and the light theme. Three pods in
// a temp namespace:
// - j Space j Space Ctrl+D opens "Delete 2 Pods" with the focus on its
//   Delete button; Tab and ←/→ stay between Cancel and Delete; Escape
//   cancels (both pods stay)
// - the same keys and Enter delete both pods, and the table has the
//   keyboard again
// - on a protected cluster Ctrl+D, Enter stops at the type-the-name field:
//   Enter again changes nothing, the pod stays
// - Settings → Keyboard → k9s keys: then Ctrl+K opens Force delete with its
//   name field focused, and ? lists Ctrl+K and Shift+L
// - Shift+N sorts by name
// - #580: the force delete's "Type … to confirm" is one line, no key in ?
//   runs into its description, and `:` opens the palette from the table but
//   not from a header button

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { CONTEXT, byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";
import { actionDialogText, noticeText, openKind, waitActionDialogClosed } from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };
const PODS = ["qa-k9s-a", "qa-k9s-b", "qa-k9s-c"];
let ns = "";

const podYaml = (name) => `apiVersion: v1
kind: Pod
metadata: { name: ${name}, labels: { app: qa-k9s } }
spec:
  terminationGracePeriodSeconds: 0
  containers: [{ name: main, image: "busybox:1.36", imagePullPolicy: IfNotPresent, command: ["sh", "-c", "sleep 3600"] }]
`;

const press = (app, ...keys) => app.driver.actions().sendKeys(...keys).perform();
const ctrl = (app, key) => app.driver.actions().keyDown(Key.CONTROL).sendKeys(key).keyUp(Key.CONTROL).perform();
const shift = (app, key) => app.driver.actions().keyDown(Key.SHIFT).sendKeys(key).keyUp(Key.SHIFT).perform();
const count = (app, css) => app.js(`return document.querySelectorAll(arguments[0]).length`, css);
/** What has the keyboard focus: its test id, or its tag and text. */
const focused = (app) =>
  app.js(`const a = document.activeElement;
    return a?.getAttribute("data-testid") || (a ? a.tagName.toLowerCase() + ":" + (a.textContent ?? "").trim() : "");`);
const podExists = (name) => {
  try {
    const out = kubectl(["-n", ns, "get", "pod", name, "-o", "jsonpath={.metadata.deletionTimestamp}"]);
    return out.trim() === "";
  } catch {
    return false;
  }
};

async function bothThemes(app, label) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await app.js("return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

/** The Pods table of the temp namespace, with the keyboard on its grid. */
async function podsTable(app) {
  await openKind(app, "Pods", ns);
  await app.waitFor(async () => (await count(app, '[data-testid="resource-row"]')) > 0, { message: "pod rows" });
  await app.js(`document.querySelector('[role="grid"]').focus()`);
}

/** Pick a mode on this cluster's settings page, then close it. */
async function setMode(app, label) {
  await app.palette("cluster settings", "Cluster settings");
  const dialog = await app.find(byTestId("cluster-settings"));
  const radio = await dialog.findElement(
    By.xpath(`.//label[contains(@class,'mode-choice')][.//strong[normalize-space()=${xq(label)}]]/input`),
  );
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", radio);
  await radio.click();
  await app.waitFor(async () => radio.isSelected(), { message: `${label} selected` });
  await (await dialog.findElement(By.xpath(".//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await count(app, '[data-testid="cluster-settings"]')) === 0, {
    message: "the cluster settings to close",
  });
}

describe("k9s keys and keyboard confirm dialogs", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-k9s", PODS.map(podYaml).join("---\n"));
    for (const p of PODS) waitPodReady(ns, p);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("k9s-keys");

  it("j Space j Space Ctrl+D: the dialog's Delete has the focus; Tab and arrows stay in it; Escape cancels", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await podsTable(app);
    await press(app, "j", " ", "j", " ");
    await app.waitFor(async () => (await count(app, '[data-testid="resource-row"] input[type="checkbox"]:checked')) === 2, {
      message: "two rows selected",
    });
    await ctrl(app, "d");
    const text = await app.waitFor(() => actionDialogText(app), { message: "the delete dialog" });
    console.log(`dialog: ${text}`);
    assert.match(text, /Delete 2 Pods/);
    await app.waitFor(async () => (await focused(app)) === "action-confirm", { message: "Delete focused" });
    await bothThemes(app, "delete-2-focused");
    await press(app, Key.TAB);
    assert.equal(await focused(app), "button:Cancel", "Tab goes to Cancel");
    await press(app, Key.TAB);
    assert.equal(await focused(app), "action-confirm", "and round to Delete");
    await press(app, Key.ARROW_LEFT);
    assert.equal(await focused(app), "button:Cancel", "← goes to Cancel");
    await app.shot("cancel-focused");
    await press(app, Key.ARROW_RIGHT);
    assert.equal(await focused(app), "action-confirm", "→ back to Delete");
    await press(app, Key.ESCAPE);
    await waitActionDialogClosed(app);
    for (const p of PODS) assert.ok(podExists(p), `${p} is still there`);
  });

  it("Ctrl+D, Enter deletes both pods; the table has the keyboard again", T, async () => {
    const { app } = s;
    await ctrl(app, "d");
    await app.waitFor(async () => (await focused(app)) === "action-confirm", { message: "Delete focused" });
    await press(app, Key.ENTER);
    await waitActionDialogClosed(app);
    const notice = await app.waitFor(
      async () => {
        const t = await noticeText(app);
        return /Deleted 2 pods/.test(t) ? t : null;
      },
      { message: "the Deleted notice" },
    );
    console.log(`notice: ${notice}`);
    await app.waitFor(async () => PODS.filter(podExists).length === 1, { timeout: 60_000, message: "two pods deleted" });
    console.log(`left: ${PODS.filter(podExists)}`);
    assert.equal(await app.js(`return document.activeElement?.getAttribute("role")`), "grid", "focus back on the table");
    await app.waitFor(async () => (await count(app, '[data-testid="resource-row"]')) === 1, { message: "one row left" });
    await bothThemes(app, "deleted");
  });

  it("protected: Ctrl+D, Enter stops at the type-the-name field; Enter again changes nothing", T, async () => {
    const { app } = s;
    const left = PODS.filter(podExists)[0];
    await setMode(app, "Protected");
    await podsTable(app);
    await press(app, "j");
    await ctrl(app, "d");
    await app.waitFor(async () => (await focused(app)) === "action-confirm", { message: "Delete focused" });
    await press(app, Key.ENTER);
    await app.waitFor(async () => (await focused(app)) === "protected-confirm-input", {
      message: "the context name field focused",
    });
    await press(app, Key.ENTER);
    await press(app, Key.ENTER);
    assert.equal(await count(app, '[data-testid="protected-confirm"]'), 1, "the prompt stays");
    const prompt = await app.js(`return document.querySelector('[data-testid="protected-confirm"]').innerText`);
    assert.ok(prompt.includes(`Type ${CONTEXT} to confirm`), prompt);
    await bothThemes(app, "protected-prompt");
    await press(app, Key.ESCAPE);
    await app.waitFor(async () => (await count(app, '[data-testid="protected-confirm"]')) === 0, { message: "prompt closed" });
    await app.waitFor(async () => /Cancelled: nothing was changed/.test((await actionDialogText(app)) ?? ""), {
      message: "the cancelled note",
    });
    await press(app, Key.ESCAPE);
    await waitActionDialogClosed(app);
    assert.ok(podExists(left), `${left} is still there`);
    await setMode(app, "Normal");
  });

  it("Settings → Keyboard → k9s keys: Ctrl+K opens Force delete; ? lists it", T, async () => {
    const { app } = s;
    await ctrl(app, ",");
    const settings = await app.find(byTestId("settings"));
    await (await settings.findElement(By.xpath(".//button[@role='tab'][normalize-space()='Keyboard']"))).click();
    const box = await app.find(byTestId("k9s-keys"));
    await box.click();
    await app.waitFor(() => s.app.profile.settings()?.k9s_keys === true, { message: "k9s_keys saved" });
    await bothThemes(app, "settings-keyboard");
    await press(app, Key.ESCAPE);
    await app.waitFor(async () => (await count(app, '[data-testid="settings"]')) === 0, { message: "settings closed" });

    await podsTable(app);
    await press(app, "j");
    await ctrl(app, "k");
    const text = await app.waitFor(() => actionDialogText(app), { message: "the force delete dialog" });
    assert.match(text, /Force delete Pod/);
    assert.equal(await count(app, '[role="dialog"][aria-label="Command palette"]'), 0, "no palette");
    assert.equal(await app.js(`return document.activeElement?.tagName`), "INPUT", "the name field has the focus");
    const label = await app.js(`const s = document.querySelector('[data-testid="action-dialog"] label.field > span');
      const r = s.getBoundingClientRect();
      return { text: s.textContent.trim(), height: r.height };`);
    console.log(`confirm label: ${JSON.stringify(label)}`);
    assert.match(label.text, /^Type qa-k9s-\w to confirm$/);
    assert.ok(label.height < 24, `the label is one line (${label.height}px)`);
    await bothThemes(app, "force-delete");
    await press(app, Key.ESCAPE);
    await waitActionDialogClosed(app);

    await app.js(`document.querySelector('[role="grid"]').focus()`);
    await press(app, "?");
    const help = await app.find(byTestId("shortcut-help"));
    const helpText = await app.js("return arguments[0].innerText", help);
    assert.match(helpText, /Kill: force delete/);
    assert.match(helpText, /previous run/);
    assert.match(helpText, /k9s keys are on/);
    const overlaps = await app.js(`const out = [];
      for (const dt of arguments[0].querySelectorAll("dt")) {
        const left = dt.nextElementSibling.getBoundingClientRect().left;
        for (const k of dt.querySelectorAll("kbd, .or"))
          if (k.getBoundingClientRect().right > left + 0.5) out.push(k.textContent + " / " + dt.nextElementSibling.textContent);
      }
      return out;`, help);
    assert.deepEqual(overlaps, [], "no key runs into its description");
    await bothThemes(app, "help");
    await press(app, Key.ESCAPE);
  });

  it(": opens the palette from the table, not from a header button", T, async () => {
    const { app } = s;
    await podsTable(app);
    // A button outside the table: the first visible one of the header.
    const button = await app.js(`const b = [...document.querySelectorAll("header button")].find((b) => b.offsetParent !== null);
      b.focus();
      return document.activeElement === b ? (b.getAttribute("aria-label") || b.textContent.trim()) : "";`);
    console.log(`focused button: ${button}`);
    assert.ok(button, "a header button has the focus");
    await press(app, ":");
    await app.js("return new Promise((r) => setTimeout(r, 300))");
    assert.equal(await count(app, '[role="dialog"][aria-label="Command palette"]'), 0, "no palette from a button");
    await app.js(`document.querySelector('[role="grid"]').focus()`);
    await press(app, ":");
    await app.waitFor(async () => (await count(app, '[role="dialog"][aria-label="Command palette"]')) === 1, {
      message: "the palette from the table",
    });
    assert.equal(await app.js(`return document.activeElement?.value`), ":");
    await app.shot("command-mode");
    await press(app, Key.ESCAPE);
  });

  it("Shift+N sorts by name, again the other way", T, async () => {
    const { app } = s;
    await podsTable(app);
    const sort = () => app.js(`return document.querySelector('[role="columnheader"][title="Name"]')?.getAttribute("aria-sort")`);
    const before = await sort();
    await shift(app, "N");
    const first = await app.waitFor(
      async () => {
        const v = await sort();
        return v && v !== "none" ? v : null;
      },
      { message: "sorted by name" },
    );
    await shift(app, "N");
    await app.waitFor(
      async () => {
        const v = await sort();
        return v !== first && v !== "none";
      },
      { message: "the other way" },
    );
    console.log(`name sort: ${before} -> ${first} -> ${await sort()}`);
  });
});

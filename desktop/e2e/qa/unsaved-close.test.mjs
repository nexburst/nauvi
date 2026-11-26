// #173: closing the window (the title bar's close button, Cmd+W, the window
// manager) with an unsaved YAML edit asks "Discard changes?" instead of
// quitting at once. Linux only (WM_DELETE_WINDOW through lib/wm-close.py);
// Cmd+Q and the Dock's Quit are macOS-only and checked by hand.
// - unsaved edit + close: the dialog shows (dark and light), the app keeps
//   running; Keep editing keeps the edit
// - close again + Discard changes: the app exits, the object is unchanged
// - nothing unsaved: closing quits at once, as before

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { appPid } from "../lib/dock.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { cannotCloseLikeUser, closeLikeUser } from "../lib/window.mjs";
import { answerDiscard, discardDialog, editor, editorValue, openKind, setEditorValue, setTheme, waitDiscardDialog } from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIXTURE = `
apiVersion: v1
kind: ConfigMap
metadata: { name: qa173-cm }
data:
  greeting: hello
`;

let ns;
const panel = (app) => app.find(byTestId("detail-panel"));
const greeting = () => kubectl(["-n", ns, "get", "cm", "qa173-cm", "-o", "jsonpath={.data.greeting}"]);

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function openYaml(app) {
  await openKind(app, "Config Maps", ns, "qa173-cm");
  await app.clickRow("qa173-cm", ns);
  await app.waitFor(async () => (await (await panel(app)).getText()).includes(`${ns}/qa173-cm`), { message: "the panel" });
  const p = await panel(app);
  await (await p.findElement(By.xpath(`.//button[@role='tab'][normalize-space()='YAML']`))).click();
  const el = await editor(app, "yaml-editor");
  await app.waitFor(async () => (await editorValue(app, el)).includes("greeting: hello"), { message: "the YAML" });
  return el;
}

async function editUnsaved(app) {
  const el = await openYaml(app);
  await setEditorValue(app, el, (await editorValue(app, el)).replace("greeting: hello", "greeting: hello-unsaved"));
  await app.waitFor(() => app.js("return !!document.querySelector('[data-testid=\"detail-panel\"] h3 .dirty')"), {
    message: "the unsaved dot",
  });
}

describe("#173: closing the window with unsaved edits", { timeout: 10 * 60_000, skip: cannotCloseLikeUser() }, () => {
  before(() => {
    ns = tempNamespace("qa173", FIXTURE);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("unsaved-close");

  it("closing with an unsaved edit asks, and Keep editing keeps the window and the edit", T, async () => {
    const { app } = s;
    await waitLive(app);
    await editUnsaved(app);
    const pid = appPid(app.profile.home);
    closeLikeUser(pid);
    const dialog = await waitDiscardDialog(app);
    console.log(`dialog: ${await dialog.getText()}`);
    await setTheme(app, "dark");
    await app.shot("close-dialog-dark");
    await setTheme(app, "light");
    await app.shot("close-dialog-light");
    await setTheme(app, null);
    assert.ok(isRunning(pid), "the app is still running");
    await answerDiscard(app, "Keep editing");
    await sleep(1000);
    assert.ok(isRunning(pid), "the app is still running after Keep editing");
    assert.ok((await editorValue(app, await editor(app, "yaml-editor"))).includes("hello-unsaved"), "the edit is kept");
  });

  it("closing again and discarding quits, and the object is unchanged", T, async () => {
    const { app } = s;
    const pid = appPid(app.profile.home);
    closeLikeUser(pid);
    await answerDiscard(app, "Discard changes").catch(() => {
      // The window may already be gone by the time the dialog would close.
    });
    await app.waitFor(() => !isRunning(pid), { timeout: 15_000, message: "the app to exit" });
    assert.equal(greeting(), "hello");
    await app.restart({ wait: 0 });
    await waitLive(app);
  });

  it("closing with nothing unsaved quits at once", T, async () => {
    const { app } = s;
    await openYaml(app);
    assert.equal(await discardDialog(app), null);
    const pid = appPid(app.profile.home);
    closeLikeUser(pid);
    await app.waitFor(() => !isRunning(pid), { timeout: 15_000, message: "the app to exit" });
    await app.restart({ wait: 0 });
    await waitLive(app);
  });
});

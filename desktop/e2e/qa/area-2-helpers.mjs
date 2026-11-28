// Small helpers shared by the area-2 scenarios (actions, YAML editor,
// create). Not a scenario itself: qa.sh only runs *.test.mjs.

import { By, Key } from "selenium-webdriver";
import { byTestId, xq } from "../lib/app.mjs";
import { namespaceLabel } from "../lib/table.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Show only `namespace` in the tables (the namespace picker). */
export async function pickNamespace(app, namespace) {
  const trigger = await app.find(By.css('button[aria-label="Namespace"]'));
  // textContent, not getText(): WebKitWebDriver reads the ellipsis-cut
  // button (overflow: hidden, #384) as having no visible text.
  if ((await namespaceLabel(app)) === namespace) return;
  await trigger.click();
  const pop = await app.find(By.css('[role="dialog"][aria-label="Namespaces"]'));
  await app.setValue(await pop.findElement(By.css('input[aria-label="Search namespaces"]')), namespace);
  // Clear whatever else is selected, then tick ours.
  const option = await app.find(By.xpath(`//*[@aria-label='Namespace list']//label[normalize-space()=${xq(namespace)}]/input`));
  if (!(await option.isSelected())) await option.click();
  await app.driver.actions().sendKeys(Key.ESCAPE).perform();
  await app.waitFor(async () => (await namespaceLabel(app)) === namespace, {
    message: `namespace picker on ${namespace} (says "${await namespaceLabel(app)}")`,
  });
}

/** Open a kind, show one namespace and filter to `text`. */
export async function openKind(app, label, namespace, text = "") {
  await app.nav(label);
  if (namespace) await pickNamespace(app, namespace);
  await app.filter(text);
}

/** Right-click a row; returns the menu's title and item labels. */
export async function contextMenu(app, name, namespace) {
  // The row can be re-rendered (a filter or watch update) between finding it
  // and the click, which then goes nowhere: try again a few times.
  for (let attempt = 1; ; attempt++) {
    const row = await app.find(app.row(name, namespace));
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", row);
    await app.driver.actions().contextClick(row).perform();
    try {
      await app.find(byTestId("context-menu"), { timeout: 4000 });
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
    }
  }
  return app.js(
    `const m = document.querySelector('[data-testid="context-menu"]');
     return { title: m.querySelector('.title')?.textContent.trim() ?? "",
              items: Array.from(m.querySelectorAll('[role="menuitem"]'), (b) => b.textContent.trim()) };`,
  );
}

/** Click an item of the open context menu. */
export async function menuItem(app, label) {
  await (await app.find(By.xpath(`//*[@data-testid='context-menu']//*[@role='menuitem'][normalize-space()=${xq(label)}]`))).click();
}

export async function closeMenu(app) {
  await app.driver.actions().sendKeys(Key.ESCAPE).perform();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("context-menu"))).length === 0, {
    message: "the context menu to close",
  });
}

/** Labels of the detail panel's action buttons. */
export function actionBarLabels(app) {
  return app.js(
    `return Array.from(document.querySelectorAll('[data-testid="detail-panel"] [role="toolbar"][aria-label="Actions"] button'),
       (b) => b.getAttribute("aria-label") || b.textContent.trim());`,
  );
}

/** innerText of the open action dialog, or null. */
export function actionDialogText(app) {
  return app.js(`return document.querySelector('[data-testid="action-dialog"]')?.innerText ?? null`);
}

export async function waitActionDialogClosed(app, timeout = 20_000) {
  await app.waitFor(async () => (await app.driver.findElements(byTestId("action-dialog"))).length === 0, {
    timeout,
    message: "the action dialog to close",
  });
}

/** A button of the open action dialog, by its text. */
export function dialogButton(app, label) {
  return app.find(By.xpath(`//*[@data-testid='action-dialog']//button[normalize-space()=${xq(label)}]`));
}

/** The text of the cell in `column` of the row named `name`. */
export function cell(app, name, column) {
  return app.js(
    `const heads = Array.from(document.querySelectorAll('[data-testid="resource-table"] [role="columnheader"]'),
       (h) => h.textContent.replace(/[▲▼]/g, "").trim());
     const i = heads.indexOf(arguments[1]);
     if (i < 0) return null;
     for (const r of document.querySelectorAll('[data-testid="resource-row"]')) {
       const c = r.querySelectorAll('[role="gridcell"]');
       if (c[1]?.textContent.trim() === arguments[0]) return c[i]?.textContent.trim() ?? null;
     }
     return null;`,
    name,
    column,
  );
}

/** The notice bar's text (ActionNotice), or "". */
export function noticeText(app) {
  return app.js(
    `return Array.from(document.querySelectorAll('[role="status"], [role="alert"]'), (e) => e.innerText.trim()).join(" | ")`,
  );
}

/** The CodeMirror editor with this test id, once loaded; returns its root element. */
export async function editor(app, testid, timeout = 20_000) {
  return app.waitFor(
    async () => {
      const el = await app.driver.findElement(byTestId(testid));
      return (await el.getAttribute("data-ready")) === "true" && (await app.js("return !!arguments[0].nauviEditor", el))
        ? el
        : null;
    },
    { timeout, message: `the ${testid} editor to load` },
  );
}

export const editorValue = (app, el) => app.js("return arguments[0].nauviEditor.getValue()", el);
export const setEditorValue = (app, el, text) => app.js("arguments[0].nauviEditor.setValue(arguments[1])", el, text);

/**
 * Real key presses into CodeMirror, one WebDriver call per key so the
 * webview gets them in order. `keys` is an array of strings / Key values,
 * or `{ shift: key }` for a key with Shift held.
 */
export async function typeKeys(app, keys) {
  for (const k of keys) {
    if (typeof k === "object") await app.driver.actions().keyDown(Key.SHIFT).sendKeys(k.shift).keyUp(Key.SHIFT).perform();
    else await app.driver.actions().sendKeys(k).perform();
    await sleep(30);
  }
}

/** Click the editor line containing `text`, then End: the cursor ends that line. */
export async function cursorAtEndOf(app, el, text) {
  const line = await app.waitFor(
    () =>
      app.js(
        `return Array.from(arguments[0].querySelectorAll('.cm-line')).find((l) => l.textContent.includes(arguments[1])) ?? null`,
        el,
        text,
      ),
    { message: `an editor line with "${text}"` },
  );
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", line);
  await line.click();
  await app.driver.actions().sendKeys(Key.END).perform();
}

/** The editor's line texts as rendered (CodeMirror only renders what is in view). */
export function renderedLines(app, el) {
  return app.js(`return Array.from(arguments[0].querySelectorAll('.cm-line'), (l) => l.textContent)`, el);
}

/** The open "Discard changes?" dialog, or null. */
export async function discardDialog(app) {
  const found = await app.driver.findElements(By.css('[role="alertdialog"][aria-label="Discard changes?"]'));
  return found[0] ?? null;
}

export async function waitDiscardDialog(app) {
  return app.waitFor(() => discardDialog(app), { message: 'the "Discard changes?" dialog' });
}

export async function answerDiscard(app, label) {
  const dialog = await waitDiscardDialog(app);
  await (await dialog.findElement(By.xpath(`.//button[normalize-space()=${xq(label)}]`))).click();
  await app.waitFor(async () => !(await discardDialog(app)), { message: "the discard dialog to close" });
}

// Switch the page to the light or dark theme and wait until it shows (#276).
export { setTheme } from "../lib/theme.mjs";

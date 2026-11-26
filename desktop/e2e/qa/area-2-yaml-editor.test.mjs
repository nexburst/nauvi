// Area 2 of #83, PR #58 (YAML editor), in the real WebKitGTK webview with
// real key presses where the check is about the keyboard:
// - the editor chunk loads lazily, when the YAML tab first opens
// - typing, Tab / Shift-Tab indenting, Enter auto-indent
// - Ctrl+F opens CodeMirror's search panel; find and replace work
// - folding from the gutter; bracket matching
// - Review: unified and side-by-side diffs render and scroll; Save works
// - a write from kubectl meanwhile: to another key, the edit is re-applied
//   on the latest version (#495); to the same key, the conflict and Reload,
//   or Compare with the latest and an explicit Save
// - "Discard changes?" on closing the panel, another kind, another row and
//   another context (the app gets two contexts on the same cluster)
// - a locked Secret can't be typed into; after Reveal it can
// - screenshots of the editor, the diff and the dialog in both themes

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId, CONTEXT } from "../lib/app.mjs";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import {
  answerDiscard,
  cursorAtEndOf,
  discardDialog,
  editor,
  editorValue,
  openKind,
  setEditorValue,
  setTheme,
  typeKeys,
  waitDiscardDialog,
} from "./area-2-helpers.mjs";

const T = { timeout: 180_000 };

/** The editor background is light or dark with the theme, and the cursor
 *  (CodeMirror draws it; the native caret is transparent) and the active
 *  line number contrast with it (#98). */
async function assertEditorReadable(app, theme) {
  const c = await app.js(`
    const q = (sel) => getComputedStyle(document.querySelector('[data-testid="detail-panel"] ' + sel));
    const rgb = (s) => (s.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
    const bg = q('.cm-editor').backgroundColor;
    const active = q('.cm-lineNumbers .cm-activeLineGutter').color;
    const cur = q('.cm-cursor').borderLeftColor;
    return { bg, bgLum: lum(rgb(bg)), active, cur, activeRatio: ratio(active, bg), cursorRatio: ratio(cur, bg) };
  `);
  console.log(`editor colours (${theme}): ${JSON.stringify(c)}`);
  if (theme === "light") assert.ok(c.bgLum > 0.8, `the editor is light in the light theme (${c.bg})`);
  else assert.ok(c.bgLum < 0.05, `the editor is dark in the dark theme (${c.bg})`);
  assert.ok(c.activeRatio >= 4.5, `the active line number is readable (${c.active} on ${c.bg})`);
  assert.ok(c.cursorRatio >= 4.5, `the cursor is visible (${c.cur} on ${c.bg})`);
}
const ALT = "qa-area2-alt";
const LONG = Array.from({ length: 80 }, (_, i) => `  line${String(i).padStart(2, "0")}: value ${i}`).join("\n");
const FIXTURE = `
apiVersion: v1
kind: ConfigMap
metadata: { name: qa-yaml }
data:
  alpha: one
  beta: two
---
apiVersion: v1
kind: ConfigMap
metadata: { name: qa-yaml-2 }
data:
  gamma: three
---
apiVersion: v1
kind: ConfigMap
metadata: { name: qa-long }
data:
${LONG}
---
apiVersion: v1
kind: Secret
metadata: { name: qa-secret }
stringData:
  password: hunter2
`;

let ns;
let dir;
const get = (args) => kubectl(["-n", ns, ...args]);
const panel = (app) => app.find(byTestId("detail-panel"));

/** The test context plus a second context on the same cluster. */
function twoContextKubeconfig() {
  dir = mkdtempSync(join(tmpdir(), "qa-area2-yaml-"));
  const path = join(dir, "kubeconfig");
  writeFileSync(path, kubectl(["config", "view", "--minify", "--flatten"]), { mode: 0o600 });
  const k = (...args) => execFileSync("kubectl", ["--kubeconfig", path, "config", ...args], { encoding: "utf8" }).trim();
  const cluster = k("view", "-o", "jsonpath={.contexts[0].context.cluster}");
  const user = k("view", "-o", "jsonpath={.contexts[0].context.user}");
  k("set-context", ALT, `--cluster=${cluster}`, `--user=${user}`);
  k("use-context", CONTEXT);
  return path;
}

async function tab(app, name) {
  const p = await panel(app);
  await (await p.findElement(By.xpath(`.//button[@role='tab'][normalize-space()=${JSON.stringify(name)}]`))).click();
}

/** Open a ConfigMap/Secret's YAML tab; returns the loaded editor. */
async function openYaml(app, label, name, needle) {
  await openKind(app, label, ns, name);
  await app.clickRow(name, ns);
  await app.waitFor(async () => (await (await panel(app)).getText()).includes(`${ns}/${name}`), {
    message: `the panel of ${name}`,
  });
  await tab(app, "YAML");
  const el = await editor(app, "yaml-editor");
  await app.waitFor(async () => (await editorValue(app, el)).includes(needle), { message: `${needle} in the editor` });
  return el;
}

async function button(app, label) {
  const p = await panel(app);
  return app.waitFor(async () => {
    const found = await p.findElements(By.xpath(`.//button[normalize-space()=${JSON.stringify(label)}]`));
    return found[0] ?? null;
  }, { message: `the ${label} button` });
}

const statusText = async (app) => (await app.driver.findElement(byTestId("yaml-status"))).getText();

describe("area 2: YAML editor", { timeout: 20 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-area2-yaml", FIXTURE);
  });
  after(() => {
    deleteNamespace(ns);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const s = appSession("area-2-yaml-editor", () => ({ kubeconfig: twoContextKubeconfig() }));

  it("loads the editor chunk only when the YAML tab opens, without a visible delay", T, async () => {
    const { app } = s;
    await waitLive(app);
    // WebKitGTK records no resource timings for the tauri:// protocol, so
    // the chunk itself can't be seen loading here; CodeMirror is in its own
    // chunk (setup-*.js, not index-*.js, see the build). What counts in the
    // app: no editor exists before the tab opens, and it is ready quickly.
    const chunks = () =>
      app.js(`return performance.getEntriesByType("resource").map((e) => e.name).filter((n) => /setup-[^/]*\\.js/.test(n))`);
    assert.deepEqual(await chunks(), [], "no CodeMirror chunk at start-up");
    assert.equal(await app.js("return document.querySelectorAll('.cm-editor').length"), 0, "no editor before the YAML tab");
    await openKind(app, "Config Maps", ns, "qa-yaml");
    await app.clickRow("qa-yaml", ns);
    await panel(app);
    const t0 = Date.now();
    await tab(app, "YAML");
    const el = await editor(app, "yaml-editor");
    const ms = Date.now() - t0;
    console.log(`YAML tab to a ready editor: ${ms} ms; chunks: ${JSON.stringify(await chunks())}`);
    assert.ok(ms < 3000, `the editor was ready in ${ms} ms`);
    assert.ok((await app.js("return document.querySelectorAll('[data-testid=\"detail-panel\"] .cm-lineNumbers').length", el)) > 0);
    assert.doesNotMatch(await (await panel(app)).getText(), /Could not load the editor/);
  });

  it("types with Enter auto-indent, Tab and Shift-Tab", T, async () => {
    const { app } = s;
    const el = await editor(app, "yaml-editor");
    await cursorAtEndOf(app, el, "beta: two");
    await typeKeys(app, [Key.ENTER, "gamma: three"]);
    let v = await editorValue(app, el);
    assert.match(v, /\n {2}beta: two\n {2}gamma: three\n/, "Enter kept the indentation of the block");
    await typeKeys(app, [Key.HOME, Key.TAB]);
    v = await editorValue(app, el);
    console.log(`after Tab: ${JSON.stringify(v.split("\n").find((l) => l.includes("gamma")))}`);
    assert.match(v, /\n {4}gamma: three\n/, "Tab indents the line by 2 more spaces");
    await typeKeys(app, [{ shift: Key.TAB }]);
    v = await editorValue(app, el);
    assert.match(v, /\n {2}gamma: three\n/, "Shift-Tab dedents it again");
    // Focus is still in the editor (Tab did not move it out).
    assert.ok(await app.js("return document.activeElement?.classList.contains('cm-content')"), "focus stays in the editor");
    // Enter after a key that opens a block indents the next line.
    await cursorAtEndOf(app, el, "gamma: three");
    await typeKeys(app, [Key.ENTER, { shift: Key.TAB }, "nested:", Key.ENTER, "x: y"]);
    v = await editorValue(app, el);
    console.log(`block after nested: ${JSON.stringify(v.slice(v.indexOf("nested")))}`);
    assert.match(v, /\nnested:\n {2}x: y\n/, "Enter after a top-level key indents the next line (#101)");
    // The same inside the data: block.
    await cursorAtEndOf(app, el, "alpha: one");
    await typeKeys(app, [Key.ENTER, "inner:", Key.ENTER, "z: 1"]);
    v = await editorValue(app, el);
    console.log(`block after inner: ${JSON.stringify(v.slice(v.indexOf("  inner"), v.indexOf("z: 1") + 4))}`);
    assert.match(v, /\n {2}inner:\n {4}z: 1\n/, "Enter after a nested key indents the next line (#101)");
    // #153: clicking a line (wide, as long as the last-applied annotation)
    // scrolls the view sideways; typing brings it back to the left edge, so
    // the column-0 keys aren't cut by the gutter.
    const edge = await app.js(`
      const s = document.querySelector('[data-testid="detail-panel"] .cm-scroller');
      const line = Array.from(s.querySelectorAll('.cm-line')).find((l) => l.textContent.startsWith('apiVersion'));
      const r = document.createRange();
      r.selectNodeContents(line);
      return { scrollLeft: s.scrollLeft, scrollWidth: s.scrollWidth, clientWidth: s.clientWidth,
        text: r.getBoundingClientRect().left, gutter: s.querySelector('.cm-gutters').getBoundingClientRect().right };
    `);
    console.log(`after typing: ${JSON.stringify(edge)}`);
    assert.equal(edge.scrollLeft, 0, "the editor is at its left edge after typing (#153)");
    assert.ok(edge.text >= edge.gutter, `apiVersion starts right of the gutter (${edge.text} >= ${edge.gutter})`);
    const dot = await app.js("return !!document.querySelector('[data-testid=\"detail-panel\"] h3 .dirty')");
    assert.ok(dot, "the unsaved dot shows");
    // Both themes explicitly: CI's system theme is light.
    await setTheme(app, "dark");
    await app.shot("typed-dark");
    await assertEditorReadable(app, "dark");
    await setTheme(app, "light");
    await app.shot("typed-light");
    // #98: the editor follows the light theme; the cursor and the active
    // line's number keep their contrast.
    await assertEditorReadable(app, "light");
    await setTheme(app, null);
  });

  it("Ctrl+F opens CodeMirror's search panel; find and replace work", T, async () => {
    const { app } = s;
    const el = await editor(app, "yaml-editor");
    await cursorAtEndOf(app, el, "alpha: one");
    await app.driver.actions().keyDown(Key.CONTROL).sendKeys("f").keyUp(Key.CONTROL).perform();
    const search = await app.find(By.css('[data-testid="detail-panel"] .cm-search input[name="search"]'));
    assert.ok(await app.js("return document.activeElement?.name === 'search'"), "the search field has focus");
    await search.sendKeys("one");
    await search.sendKeys(Key.ENTER);
    await app.waitFor(() => app.js("return document.querySelectorAll('[data-testid=\"detail-panel\"] .cm-searchMatch').length > 0"), {
      message: "a highlighted match",
    });
    const replace = await app.driver.findElement(By.css('[data-testid="detail-panel"] .cm-search input[name="replace"]'));
    await replace.sendKeys("uno");
    await app.shot("search-panel");
    await (await app.driver.findElement(By.css('[data-testid="detail-panel"] .cm-search button[name="replaceAll"]'))).click();
    await app.waitFor(async () => (await editorValue(app, el)).includes("alpha: uno"), { message: "alpha: uno after replace all" });
    await setTheme(app, "light");
    await app.shot("search-panel-light");
    await setTheme(app, null);
    await search.sendKeys(Key.ESCAPE);
    await app.waitFor(async () => (await app.driver.findElements(By.css('[data-testid="detail-panel"] .cm-search'))).length === 0, {
      message: "the search panel to close on Escape",
    });
  });

  it("folds from the gutter and matches brackets", T, async () => {
    const { app } = s;
    const el = await editor(app, "yaml-editor");
    // Fold the data: block.
    const marker = await app.waitFor(
      () =>
        app.js(
          `const lines = Array.from(arguments[0].querySelectorAll('.cm-line'));
           const i = lines.findIndex((l) => l.textContent === 'data:');
           const gutter = arguments[0].querySelectorAll('.cm-foldGutter .cm-gutterElement');
           // The first gutter element is a spacer.
           const el = Array.from(gutter).find((g) => Math.abs(g.getBoundingClientRect().top - lines[i].getBoundingClientRect().top) < 2);
           return el?.querySelector('span') ?? null;`,
          el,
        ),
      { message: "a fold marker on data:" },
    );
    await marker.click();
    await app.waitFor(() => app.js("return !!arguments[0].querySelector('.cm-foldPlaceholder')", el), { message: "the fold placeholder" });
    const hidden = await app.js(`return Array.from(arguments[0].querySelectorAll('.cm-line'), (l) => l.textContent).some((t) => t.includes('beta: two'))`, el);
    assert.equal(hidden, false, "the folded lines are hidden");
    await app.shot("folded");
    await (await el.findElement(By.css(".cm-foldPlaceholder"))).click();
    await app.waitFor(async () => !(await app.js("return !!arguments[0].querySelector('.cm-foldPlaceholder')", el)), {
      message: "unfolded",
    });

    // Bracket matching: a flow list.
    await cursorAtEndOf(app, el, "beta: two");
    // Cursor right before the closing bracket.
    await typeKeys(app, [Key.ENTER, "list: [a, b]", Key.END, Key.LEFT]);
    const matched = await app.waitFor(
      async () => {
        const n = await app.js("return arguments[0].querySelectorAll('.cm-matchingBracket').length", el);
        return n === 2 ? n : null;
      },
      { timeout: 5000, message: "two .cm-matchingBracket" },
    );
    assert.equal(matched, 2);
    const v = await editorValue(app, el);
    assert.ok(!v.includes("list: [a, b]]"), `typing "[" did not leave a doubled bracket: ${JSON.stringify(v.slice(v.indexOf("list")))}`);
    console.log(`list line: ${JSON.stringify(v.split("\n").find((l) => l.includes("list:")))}`);
    await app.shot("bracket-match");
  });

  it("Review shows unified and side-by-side diffs that scroll; Save writes the object", T, async () => {
    const { app } = s;
    // Drop the edits so far (Reload asks) and use the long ConfigMap.
    await (await button(app, "Reload")).click();
    await answerDiscard(app, "Discard changes");
    const el = await openYaml(app, "Config Maps", "qa-long", "line79");
    const v = await editorValue(app, el);
    // Every other line changed: a diff taller than the panel.
    await setEditorValue(app, el, v.replace(/line(\d)([02468]): value \d+/g, "line$1$2: changed"));
    await (await app.find(byTestId("yaml-review"))).click();
    await app.find(byTestId("yaml-save"));
    await app.waitFor(() => app.js("return document.querySelector('[data-testid=\"detail-panel\"] .diff')?.dataset.ready === 'true'"), {
      message: "the diff to render",
    });
    const changed = await app.js("return Array.from(document.querySelectorAll('[data-testid=\"detail-panel\"] .cm-changedLine'), (l) => l.textContent)");
    console.log(`unified changed lines: ${JSON.stringify(changed)}`);
    assert.ok(changed.some((l) => l.includes("line00: changed")), "the unified diff marks the change");
    assert.match(await statusText(app), /The server accepted these changes in a test run/);
    const scrolls = async () =>
      app.js(`const all = Array.from(document.querySelectorAll('[data-testid="detail-panel"] .diff, [data-testid="detail-panel"] .diff *'));
              const s = all.find((x) => x.scrollHeight > x.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(x).overflowY));
              if (!s) return null;
              s.scrollTop = s.scrollHeight;
              return { el: s.className, scrollTop: s.scrollTop, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight };`);
    const u = await scrolls();
    console.log(`unified scroll: ${JSON.stringify(u)}`);
    assert.ok(u && u.scrollTop > 0, "the unified diff scrolls");
    await app.shot("diff-unified");

    await (await button(app, "Side by side")).click();
    await app.waitFor(() => app.js("return document.querySelectorAll('[data-testid=\"detail-panel\"] .cm-mergeView .cm-editor').length === 2"), {
      message: "two editors side by side",
    });
    const sp = await scrolls();
    console.log(`side-by-side scroll: ${JSON.stringify(sp)}`);
    assert.ok(sp && sp.scrollTop > 0, "the side-by-side diff scrolls");
    await setTheme(app, "dark");
    await app.shot("diff-split-dark");
    await setTheme(app, "light");
    await app.shot("diff-split-light");
    await setTheme(app, null);
    await (await button(app, "Unified")).click();

    await (await app.find(byTestId("yaml-save"))).click();
    await app.waitFor(async () => /Saved/.test(await statusText(app)), { message: "Saved." });
    assert.equal(get(["get", "cm", "qa-long", "-o", "jsonpath={.data.line78}"]), "changed");
    await app.shot("saved");
  });

  it("a kubectl write to another key meanwhile: the edit is re-applied on the latest, then Save (#495)", T, async () => {
    const { app } = s;
    const el = await openYaml(app, "Config Maps", "qa-yaml", "alpha: one");
    const v = await editorValue(app, el);
    await setEditorValue(app, el, v.replace("alpha: one", "alpha: mine"));
    get(["patch", "cm", "qa-yaml", "--type=merge", "-p", '{"data":{"beta":"theirs"}}']);
    await (await app.find(byTestId("yaml-review"))).click();
    const note = await app.find(byTestId("yaml-rebased"));
    assert.match(await note.getText(), /changed on the server while you were editing \(\.data\.beta\)/);
    await app.shot("rebased-note");
    await app.find(byTestId("yaml-save"));
    await app.waitFor(() => app.js("return document.querySelector('[data-testid=\"detail-panel\"] .diff')?.dataset.ready === 'true'"), {
      message: "the diff against the latest",
    });
    const changed = await app.js("return Array.from(document.querySelectorAll('[data-testid=\"detail-panel\"] .cm-changedLine'), (l) => l.textContent)");
    console.log(`diff against the latest: ${JSON.stringify(changed)}`);
    // #101: the "N unchanged lines" bar draws CSS chevrons, not a `⦚` glyph
    // the system fonts lack; in both themes.
    const marks = await app.js(`
      const bar = document.querySelector('[data-testid="detail-panel"] .cm-collapsedLines');
      return bar && { text: bar.textContent, marks: ['::before', '::after'].map((p) => getComputedStyle(bar, p).content) };`);
    console.log(`collapsed bar: ${JSON.stringify(marks)}`);
    assert.ok(marks, "the diff collapses the unchanged lines");
    assert.deepEqual(marks.marks, ['""', '""'], "no glyph in the unchanged-lines bar");
    await setTheme(app, "light");
    await app.shot("diff-against-latest-light");
    await setTheme(app, "dark");
    await app.shot("diff-against-latest");
    await setTheme(app, null);
    await (await app.find(byTestId("yaml-save"))).click();
    await app.waitFor(async () => /Saved/.test(await statusText(app)), { message: "Saved." });
    const data = JSON.parse(get(["get", "cm", "qa-yaml", "-o", "jsonpath={.data}"]));
    console.log(`after the save: ${JSON.stringify(data)}`);
    assert.equal(data.alpha, "mine");
    assert.equal(data.beta, "theirs", "the other write is kept");
  });

  it("a kubectl write to the same key meanwhile: a conflict naming it; Reload (lose my edits)", T, async () => {
    const { app } = s;
    const el = await editor(app, "yaml-editor");
    await app.waitFor(async () => (await editorValue(app, el)).includes("alpha: mine"), { message: "the reloaded YAML" });
    const v = await editorValue(app, el);
    await setEditorValue(app, el, v.replace("alpha: mine", "alpha: lost"));
    get(["patch", "cm", "qa-yaml", "--type=merge", "-p", '{"data":{"alpha":"server"}}']);
    await (await app.find(byTestId("yaml-review"))).click();
    const alert = await app.find(By.css('[data-testid="yaml-status"] [role="alert"]'));
    assert.match(await alert.getText(), /You and someone else both changed \.data\.alpha/);
    await app.shot("conflict-banner");
    await (await button(app, "Reload (lose my edits)")).click();
    await app.waitFor(async () => (await editorValue(app, await editor(app, "yaml-editor"))).includes("alpha: server"), {
      message: "alpha: server in the editor",
    });
    const after = await editorValue(app, await editor(app, "yaml-editor"));
    assert.ok(!after.includes("alpha: lost"), "the edit is gone");
    assert.equal(await app.js("return !!document.querySelector('[data-testid=\"yaml-status\"] [role=\"alert\"]')"), false);
    assert.equal(await (await app.find(byTestId("yaml-review"))).isEnabled(), false, "nothing to review");
  });

  it("the same key again: Compare with the latest, then Save replaces the other write only on Save", T, async () => {
    const { app } = s;
    const el = await editor(app, "yaml-editor");
    const v = await editorValue(app, el);
    await setEditorValue(app, el, v.replace("alpha: server", "alpha: mine2"));
    get(["patch", "cm", "qa-yaml", "--type=merge", "-p", '{"data":{"alpha":"server2"}}']);
    await (await app.find(byTestId("yaml-review"))).click();
    await app.find(By.css('[data-testid="yaml-status"] [role="alert"]'));
    await (await button(app, "Compare with the latest")).click();
    await app.find(byTestId("yaml-save"));
    await app.waitFor(() => app.js("return document.querySelector('[data-testid=\"detail-panel\"] .diff')?.dataset.ready === 'true'"), {
      message: "the diff against the latest",
    });
    const changed = await app.js("return Array.from(document.querySelectorAll('[data-testid=\"detail-panel\"] .cm-changedLine'), (l) => l.textContent)");
    // Unified diff: the latest version's lines are drawn as deleted chunks.
    const deleted = await app.js("return Array.from(document.querySelectorAll('[data-testid=\"detail-panel\"] .cm-deletedChunk'), (l) => l.textContent).join('\\n')");
    console.log(`compare with the latest: ${JSON.stringify({ changed, deleted })}`);
    assert.ok(changed.some((l) => /alpha: mine2/.test(l)), "the diff shows mine");
    assert.match(deleted, /alpha: server2/, "replacing theirs");
    assert.match(await statusText(app), /Saving replaces what changed there with your version/);
    assert.equal(get(["get", "cm", "qa-yaml", "-o", "jsonpath={.data.alpha}"]), "server2", "nothing replaced before Save");
    await setTheme(app, "light");
    await app.shot("compare-latest-light");
    await setTheme(app, "dark");
    await app.shot("compare-latest-dark");
    await setTheme(app, null);
    await (await app.find(byTestId("yaml-save"))).click();
    await app.waitFor(async () => /Saved/.test(await statusText(app)), { message: "Saved." });
    assert.equal(get(["get", "cm", "qa-yaml", "-o", "jsonpath={.data.alpha}"]), "mine2", "replaced after the explicit Save");
  });

  it("asks before closing the panel, opening another kind or row; Keep editing keeps the edit", T, async () => {
    const { app } = s;
    const edit = async () => {
      const el = await editor(app, "yaml-editor");
      const v = await editorValue(app, el);
      if (!v.includes("qa-unsaved")) await setEditorValue(app, el, v.replace("data:\n", "data:\n  qa-unsaved: yes\n"));
      await app.waitFor(() => app.js("return !!document.querySelector('[data-testid=\"detail-panel\"] h3 .dirty')"), {
        message: "the unsaved dot",
      });
    };
    const stillEditing = async () => {
      assert.match(await (await panel(app)).getText(), new RegExp(`${ns}/qa-yaml\\b`));
      assert.ok((await editorValue(app, await editor(app, "yaml-editor"))).includes("qa-unsaved"), "the edit is kept");
    };
    await edit();

    // Close the panel.
    await (await app.find(By.css('[data-testid="detail-panel"] button[aria-label="Close details"]'))).click();
    const dialog = await waitDiscardDialog(app);
    console.log(`dialog: ${await dialog.getText()}`);
    await setTheme(app, "dark");
    await app.shot("discard-dialog-dark");
    await setTheme(app, "light");
    await app.shot("discard-dialog-light");
    await setTheme(app, null);
    await answerDiscard(app, "Keep editing");
    await stillEditing();

    // Another kind in the sidebar; Escape keeps editing.
    await app.nav("Secrets");
    await waitDiscardDialog(app);
    await app.driver.actions().sendKeys(Key.ESCAPE).perform();
    await app.waitFor(async () => !(await discardDialog(app)), { message: "Escape to close the dialog" });
    await stillEditing();

    // Another row.
    await app.clickRow("qa-yaml-2", ns);
    await waitDiscardDialog(app);
    await answerDiscard(app, "Keep editing");
    await stillEditing();

    // Switching tabs keeps the edit without asking.
    await tab(app, "Overview");
    await tab(app, "YAML");
    assert.equal(await discardDialog(app), null);
    await stillEditing();

    // Another row, discarding: the other object opens.
    await app.clickRow("qa-yaml-2", ns);
    await answerDiscard(app, "Discard changes");
    await app.waitFor(async () => (await (await panel(app)).getText()).includes(`${ns}/qa-yaml-2`), { message: "qa-yaml-2 open" });
  });

  it("a locked Secret can't be typed into; after Reveal it can", T, async () => {
    const { app } = s;
    const el = await openYaml(app, "Secrets", "qa-secret", "password:");
    const before = await editorValue(app, el);
    assert.match(before, /password: .<hidden/);
    const content = await el.findElement(By.css(".cm-content"));
    assert.equal(await content.getAttribute("contenteditable"), "false");
    assert.equal(await content.getAttribute("aria-readonly"), "true");
    await cursorAtEndOf(app, el, "password:");
    await typeKeys(app, ["typed"]);
    assert.equal(await editorValue(app, el), before, "typing changed nothing");
    assert.match(await statusText(app), /Values are hidden/);
    assert.equal(await (await app.find(byTestId("yaml-review"))).isEnabled(), false);
    await app.shot("secret-locked");

    await (await button(app, "Reveal values")).click();
    await app.waitFor(async () => (await editorValue(app, await editor(app, "yaml-editor"))).match(/password: (aHVudGVyMg==|hunter2)/), {
      message: "the revealed value",
    });
    const open = await editor(app, "yaml-editor");
    assert.equal(await (await open.findElement(By.css(".cm-content"))).getAttribute("contenteditable"), "true");
    await cursorAtEndOf(app, open, "password:");
    await typeKeys(app, ["x"]);
    await app.waitFor(async () => (await editorValue(app, open)).match(/password: (aHVudGVyMg==|hunter2)x/), { message: "the typed x" });
    await app.shot("secret-revealed");
    // Hide asks first, since there is an edit.
    await (await button(app, "Hide values")).click();
    await answerDiscard(app, "Discard changes");
    await app.waitFor(async () => (await editorValue(app, await editor(app, "yaml-editor"))).includes("<hidden"), {
      message: "hidden again",
    });
  });

  it("asks before switching context; Keep editing puts the select back", T, async () => {
    const { app } = s;
    const el = await openYaml(app, "Config Maps", "qa-yaml-2", "gamma: three");
    await setEditorValue(app, el, (await editorValue(app, el)).replace("gamma: three", "gamma: edited"));
    const select = await app.find(By.css('select[aria-label="Cluster context"]'));
    // A native <select> opens a GTK menu that WebDriver cannot drive, and an
    // option click from WebKitWebDriver fires no "change": choose the way the
    // menu does, by setting the value and firing "change".
    const pick = (name) =>
      app.js("arguments[0].value = arguments[1]; arguments[0].dispatchEvent(new Event(\"change\", { bubbles: true }))", select, name);
    await pick(ALT);
    await waitDiscardDialog(app);
    await app.shot("context-switch-asks");
    await answerDiscard(app, "Keep editing");
    await app.waitFor(async () => (await select.getAttribute("value")) === CONTEXT, { message: "the select back on the test context" });
    assert.ok((await editorValue(app, await editor(app, "yaml-editor"))).includes("gamma: edited"));

    await pick(ALT);
    await answerDiscard(app, "Discard changes");
    await app.waitFor(async () => (await select.getAttribute("value")) === ALT, { message: `the select on ${ALT}` });
    await app.waitFor(async () => (await app.driver.findElements(byTestId("detail-panel"))).length === 0, { message: "the panel closed" });
    await waitLive(app);
    assert.equal(get(["get", "cm", "qa-yaml-2", "-o", "jsonpath={.data.gamma}"]), "three", "nothing was saved");
  });
});

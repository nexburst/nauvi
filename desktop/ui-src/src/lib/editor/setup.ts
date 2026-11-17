// CodeMirror setup shared by the editor and the diff view. Imported only
// through dynamic `import()` (see CodeEditor.svelte / DiffView.svelte), so it
// is a separate chunk that loads when an editor first opens.

import { basicSetup } from "codemirror";
import { indentWithTab } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, indentUnit, syntaxHighlighting } from "@codemirror/language";
import { Compartment, EditorState, StateEffect, StateField, countColumn } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { Decoration, EditorView, keymap } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { yamlBlockIndent } from "./yaml-indent";

const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/**
 * The editor's look, all from the variables in app.css, so it follows the
 * app theme (dark, light or the system's) without reconfiguring the view.
 * Not marked `dark`: CodeMirror's base theme then picks its light defaults,
 * so everything those set (cursor, gutters, panels, brackets) is overridden
 * here with a variable.
 */
const theme = EditorView.theme(
  {
    "&": {
      height: "100%",
      backgroundColor: "var(--code-bg)",
      color: "var(--code-text)",
      // Settings → Editor (#330), set on <html> by the settings store.
      fontSize: "var(--editor-font-size, 12px)",
    },
    ".cm-scroller": { fontFamily: MONO, lineHeight: "1.5" },
    ".cm-content": { caretColor: "var(--code-text)" },
    "&.cm-focused": { outline: "none" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--code-text)" },
    ".cm-gutters": {
      backgroundColor: "var(--code-bg)",
      color: "var(--text-muted)",
      border: "none",
      borderRight: "1px solid var(--border)",
    },
    ".cm-activeLine": { backgroundColor: "var(--code-active-line)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--code-active-gutter)", color: "var(--code-text)" },
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection":
      { backgroundColor: "rgba(79, 156, 247, 0.3)" },
    ".cm-selectionMatch": { backgroundColor: "rgba(79, 156, 247, 0.15)" },
    ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
      backgroundColor: "rgba(63, 178, 127, 0.25)",
      outline: "none",
    },
    ".cm-nonmatchingBracket, &.cm-focused .cm-nonmatchingBracket": { backgroundColor: "rgba(229, 72, 77, 0.25)" },
    ".cm-searchMatch": { backgroundColor: "rgba(245, 165, 36, 0.25)", outline: "1px solid var(--amber)" },
    ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "rgba(245, 165, 36, 0.5)" },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--bg-hover)",
      border: "1px solid var(--border)",
      color: "var(--text-muted)",
    },
    ".cm-tooltip, .cm-panels": {
      backgroundColor: "var(--bg-raised)",
      color: "var(--text)",
      border: "1px solid var(--border)",
    },
    ".cm-panels input, .cm-panels button": { fontSize: "12px" },
    ".cm-textfield": {
      backgroundColor: "var(--bg)",
      color: "var(--text)",
      border: "1px solid var(--border)",
      borderRadius: "4px",
    },
    ".cm-button": {
      backgroundImage: "none",
      backgroundColor: "var(--bg-hover)",
      color: "var(--text)",
      border: "1px solid var(--border)",
      borderRadius: "4px",
    },
    ".cm-errorLine": { backgroundColor: "rgba(229, 72, 77, 0.18)" },
    // Diff view (@codemirror/merge).
    ".cm-changedLine, .cm-merge-b .cm-changedLine": { backgroundColor: "rgba(63, 178, 127, 0.12)" },
    ".cm-changedText, .cm-merge-b .cm-changedText": { background: "rgba(63, 178, 127, 0.35)" },
    ".cm-deletedChunk, .cm-merge-a .cm-changedLine": { backgroundColor: "rgba(229, 72, 77, 0.12)" },
    ".cm-deletedChunk .cm-deletedText, .cm-merge-a .cm-changedText": { background: "rgba(229, 72, 77, 0.35)" },
    ".cm-changeGutter": { width: "3px" },
    // The "N unchanged lines" bar. @codemirror/merge frames it with `⦚`,
    // which the usual Linux fonts lack (tofu in WebKitGTK, #101): draw a
    // chevron with borders instead, in the theme's colours.
    ".cm-collapsedLines": {
      color: "var(--text-muted)",
      background: "var(--bg-hover)",
      borderTop: "1px solid var(--border)",
      borderBottom: "1px solid var(--border)",
    },
    ".cm-collapsedLines:hover": { color: "var(--text)" },
    ".cm-collapsedLines:before, .cm-collapsedLines:after": {
      content: '""',
      display: "inline-block",
      width: "5px",
      height: "5px",
      borderRight: "1.5px solid currentColor",
      borderBottom: "1.5px solid currentColor",
      transform: "translateY(-3px) rotate(45deg)",
    },
    ".cm-collapsedLines:before": { marginInlineEnd: "10px" },
    ".cm-collapsedLines:after": { marginInlineStart: "10px" },
  },
);

const highlight = HighlightStyle.define([
  { tag: [t.propertyName, t.definition(t.propertyName)], color: "var(--syn-key)" },
  { tag: [t.string, t.special(t.string)], color: "var(--syn-string)" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "var(--syn-number)" },
  { tag: [t.comment, t.lineComment], color: "var(--syn-comment)", fontStyle: "italic" },
  { tag: [t.keyword, t.typeName, t.labelName], color: "var(--syn-keyword)" },
  { tag: [t.punctuation, t.separator, t.squareBracket, t.brace], color: "var(--syn-punct)" },
  { tag: t.meta, color: "var(--syn-punct)" },
  { tag: t.invalid, color: "var(--syn-invalid)" },
]);

/** YAML with the app's look: what both the editor and the diff use. */
export function yamlLook(): Extension {
  return [yaml(), theme, syntaxHighlighting(highlight)];
}

function label(text: string): Extension {
  return EditorView.contentAttributes.of({ "aria-label": text });
}

// One line marked as the location of an error.
const markLine = StateEffect.define<number | null>();
const errorLine = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(markLine)) continue;
      const n = e.value;
      if (n === null || n < 1 || n > tr.state.doc.lines) {
        deco = Decoration.none;
      } else {
        const line = tr.state.doc.line(n);
        deco = Decoration.set([Decoration.line({ class: "cm-errorLine" }).range(line.from)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * Keep the left edge in view while the cursor fits there (#153). When the
 * view is scrolled sideways (to read a long line, or by a click in the middle
 * of one) and the cursor moves out of view, CodeMirror scrolls just far
 * enough to show the cursor, 5 px from the gutter: the first characters of
 * the line stay hidden behind the gutter. Here, a cursor scroll that would
 * fit with no sideways scroll goes back to the left edge first; CodeMirror
 * then sees the cursor in view and leaves x alone (y is still its own).
 */
const scrollToLeftEdge = EditorView.scrollHandler.of((view, range, options) => {
  const scroller = view.scrollDOM;
  if (options.x !== "nearest" || scroller.scrollLeft === 0) return false;
  // The cursor's x with no sideways scroll, from its column (the font is
  // monospace; coordsAtPos can't be read while CodeMirror measures).
  const state = view.state;
  const column = (pos: number) => {
    const line = state.doc.lineAt(pos);
    return countColumn(line.text.slice(0, pos - line.from), state.tabSize);
  };
  const line = scroller.querySelector<HTMLElement>(".cm-line");
  const pad = line ? parseFloat(getComputedStyle(line).paddingLeft) || 0 : 0;
  const textLeft = view.contentDOM.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft + pad;
  const right = textLeft + (Math.max(column(range.head), column(range.anchor)) + 1) * view.defaultCharacterWidth;
  if (right + options.xMargin <= scroller.clientWidth) scroller.scrollLeft = 0;
  return false;
});

export interface EditorOptions {
  value: string;
  readonly: boolean;
  label: string;
  /** Tab size and indent unit, in columns (#330). */
  tabSize: number;
  onChange: (value: string) => void;
}

/** What `CodeEditor.svelte` drives. */
export interface EditorHandle {
  getValue(): string;
  setValue(value: string): void;
  setReadonly(readonly: boolean): void;
  /** Change the tab size and indent unit (#330). */
  setTabSize(columns: number): void;
  /** Mark a 1-based line (and scroll to it), or clear the mark. */
  markLine(line: number | null): void;
  destroy(): void;
}

export function createEditor(parent: HTMLElement, opts: EditorOptions): EditorHandle {
  const ro = new Compartment();
  const tabs = new Compartment();
  const tabSize = (n: number) => [indentUnit.of(" ".repeat(n)), EditorState.tabSize.of(n)];
  const readonly = (on: boolean) => [
    EditorState.readOnly.of(on),
    EditorView.editable.of(!on),
    EditorView.contentAttributes.of({ "aria-readonly": String(on) }),
  ];
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.value,
      extensions: [
        basicSetup,
        keymap.of([indentWithTab]),
        tabs.of(tabSize(opts.tabSize)),
        yamlLook(),
        yamlBlockIndent(),
        label(opts.label),
        errorLine,
        scrollToLeftEdge,
        ro.of(readonly(opts.readonly)),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) opts.onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
  return {
    getValue: () => view.state.doc.toString(),
    setValue(value) {
      if (value === view.state.doc.toString()) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    },
    setReadonly(on) {
      view.dispatch({ effects: ro.reconfigure(readonly(on)) });
    },
    setTabSize(n) {
      if (n === view.state.tabSize) return;
      view.dispatch({ effects: tabs.reconfigure(tabSize(n)) });
    },
    markLine(line) {
      const effects: StateEffect<unknown>[] = [markLine.of(line)];
      if (line !== null && line >= 1 && line <= view.state.doc.lines) {
        effects.push(EditorView.scrollIntoView(view.state.doc.line(line).from, { y: "center" }));
      }
      view.dispatch({ effects });
    },
    destroy: () => view.destroy(),
  };
}

export type DiffLayout = "unified" | "split";

/** A read-only diff of `original` (left / removed) and `modified`. */
export async function createDiff(
  parent: HTMLElement,
  original: string,
  modified: string,
  layout: DiffLayout,
  name: string,
): Promise<{ destroy(): void }> {
  const { MergeView, unifiedMergeView } = await import("@codemirror/merge");
  const common = [
    EditorView.lineWrapping,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    yamlLook(),
  ];
  // Long objects: show the changes with a few lines of context.
  const collapseUnchanged = { margin: 3, minSize: 6 };
  if (layout === "unified") {
    const view = new EditorView({
      parent,
      doc: modified,
      extensions: [
        ...common,
        label(name),
        unifiedMergeView({ original, mergeControls: false, highlightChanges: true, gutter: true, collapseUnchanged }),
      ],
    });
    return view;
  }
  const merge = new MergeView({
    parent,
    a: { doc: original, extensions: [...common, label(`${name}: server`)] },
    b: { doc: modified, extensions: [...common, label(`${name}: yours`)] },
    highlightChanges: true,
    gutter: true,
    collapseUnchanged,
  });
  return merge;
}

import { describe, expect, it } from "vitest";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { indentUnit } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import type { Transaction } from "@codemirror/state";
import { yamlBlockIndent } from "./yaml-indent";

/** Press Enter at the end of `doc` (or at `‸`), then type `typed`; the resulting text. */
function enter(doc: string, typed = "x"): string {
  const at = doc.indexOf("‸");
  const text = at >= 0 ? doc.slice(0, at) + doc.slice(at + 1) : doc;
  let state = EditorState.create({
    doc: text,
    selection: EditorSelection.cursor(at >= 0 ? at : text.length),
    extensions: [yaml(), indentUnit.of("  "), EditorState.tabSize.of(2), yamlBlockIndent()],
  });
  insertNewlineAndIndent({ state, dispatch: (tr: Transaction) => (state = tr.state) });
  state = state.update(state.replaceSelection(typed)).state;
  return state.doc.toString();
}

describe("Enter in the YAML editor (#101)", () => {
  it("indents under a key that opens a block", () => {
    expect(enter("data:\n  alpha: one\n  inner:")).toBe("data:\n  alpha: one\n  inner:\n    x");
    expect(enter("nested:")).toBe("nested:\n  x");
  });

  it("keeps the indentation after a key with a value", () => {
    expect(enter("data:\n  beta: two")).toBe("data:\n  beta: two\n  x");
  });

  it("indents under list items and block scalars", () => {
    expect(enter("items:\n  - name:")).toBe("items:\n  - name:\n      x");
    expect(enter("items:\n  -")).toBe("items:\n  -\n    x");
    expect(enter("script: |")).toBe("script: |\n  x");
    expect(enter("  text: >-")).toBe("  text: >-\n    x");
  });

  it("indents under a list item that is a block scalar (#153)", () => {
    expect(enter("args:\n  - |")).toBe("args:\n  - |\n    x");
    expect(enter("args:\n  - >-")).toBe("args:\n  - >-\n    x");
    expect(enter("- |+ # keep")).toBe("- |+ # keep\n  x");
    expect(enter("- - >2")).toBe("- - >2\n    x");
  });

  it("ignores a trailing comment, but not a colon in quotes or a URL", () => {
    expect(enter("spec: # the spec")).toBe("spec: # the spec\n  x");
    expect(enter('  msg: "a:"')).toBe('  msg: "a:"\n  x');
    expect(enter("  url: http://example.com")).toBe("  url: http://example.com\n  x");
  });

  it("splitting a line in the middle keeps the language's indentation", () => {
    expect(enter("a:\n  b: 1‸c", "")).toBe("a:\n  b: 1\n  c");
  });
});

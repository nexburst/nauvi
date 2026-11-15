// Enter after a line that opens a block indents the next line (#101), as in
// VS Code: `key:`, `- key:`, a bare `-`, and block scalars (`key: |`,
// `key: >-`). @codemirror/lang-yaml keeps the previous line's indentation
// there, which turns `inner:` into `null` and the next key into a sibling.
// Everything else falls through to the language's own indentation.

import { indentService } from "@codemirror/language";
import type { IndentContext } from "@codemirror/language";
import type { Extension } from "@codemirror/state";

/** The line's content without a trailing comment (` # ...`) or spaces. */
function code(text: string): string {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(text[i - 1]))) {
      return text.slice(0, i).trimEnd();
    }
  }
  return text.trimEnd();
}

/**
 * The indentation (in columns) of the line after `text`, when `text` opens a
 * block; `undefined` when it doesn't.
 */
export function blockIndentAfter(text: string, unit: number, column: (text: string, to: number) => number): number | undefined {
  const c = code(text);
  if (!c.trim()) return undefined;
  // `- ` list markers: the block belongs to the item's content.
  const item = /^(\s*(?:-\s+)*)(.*)$/.exec(c)!;
  const content = item[2];
  if (content === "" || content === "-") {
    // A bare `-`: the item's content goes after the marker.
    return column(c, c.lastIndexOf("-")) + unit;
  }
  const opens = /:$/.test(content) || /:\s+[|>][-+0-9]*$/.test(content);
  if (!opens) return undefined;
  return column(c, item[1].length) + unit;
}

export function yamlBlockIndent(): Extension {
  return indentService.of((cx: IndentContext, pos: number) => {
    // Only Enter in or at the end of a line (the text before the break);
    // re-indenting a whole line is left to the language.
    const line = cx.state.doc.lineAt(pos);
    if (pos <= line.from) return undefined;
    const before = cx.lineAt(pos, -1).text.slice(0, pos - line.from);
    return blockIndentAfter(before, cx.unit, (text, to) => cx.countColumn(text, to));
  });
}

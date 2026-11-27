// Plain-text nauvi:// links in an Ask AI terminal (#548): an xterm link
// provider, so a link the AI prints without OSC 8 can be clicked too. Only
// Ask AI terminals register it (`Terminal.svelte`).

import type { IBufferLine, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { describeAppLink, findAppLinks } from "./terminalLinks";

/** A line's text and, for each of its UTF-16 units, the cell it is in
 *  (wide characters take two cells). */
export function lineText(line: IBufferLine): { text: string; cells: number[] } {
  let text = "";
  const cells: number[] = [];
  for (let x = 0; x < line.length; x++) {
    const cell = line.getCell(x);
    if (!cell || cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    text += chars;
    for (let i = 0; i < chars.length; i++) cells.push(x);
  }
  return { text, cells };
}

/** Finds the links in each line; `open` gets the clicked one, `title` what
 *  the pointer is over ("" when it leaves). */
export function appLinkProvider(
  term: Terminal,
  open: (uri: string) => void,
  title: (text: string) => void,
): ILinkProvider {
  return {
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) return callback(undefined);
      const { text, cells } = lineText(line);
      const links: ILink[] = findAppLinks(text).map((f) => ({
        range: { start: { x: cells[f.start] + 1, y }, end: { x: cells[f.end - 1] + 1, y } },
        text: f.uri,
        decorations: { underline: true, pointerCursor: true },
        activate: () => open(f.uri),
        hover: () => title(describeAppLink(f.uri)),
        leave: () => title(""),
      }));
      callback(links.length ? links : undefined);
    },
  };
}

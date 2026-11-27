import { describe, expect, it } from "vitest";
import type { IBufferLine, ILink, Terminal } from "@xterm/xterm";
import { appLinkProvider, lineText } from "./terminalAppLinks";

/** A buffer line of `cells`: each a cell's text; "" is the second half of a wide character. */
function line(cells: string[]): IBufferLine {
  return {
    length: cells.length,
    getCell: (x: number) => ({
      getChars: () => cells[x],
      getWidth: () => (cells[x] === "" ? 0 : cells[x + 1] === "" ? 2 : 1),
    }),
  } as unknown as IBufferLine;
}

const cellsOf = (s: string) => [...s];

describe("plain-text nauvi:// links (#548)", () => {
  it("maps text back to cells past wide characters", () => {
    const l = line(["界", "", "a", "b"]);
    expect(lineText(l)).toEqual({ text: "界ab", cells: [0, 2, 3] });
  });

  it("gives each link its cells, and opens the one clicked", () => {
    const text = "界 see nauvi://kind/core/v1/Pod/demo/web.";
    const cells = cellsOf(text);
    cells.splice(1, 0, ""); // 界 is two cells wide
    const term = { buffer: { active: { getLine: () => line(cells) } } } as unknown as Terminal;
    const opened: string[] = [];
    const titles: string[] = [];
    let links: ILink[] | undefined;
    appLinkProvider(term, (u) => opened.push(u), (t) => titles.push(t)).provideLinks(3, (l) => (links = l));
    expect(links).toHaveLength(1);
    const [link] = links!;
    // "界" (2 cells), " see " (5): the link starts at cell 8 (1-based), ends before the dot.
    expect(link.range).toEqual({ start: { x: 8, y: 3 }, end: { x: 8 + 33 - 1, y: 3 } });
    expect(link.text).toBe("nauvi://kind/core/v1/Pod/demo/web");
    link.activate({} as MouseEvent, link.text);
    link.hover?.({} as MouseEvent, link.text);
    expect(opened).toEqual(["nauvi://kind/core/v1/Pod/demo/web"]);
    expect(titles).toEqual(["Open Pod demo/web (kind) in nauvi"]);
  });

  it("finds nothing in a line without links", () => {
    const term = { buffer: { active: { getLine: () => line(cellsOf("https://example.com")) } } } as unknown as Terminal;
    let links: ILink[] | undefined = [];
    appLinkProvider(term, () => {}, () => {}).provideLinks(1, (l) => (links = l));
    expect(links).toBeUndefined();
  });
});

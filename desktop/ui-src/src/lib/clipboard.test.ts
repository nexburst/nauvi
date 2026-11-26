import { describe, expect, it } from "vitest";
import { ClipboardError, copyWhenReady } from "./clipboard";

class FakeItem {
  constructor(public parts: Record<string, Promise<Blob>>) {}
}
const Item = FakeItem as unknown as typeof ClipboardItem;

function clipboard({ write = true, failWrite = false, failText = false } = {}) {
  const got: string[] = [];
  return {
    got,
    writeText: async (t: string) => {
      if (failText) throw new Error("denied");
      got.push(`text:${t}`);
    },
    write: write
      ? async (items: ClipboardItem[]) => {
          if (failWrite) throw new Error("denied");
          const blob = await (items[0] as unknown as FakeItem).parts["text/plain"];
          got.push(`item:${await blob.text()}`);
        }
      : undefined,
  };
}

describe("copyWhenReady", () => {
  it("writes a ClipboardItem from the promise when it can", async () => {
    const c = clipboard();
    expect(await copyWhenReady(Promise.resolve("Name: web"), c, Item)).toBe("Name: web");
    expect(c.got).toEqual(["item:Name: web"]);
  });

  it("falls back to writeText without ClipboardItem or when write is refused", async () => {
    const c = clipboard({ write: false });
    await copyWhenReady(Promise.resolve("a"), c, Item);
    const d = clipboard({ failWrite: true });
    await copyWhenReady(Promise.resolve("b"), d, Item);
    const e = clipboard();
    await copyWhenReady(Promise.resolve("c"), e, undefined);
    expect([c.got, d.got, e.got]).toEqual([["text:a"], ["text:b"], ["text:c"]]);
  });

  it("rejects with the backend's error, and nothing is copied", async () => {
    const c = clipboard();
    await expect(copyWhenReady(Promise.reject(new Error('pods "x" not found')), c, Item)).rejects.toThrow(
      'pods "x" not found',
    );
    expect(c.got).toEqual([]);
  });

  it("rejects with a ClipboardError when the clipboard refuses", async () => {
    const c = clipboard({ write: false, failText: true });
    await expect(copyWhenReady(Promise.resolve("a"), c, Item)).rejects.toBeInstanceOf(ClipboardError);
    await expect(copyWhenReady(Promise.resolve("a"), undefined, Item)).rejects.toBeInstanceOf(ClipboardError);
  });
});

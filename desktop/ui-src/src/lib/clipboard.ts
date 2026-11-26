// Copying text the backend has yet to produce (#513). WebKitGTK only lets a
// page write the clipboard during the click itself, not after waiting for
// the backend. A `ClipboardItem` made from a promise is written within the
// click and filled in when the promise settles; where there is none, the
// text is written once it is there.

/** The parts of `navigator.clipboard` used here. */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
  write?(items: ClipboardItem[]): Promise<void>;
}

/** Put `text` on the clipboard as soon as it is there. Rejects with the
 *  promise's own error if it fails, and with "clipboard" if the write does. */
export async function copyWhenReady(
  text: Promise<string>,
  clipboard: ClipboardLike | undefined = globalThis.navigator?.clipboard,
  Item: typeof ClipboardItem | undefined = globalThis.ClipboardItem,
): Promise<string> {
  if (!clipboard) {
    await text;
    throw new ClipboardError();
  }
  if (clipboard.write && Item) {
    const blob = text.then((t) => new Blob([t], { type: "text/plain" }));
    // Keep a failure of `text` from showing up as an unhandled rejection;
    // it is reported below.
    blob.catch(() => {});
    try {
      await clipboard.write([new Item({ "text/plain": blob })]);
      return await text;
    } catch {
      // Not allowed (no click, or no promise support): the error of `text`
      // if it failed, else the plain write below.
    }
  }
  const t = await text;
  try {
    await clipboard.writeText(t);
  } catch {
    throw new ClipboardError();
  }
  return t;
}

/** The clipboard refused the text. */
export class ClipboardError extends Error {
  constructor() {
    super("Could not copy to the clipboard.");
  }
}

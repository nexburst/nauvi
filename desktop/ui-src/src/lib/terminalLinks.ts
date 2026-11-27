// Links in terminal output (#245). A pod's output can print an OSC 8
// hyperlink to anything (`javascript:`, `file:`, a custom scheme). xterm's
// default handler opens it with `window.open`; ours opens only http and https
// links, in the browser, through tauri-plugin-opener.

/** The URL to open for a link in terminal output, or `null` to ignore it:
 *  only absolute http(s) URLs without a user name or password. */
export function webLink(uri: string): string | null {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // `https://github.com@evil.example` reads like github.com; the opener's
  // scope denies these too.
  if (url.username || url.password) return null;
  return url.href;
}

// nauvi:// links (#548) open only from an Ask AI terminal, in the same
// window: the AI prints them after the objects it names (the nauvi skill).
// Pod shells, logs, the local shell and debug terminals ignore them, since
// their output comes from the cluster or from programs the user did not
// ask to steer the app. The backend checks every part of a link
// (`cmd_check_link`); here it is only recognised.

/** The longest link the backend reads. */
const MAX_APP_LINK = 2048;
/** A link's characters: unreserved ones, `%` escapes and `/` (as `links.rs`). */
const APP_LINK = /nauvi:\/\/[A-Za-z0-9\-._~%/]+/gi;

/** `uri` if it is a nauvi:// link to hand to the backend, else `null`. */
export function appLink(uri: string): string | null {
  const link = uri.trim();
  if (link.length > MAX_APP_LINK || !/^nauvi:\/\//i.test(link)) return null;
  return link;
}

/** A link found in a line of text: `end` is exclusive. */
export interface FoundLink {
  start: number;
  end: number;
  uri: string;
}

/** The nauvi:// links in one line of terminal text, by character position.
 *  A `.` or `/` at the end belongs to the sentence (no object name ends
 *  with one). */
export function findAppLinks(text: string): FoundLink[] {
  const found: FoundLink[] = [];
  for (const m of text.matchAll(APP_LINK)) {
    const uri = m[0].replace(/[./]+$/, "");
    if (uri.length > MAX_APP_LINK) continue;
    found.push({ start: m.index, end: m.index + uri.length, uri });
  }
  return found;
}

const decode = (part: string) => {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
};

/** Printable ASCII only: a link's text is the AI's (or the cluster's). */
const plain = (s: string) => s.replace(/[^\x20-\x7e]/g, "?");

/** What the tooltip says a link opens: "Open Pod demo/web (kind-x) in nauvi". */
export function describeAppLink(uri: string): string {
  const parts = uri.replace(/^nauvi:\/\//i, "").split("/").map(decode);
  if (parts.length !== 6) return `Open in nauvi: ${plain(uri)}`;
  const [context, , , kind, namespace, name] = parts;
  const where = namespace === "_" ? name : `${namespace}/${name}`;
  return `Open ${plain(kind)} ${plain(where)} (${plain(context)}) in nauvi`;
}

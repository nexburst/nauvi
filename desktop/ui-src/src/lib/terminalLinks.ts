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

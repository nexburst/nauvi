// The offer of a kubectl that matches the cluster (#331), shown above a
// local terminal when the setting is on.

import type { KubectlMatch } from "./bindings";

/** What the bar above a local terminal shows. */
export type OfferState =
  /** Nothing: the setting is off, the versions are close enough, or this
   *  shell already uses the matching kubectl. */
  | { kind: "none" }
  /** Offer the download (only on a click). */
  | { kind: "offer"; version: string; url: string; text: string }
  /** Downloaded, but this shell was started without it. */
  | { kind: "ready"; version: string; text: string }
  /** Nothing to offer, and why (unknown server version, unsupported CPU). */
  | { kind: "note"; text: string };

/** The kubectl on PATH, in words. */
function installedText(m: KubectlMatch): string {
  return m.installed ? `Your kubectl ${m.installed} is` : "No kubectl was found on your PATH; kubectl is";
}

/** What to show for `m`, in a shell that uses the downloaded kubectl
 *  `used` (`""`: the user's own). */
export function offerState(m: KubectlMatch, used: string): OfferState {
  if (!m.enabled || (used && used === m.server)) return { kind: "none" };
  if (m.note) return { kind: "note", text: `No matching kubectl to offer: ${m.note}` };
  if (!m.skew || !m.server) return { kind: "none" };
  if (m.downloaded)
    return {
      kind: "ready",
      version: m.server,
      text: `kubectl ${m.server} is downloaded. Open a new local terminal to use it there.`,
    };
  if (!m.url) return { kind: "none" };
  return {
    kind: "offer",
    version: m.server,
    url: m.url,
    text:
      `${installedText(m)} more than one minor version from the cluster's ${m.server}. ` +
      `Download kubectl ${m.server} from dl.k8s.io for this app's local terminals? ` +
      "Its SHA-256 is checked against the one dl.k8s.io publishes; your own kubectl is not changed.",
  };
}

/** The intro line of a shell that uses the downloaded kubectl `version`. */
export function kubectlIntro(version: string): string {
  if (!version) return "";
  return (
    `\x1b[90mkubectl ${version}, downloaded to match the cluster, is first on PATH in this shell ` +
    "(unless your shell's profile puts another folder first: check with `command -v kubectl`).\x1b[0m\r\n"
  );
}

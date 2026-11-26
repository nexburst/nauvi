// The first run (#485): the welcome screen, which says what nauvi found
// and how to begin, and the tips strip of the first few sessions.

import type { SourceInfo } from "./bindings";
import { shortcutHint, type Command } from "./keys";

/** The welcome screen's view id. */
export const WELCOME_VIEW = "welcome";

/**
 * Whether the main window starts on the welcome screen: on a first run
 * (`welcomed` is only false then), and whenever there is no context at all,
 * since then there is nothing else to show.
 */
export function shouldWelcome(welcomed: boolean, contexts: number, mainWindow: boolean): boolean {
  return mainWindow && (contexts === 0 || !welcomed);
}

/** One file of the default kubeconfig, and what nauvi found there. */
export interface Looked {
  path: string;
  found: string;
  ok: boolean;
}

/** The default kubeconfig's files (`KUBECONFIG` or `~/.kube/config`), and what each held. */
export function lookedAt(sources: readonly SourceInfo[]): Looked[] {
  return sources
    .filter((s) => s.kind === "kubeconfig")
    .map((s) => ({
      path: s.path,
      found: s.error ? s.error : s.contexts === 1 ? "1 context" : `${s.contexts} contexts`,
      ok: !s.error && s.contexts > 0,
    }));
}

/** What the catalog says when a kubeconfig file is not there (`src/catalog`). */
export const MISSING_FILE = "the file does not exist";

/**
 * Why there is no context, for the welcome's headline: no file at all
 * (`missing`), a file that could not be read (`unreadable`), files without
 * a context (`empty`), or not known until the sources are read (`reading`).
 */
export type NoContexts = "reading" | "missing" | "unreadable" | "empty";

export function noContexts(sources: readonly SourceInfo[]): NoContexts {
  if (sources.length === 0) return "reading";
  if (sources.every((s) => s.error === MISSING_FILE)) return "missing";
  if (sources.some((s) => s.error && s.error !== MISSING_FILE)) return "unreadable";
  return "empty";
}

/** The header status while there is no context, or `null` to leave it as it is. */
export function noContextsStatus(why: NoContexts): string | null {
  if (why === "missing") return "No kubeconfig";
  if (why === "unreadable") return "Kubeconfig error";
  if (why === "empty") return "No contexts";
  return null;
}

/** Whether a banner message is the "no kubeconfig found" the welcome says itself. */
export function isNoKubeconfig(message: string): boolean {
  return message.includes("No kubeconfig found (");
}

/** The files nauvi was asked to read besides the default ones (added in the catalog). */
export function addedSources(sources: readonly SourceInfo[]): SourceInfo[] {
  return sources.filter((s) => s.kind !== "kubeconfig");
}

/** A first step and the key that does it. */
export interface Step {
  title: string;
  keys: string;
  text: string;
}

/** The three things most first sessions want, with their shortcuts. */
export function nextSteps(mac: boolean): Step[] {
  const key = (c: Command) => shortcutHint(c, mac).split(" or ")[0];
  return [
    {
      title: "Find a pod",
      keys: key("palette"),
      text: "Type part of its name, or a kind like deploy, and press Enter.",
    },
    { title: "Read its logs", keys: key("rowLogs"), text: "On a pod in the table: its logs open in the dock below." },
    { title: "Open a shell", keys: key("rowShell"), text: "On a running pod: a terminal in its container." },
  ];
}

/** The tips strip: a key and what it does. */
export function tips(mac: boolean): { keys: string; text: string }[] {
  const key = (c: Command) => shortcutHint(c, mac).split(" or ")[0];
  return [
    { keys: key("chart"), text: "every kind" },
    { keys: key("palette"), text: "go anywhere" },
    { keys: key("focusFilter"), text: "filter the table" },
    { keys: key("help"), text: "all shortcuts" },
  ];
}

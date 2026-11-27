/**
 * Berths: the few places a user keeps at hand, as a fixed 48px column of
 * kubectl short codes. Only the user adds one (P, or the mark on the
 * current view) and any of them can be removed; the app never adds a berth,
 * so the column cannot grow on its own.
 */

import { APPLICATIONS_VIEW } from "./applications";
import { CATALOG_VIEW } from "./catalog";
import { PORT_FORWARDS_VIEW } from "./forwards";
import { HELM_VIEW } from "./helm";
import { HELM_CHARTS_VIEW } from "./helmCharts";
import { WORKLOADS_VIEW } from "./workloads";
import { WELCOME_VIEW } from "./welcome";
import { IMAGE_SECURITY_VIEW } from "./imageSecurity";

/** Keys 1 to 9: the Overview is always the first, so eight are the user's. */
export const BERTHS_MAX = 8;

/** A new install starts with the three kinds most sessions begin with. */
export const DEFAULT_BERTHS = ["v1/pods", "apps/v1/deployments", "v1/services"];

/** Views of their own (not kinds): their name and their code. */
const VIEWS: Record<string, [label: string, code: string]> = {
  overview: ["Overview", "ov"],
  [WORKLOADS_VIEW]: ["Workloads", "wl"],
  [APPLICATIONS_VIEW]: ["Applications", "app"],
  [HELM_VIEW]: ["Releases", "helm"],
  [HELM_CHARTS_VIEW]: ["Charts", "chrt"],
  [PORT_FORWARDS_VIEW]: ["Port Forwards", "pf"],
  [CATALOG_VIEW]: ["Catalog", "cat"],
  [WELCOME_VIEW]: ["Welcome", "hi"],
  [IMAGE_SECURITY_VIEW]: ["Image security", "sec"],
};

interface KindLike {
  id: string;
  label: string;
  short_names: readonly string[];
}

/** A view's name: the kind's label, or the name of a view of its own. */
export function viewLabel(view: string, kinds: readonly KindLike[]): string {
  return VIEWS[view]?.[0] ?? kinds.find((k) => k.id === view)?.label ?? view;
}

/**
 * What a berth says, in at most four letters: kubectl's shortest name for
 * the kind (po, svc, cm) when it is that short, else the start of the
 * label (dep, sec).
 */
export function berthCode(view: string, kinds: readonly KindLike[]): string {
  const own = VIEWS[view]?.[1];
  if (own) return own;
  const k = kinds.find((x) => x.id === view);
  if (!k) return "?";
  const short = [...k.short_names].sort((a, b) => a.length - b.length)[0];
  if (short && short.length <= 4) return short.toLowerCase();
  return k.label.replace(/[^A-Za-z]/g, "").toLowerCase().slice(0, 3);
}

/**
 * What a berth says while its kind is not known (no cluster yet, or one
 * that does not serve it): from the view's id, so the column is never a row
 * of question marks. "v1/pods" → "pod", "apps/v1/deployments" → "dep".
 */
export function idCode(view: string): string {
  const last = view.split("/").pop() ?? view;
  return last.replace(/[^A-Za-z]/g, "").toLowerCase().slice(0, 3) || "?";
}

/** Whether a view can be kept in a berth (the Overview always has one). */
export function pinnable(view: string): boolean {
  return !!view && view !== "overview" && view !== CATALOG_VIEW && view !== WELCOME_VIEW;
}

/** The berths with `view` added at the end, or unchanged when full or there. */
export function pinBerth(berths: readonly string[], view: string, max = BERTHS_MAX): { berths: string[]; full: boolean } {
  if (!pinnable(view) || berths.includes(view)) return { berths: [...berths], full: false };
  if (berths.length >= max) return { berths: [...berths], full: true };
  return { berths: [...berths, view], full: false };
}

export function unpinBerth(berths: readonly string[], view: string): string[] {
  return berths.filter((b) => b !== view);
}

/** A stored list, or the defaults when it is missing or unreadable. */
export function parseBerths(raw: string | null): string[] {
  if (raw === null) return [...DEFAULT_BERTHS];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter((v) => typeof v === "string").slice(0, BERTHS_MAX) : [...DEFAULT_BERTHS];
  } catch {
    return [...DEFAULT_BERTHS];
  }
}

// Whether the cluster shown answers (#462, #469). The header status
// (`app.status`) is the one source of truth: the views' watches and feeds
// set it, and the views that watch nothing get it from a light health
// check (`cmd_cluster_health`, the watches' /readyz probe) every
// `HEALTH_EVERY_MS`. The header, the banner, the tree's dot and the empty
// state of a view all read it.

import { CATALOG_VIEW } from "./catalog";
import { clusterError } from "./clusterError";
import { PORT_FORWARDS_VIEW } from "./forwards";
import { HELM_VIEW } from "./helm";
import { HELM_CHARTS_VIEW } from "./helmCharts";

/** A view's connection status, as `app.status` holds it. */
export interface Health {
  /** `null` while connecting, otherwise whether the cluster is reachable. */
  ok: boolean | null;
  text: string;
}

/** The views that start no watch: nothing else tells them the cluster went away. */
export const WATCHLESS_VIEWS: readonly string[] = [PORT_FORWARDS_VIEW, HELM_VIEW, HELM_CHARTS_VIEW, CATALOG_VIEW];

export function isWatchless(view: string): boolean {
  return WATCHLESS_VIEWS.includes(view);
}

/** Time between two health checks: the watches' liveness probe waits as long. */
export const HEALTH_EVERY_MS = 10_000;

/**
 * Status and banner text for a failed health check. The probe's own texts
 * ("Lost the connection to the cluster (…); retrying.") are shown as they
 * are; a client that could not be built (a login, a certificate) says so
 * like a failed view does.
 */
export function healthError(e: unknown): { status: string; message: string } {
  const message = String(e);
  if (message.endsWith("; retrying.")) return { status: "Cluster unreachable", message };
  return clusterError(e);
}

/** The dot of a cluster in the tree: the one shown follows the header. */
export type DotState = "connecting" | "connected" | "failed";

/** Whether `status` is a refusal (RBAC), which says nothing about reachability. */
function notAllowed(status: Health): boolean {
  return status.text.startsWith("Not allowed");
}

/** The tree dot of the cluster shown, from the header status. */
export function visibleDot(status: Health): DotState {
  if (status.ok === null) return "connecting";
  if (status.ok === false && !notAllowed(status)) return "failed";
  return "connected";
}

/**
 * What an empty view says while the cluster does not answer (the header's
 * text, e.g. "Cluster unreachable"), or `null` when it answers (or only
 * refused): the view then has its usual empty state.
 */
export function troubleTitle(status: Health): string | null {
  if (status.ok !== false || notAllowed(status)) return null;
  return status.text;
}

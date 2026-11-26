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
import { WELCOME_VIEW } from "./welcome";

/** A view's connection status, as `app.status` holds it. */
export interface Health {
  /** `null` while connecting, otherwise whether the cluster is reachable. */
  ok: boolean | null;
  text: string;
}

/** The views that start no watch: nothing else tells them the cluster went away. */
export const WATCHLESS_VIEWS: readonly string[] = [
  PORT_FORWARDS_VIEW,
  HELM_VIEW,
  HELM_CHARTS_VIEW,
  CATALOG_VIEW,
  WELCOME_VIEW,
];

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
  if (isProbeFailure(message)) return { status: "Cluster unreachable", message };
  return clusterError(e);
}

/**
 * Whether a failed health check is the probe's own "no answer" (checked
 * again in 10 s), not a client that could not be built: a failed login or
 * certificate is not checked again until Refresh, a cluster switch or the
 * window showing again, since each check would run the login command
 * (an exec plugin may open a browser) again.
 */
export function isProbeFailure(e: unknown): boolean {
  return String(e).endsWith("; retrying.");
}

/**
 * Whether the banner `message` only says the cluster did not answer (a
 * view's failed start or reconnect, a health check): it goes once a health
 * check gets an answer, whichever view set it.
 */
export function isReachabilityError(message: string): boolean {
  return (
    message.startsWith("Cannot reach the cluster") ||
    message.startsWith("Could not reach the cluster") ||
    message.startsWith("Lost the connection to the cluster") ||
    message.startsWith("The API server is not answering") ||
    isProbeFailure(message)
  );
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

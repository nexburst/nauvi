// Idle disconnect (ADR 0007, #333): the choices Settings offers and how a
// background cluster's state reads. The backend's reaper (`state/idle.rs`)
// does the disconnecting and sends `ClusterStateChanged`.

import type { ClusterStateChanged, Pin } from "./bindings";

export const DEFAULT_IDLE_MINUTES = 10;
/** The backend keeps the value within 0 (never) and a day. */
export const MAX_IDLE_MINUTES = 24 * 60;

/** The choices in Settings; 0 is never. */
export const IDLE_CHOICES = [1, 5, 10, 30, 60, 0];

export function idleChoiceLabel(minutes: number): string {
  if (minutes === 0) return "Never";
  if (minutes === 60) return "1 hour";
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** `value` as idle minutes in range (a bad one: the default). */
export function clampIdleMinutes(value: number): number {
  if (!Number.isFinite(value) || value < 0) return DEFAULT_IDLE_MINUTES;
  return Math.round(Math.min(value, MAX_IDLE_MINUTES));
}

const PINS: Record<Pin, string> = {
  "port-forward": "a port-forward",
  terminal: "a terminal",
  "local-shell": "a local shell",
  "log-stream": "a log stream",
  drain: "a drain",
  "browser-login": "its browser login",
};

/** "a port-forward and a log stream". */
export function pinsText(pins: readonly Pin[]): string {
  const words = pins.map((p) => PINS[p]);
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** What a background cluster's state says, in a sentence. */
export function clusterStateText(change: Pick<ClusterStateChanged, "state" | "pinnedBy">): string {
  if (change.state === "idle") return "Disconnected while idle; it connects again when you use it.";
  if (change.state === "disconnected") return "Disconnected.";
  if (change.pinnedBy.length) return `Connected, kept by ${pinsText(change.pinnedBy)}.`;
  return "Connected.";
}

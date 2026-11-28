// Warning groups (#605, CONTEXT.md): warning events with the same reason on
// objects of one owner, one row each. Shared by the Overview and the
// Workloads overview (#606). Pure functions; WarningGroups.svelte draws them.

import type { EventInfo } from "./bindings";
import { eventSummary, reasonWords } from "./eventText";

export interface WarningGroup {
  /** Unique: the reason and the owner (or the object). */
  key: string;
  reason: string;
  /** The newest event of the group: its object is the one the row names. */
  newest: EventInfo;
  /** Its events, newest first. */
  events: EventInfo[];
  /** How many distinct objects the events are about. */
  objects: number;
  /** The owner the events' objects share (`Deployment`, `web`), or "". */
  ownerKind: string;
  ownerName: string;
  /** How often it happened: the events' counts, summed. */
  count: number;
  /** When it last happened (unix seconds). */
  time: number;
}

const objectKey = (e: EventInfo) => `${e.object_kind}/${e.object_namespace}/${e.object_name}`;

/**
 * Group warning events by reason and owning object: the events of the pods
 * of one Deployment with one reason are one group, an event about an object
 * without a known owner is grouped with the other events of that object.
 * Newest group first.
 */
export function groupWarnings(events: readonly EventInfo[]): WarningGroup[] {
  const byKey = new Map<string, WarningGroup>();
  const seen = new Map<string, Set<string>>();
  const sorted = [...events].sort((a, b) => b.time - a.time || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const e of sorted) {
    const owned = e.owner_kind !== "" && e.owner_name !== "";
    const who = owned ? `${e.owner_kind}/${e.object_namespace}/${e.owner_name}` : objectKey(e);
    const key = `${e.reason}|${who}`;
    let g = byKey.get(key);
    if (!g) {
      g = {
        key,
        reason: e.reason,
        newest: e,
        events: [],
        objects: 0,
        ownerKind: owned ? e.owner_kind : "",
        ownerName: owned ? e.owner_name : "",
        count: 0,
        time: e.time,
      };
      byKey.set(key, g);
      seen.set(key, new Set());
    }
    g.events.push(e);
    g.count += Math.max(1, e.count);
    const objects = seen.get(key)!;
    objects.add(objectKey(e));
    g.objects = objects.size;
  }
  return [...byKey.values()];
}

/**
 * The message without the `name_namespace(uid)` the kubelet writes after a
 * pod's name: "… in pod web-5d8f-abc_demo(3f2a…)" reads "… in pod web-5d8f-abc".
 */
export function stripPodIds(message: string): string {
  return message.replace(/([a-z0-9][a-z0-9.-]*)_[a-z0-9][a-z0-9-]*\([0-9a-f]{8}-[0-9a-f-]{27}\)/g, "$1");
}

/** What a group is about: "Pod web-5d8f-abc", or "3 pods of Deployment web". */
export function warningSubject(g: WarningGroup): string {
  const e = g.newest;
  // Only a group with an owner holds several objects.
  if (g.objects > 1) return `${g.objects} ${e.object_kind.toLowerCase()}s of ${g.ownerKind} ${g.ownerName}`;
  return `${e.object_kind} ${e.object_name}`.trim();
}

/** The reason in words ("Back-off restarting"), from the newest message. */
export function warningReason(g: WarningGroup): string {
  return reasonWords(g.reason, g.newest.message);
}

/** The one-line summary of the newest message, for the row's title and the
 *  expanded row; "" when the message says nothing more than itself. */
export function warningSummary(g: WarningGroup): string {
  return eventSummary(g.reason, stripPodIds(g.newest.message));
}

/** "212×": how often, or "" for once. */
export function timesText(count: number): string {
  return count > 1 ? `${count}×` : "";
}

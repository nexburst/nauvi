// The sidebar's problem badges, by kind id. Fed by the watches that already
// run (the table on screen, the Overview); see `lib/problems.ts`.

import type { Badge, BadgeSource } from "../problems";

export const problems = $state({ byKind: {} as Record<string, Badge> });

/** A live count from `source`; 0 removes the badge. */
export function reportProblems(kindId: string, count: number, scope: string, source: BadgeSource) {
  const old = problems.byKind[kindId];
  if (count === 0) {
    if (old) delete problems.byKind[kindId];
    return;
  }
  if (old && old.live && old.count === count && old.scope === scope && old.source === source) return;
  problems.byKind[kindId] = { count, scope, source, live: true, at: Date.now() };
}

/** `source` stopped watching `kindId`: keep the count, marked as stale. */
export function staleProblems(kindId: string, source: BadgeSource) {
  const b = problems.byKind[kindId];
  if (b && b.source === source && b.live) problems.byKind[kindId] = { ...b, live: false, at: Date.now() };
}

/** A context switch: the counts are of another cluster. */
export function clearProblems() {
  problems.byKind = {};
}

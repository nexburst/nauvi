/**
 * The header pill that counts the problem pods (#491): its words, plain
 * (no "deck", no "watch"), and what its tooltip says a click does.
 */

/** "No problems", "1 problem pod", "4 problem pods"; "Problem pods" when not counted (null) for this cluster yet. */
export function pillText(total: number | null): string {
  if (total === null) return "Problem pods";
  if (total <= 0) return "No problems";
  return total === 1 ? "1 problem pod" : `${total} problem pods`;
}

/** The pill's tooltip: what it counts and what a click shows. */
export function pillTitle(total: number | null): string {
  if (total === null) return "Not counted yet for this cluster: the Overview counts them. Click for a way there.";
  if (total <= 0) return "No pod needs a look. Click for the list and the watch log.";
  return total === 1 ? "1 pod needs a look. Click to see it." : `${total} pods need a look. Click to see them.`;
}

/** One line on why a problem pod is listed: "CrashLoopBackOff · 6 restarts". */
export function problemLine(p: { reason: string; restarts: number }): string {
  if (p.restarts <= 0) return p.reason;
  return `${p.reason} · ${p.restarts} ${p.restarts === 1 ? "restart" : "restarts"}`;
}

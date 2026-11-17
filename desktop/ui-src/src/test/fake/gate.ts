// The read-only / protected gate of mutating commands (#338), as the
// backend's `state/mutation.rs` runs it before the command.

import type { FakeState } from "./state";

/** The read-only reason of the window's context, if it is read-only. */
export function readOnlyReason(s: FakeState): string | undefined {
  const id = s.cluster.contexts.find((c) => c.current)?.name ?? "";
  if (s.cluster.settings.contexts[id]?.mode !== "readOnly") return undefined;
  const name = s.cluster.contexts.find((c) => c.name === id)?.context ?? id;
  return `${name} is read-only: changes to this cluster are turned off`;
}

/** Why the backend would refuse this call (`undefined`: it goes ahead). */
export function gateRefusal(s: FakeState, target: unknown, args: Record<string, unknown>): string | undefined {
  const t = target as string | { id: string; confirm: string };
  const given = typeof t === "string" ? t : t.id;
  const confirm = typeof t === "string" ? "" : t.confirm;
  const current = s.cluster.contexts.find((c) => c.current)?.name ?? "";
  const id = given || current;
  const mode = s.cluster.settings.contexts[id]?.mode ?? "normal";
  const name = s.cluster.contexts.find((c) => c.name === id)?.context ?? id;
  const request = args.request as { dry_run?: unknown } | undefined;
  const dryRun = args.dryRun === true || request?.dry_run === true;
  if (mode === "readOnly") return `${name} is read-only: changes to this cluster are turned off`;
  if (mode !== "protected" || dryRun || (name && confirm === name)) return undefined;
  return confirm
    ? `${name} is protected: the confirmation does not match the context name, so nothing was changed`
    : `${name} is protected: type the context name to confirm this change`;
}

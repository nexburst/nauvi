// The time in the status bar (#387): what it means depends on the view's
// state, so the label says which.
//
// - Live (a watch or feed connected): `Live · last change 14:02:10`, the
//   last time the rows changed (a batch, a re-list) or the connection came
//   back. The rows are current however old that time is; metrics polls and
//   ticking ages are not changes.
// - Not connected (reconnecting, failed, given up): `Stale since 14:02:10`,
//   the last time the rows were known to be current.
// - Otherwise (polled kinds, views that load once): `Updated 14:02:10`.

export interface ViewStatus {
  ok: boolean | null;
  text: string;
}

/** The footer's time label; `""` before the view has any data. */
export function statusTimeLabel(status: ViewStatus, at: number, time: (ms: number) => string): string {
  if (!at) return "";
  if (status.ok === false) return `Stale since ${time(at)}`;
  if (status.ok === true && status.text === "Live") return `Live · last change ${time(at)}`;
  return `Updated ${time(at)}`;
}

/**
 * Whether a status change means the view's data was just confirmed
 * current: it became Live from any other state (connecting, reconnecting,
 * failed). A watch that resumes without a re-list sends no batch, so this
 * is the only sign that it is current again.
 */
export function becameLive(before: ViewStatus, after: ViewStatus): boolean {
  return after.ok === true && before.ok !== true;
}

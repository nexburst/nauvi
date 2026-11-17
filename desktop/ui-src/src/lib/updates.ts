// In-app updates (#30): the texts of the update banner and of the Settings
// page's check. The check, the download and the install run in the backend
// (`commands/updater.rs`); `stores/updates.svelte.ts` holds the state.

import type { UpdateCheck, UpdateProgress } from "./bindings";

/** Megabytes with one decimal ("13.5 MB"). */
export function formatMB(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** 0–100, or null while the size is not known. */
export function progressPercent(p: UpdateProgress): number | null {
  if (p.phase === "installing") return 100;
  if (p.total <= 0) return null;
  return Math.min(100, Math.floor((p.downloaded / p.total) * 100));
}

/** "Downloading… 45% (6.1 of 13.5 MB)", or "Installing…". */
export function progressLabel(p: UpdateProgress): string {
  if (p.phase === "installing") return "Installing…";
  const pct = progressPercent(p);
  if (pct === null) return p.downloaded > 0 ? `Downloading… ${formatMB(p.downloaded)}` : "Downloading…";
  return `Downloading… ${pct}% (${formatMB(p.downloaded).replace(" MB", "")} of ${formatMB(p.total)})`;
}

/** The one-line result of a check, as the Settings page shows it. */
export function checkSummary(c: UpdateCheck): string {
  switch (c.status) {
    case "available":
      return `nauvi ${c.version} is available (you have ${c.current_version}).`;
    case "up_to_date":
      return `nauvi ${c.current_version} is the latest version.`;
    case "skipped":
      return c.note;
  }
}

/** Whether the banner offers the update: only for a newer version not dismissed. */
export function showsBanner(c: UpdateCheck | null, dismissed: string): boolean {
  return !!c && c.status === "available" && c.version !== dismissed;
}

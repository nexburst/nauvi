// CSV export of a resource table (#221): the rows and columns on screen, as
// RFC 4180 text that is safe to open in a spreadsheet.

import type { Column, Ctx, Row } from "./columns";

/**
 * Cells a spreadsheet may read as a formula: `=`, `+`, `-` or `@` first, also
 * after leading whitespace (which some spreadsheets trim), and a leading tab
 * or CR (which some strip). Cluster data such as
 * names, labels and annotations is set by whoever can write to the cluster,
 * so a cell like `=HYPERLINK(...)` must stay text (OWASP "CSV injection").
 */
const FORMULA_START = /^\s*[=+\-@]|^[\t\r]/;

/** One field: formula starts get a leading `'`; quoted when RFC 4180 needs it. */
export function csvField(value: string): string {
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** RFC 4180: fields separated by commas, records ended by CRLF. */
export function toCsv(records: readonly (readonly string[])[]): string {
  return records.map((r) => r.map(csvField).join(",") + "\r\n").join("");
}

/** The header and one record per row, each cell as the table shows it. */
export function tableCsv(columns: readonly Column[], rows: readonly Row[], ctx: Ctx): string {
  return toCsv([columns.map((c) => c.label), ...rows.map((r) => columns.map((c) => c.text(r, ctx)))]);
}

/** `pods_kind-dev_2026-11-16T10-30-00Z.csv`: what, where and when. */
export function csvFilename(label: string, context: string, at: Date): string {
  const stamp = at
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replaceAll(":", "-");
  const part = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|-+$/g, "");
  return [part(label), part(context), stamp].filter(Boolean).join("_") + ".csv";
}

/**
 * "Saved 3 rows to Downloads/pods.csv": the folder and the file (the full
 * path goes in the note's tooltip).
 */
export function savedNote(rows: number, path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  const where = parts.slice(-2).join("/") || path;
  return `Saved ${rows} ${rows === 1 ? "row" : "rows"} to ${where}`;
}

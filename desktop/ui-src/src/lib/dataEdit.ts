// Pure logic of the Secret / ConfigMap data editor (`KeyValueData.svelte`,
// #224): pending edits per key, the changes a save sends (only the edited
// keys) and key validation.

import type { DataChange, DataEncoding, DataEntry, DataField } from "./bindings";

/** A pending edit of one key. */
export interface Edit {
  field: DataField;
  /** The new value (text, or base64 if `encoding` is "base64"). */
  value: string;
  encoding: DataEncoding;
  /** Remove the key. */
  delete: boolean;
  /** A key that does not exist yet. */
  added: boolean;
}

/** The changes a save sends, sorted by key: only the edited keys. */
export function changesOf(edits: ReadonlyMap<string, Edit>): DataChange[] {
  return [...edits.entries()]
    .filter(([, e]) => !(e.added && e.delete))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, e]) => ({
      key,
      field: e.field,
      delete: e.delete,
      value: e.delete ? "" : e.value,
      encoding: e.encoding,
    }));
}

/** "2 changed, 1 added, 1 removed". */
export function summaryOf(edits: ReadonlyMap<string, Edit>): string {
  let changed = 0;
  let added = 0;
  let removed = 0;
  for (const e of edits.values()) {
    if (e.added) added++;
    else if (e.delete) removed++;
    else changed++;
  }
  const parts: string[] = [];
  if (changed) parts.push(`${changed} changed`);
  if (added) parts.push(`${added} added`);
  if (removed) parts.push(`${removed} removed`);
  return parts.join(", ");
}

/**
 * `edits` with the value of `key` set to `value`. Typing the original
 * value back (`original`, when known) drops the edit, so the editor is
 * clean again.
 */
export function withValue(
  edits: ReadonlyMap<string, Edit>,
  entry: Pick<DataEntry, "key" | "field">,
  value: string,
  encoding: DataEncoding,
  original: { value: string; encoding: DataEncoding } | null,
): Map<string, Edit> {
  const next = new Map(edits);
  const prev = next.get(entry.key);
  const added = prev?.added ?? false;
  if (!added && original && original.value === value && original.encoding === encoding) {
    next.delete(entry.key);
  } else {
    next.set(entry.key, { field: entry.field, value, encoding, delete: false, added });
  }
  return next;
}

/** Strict base64 (whitespace allowed between characters). */
export function isBase64(s: string): boolean {
  const t = s.replace(/\s+/g, "");
  return t.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(t);
}

/** Why `key` cannot be added (empty: it can). `taken`: keys in use. */
export function keyError(key: string, taken: ReadonlySet<string>): string {
  if (!key) return "Enter a key.";
  if (key.length > 253) return "A key has at most 253 characters.";
  if (key === "." || key === "..") return `"${key}" is not a valid key.`;
  const bad = [...key].find((c) => !/[A-Za-z0-9._-]/.test(c));
  if (bad !== undefined) return `"${bad}" is not allowed: use letters, digits, "-", "_" and ".".`;
  if (taken.has(key)) return `"${key}" already exists.`;
  return "";
}

/** "7 bytes", "1 byte", "2.0 KiB". */
export function sizeText(bytes: number): string {
  if (bytes === 1) return "1 byte";
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

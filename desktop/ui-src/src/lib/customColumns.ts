// Custom table columns (#547): from a label, an annotation or a simple
// field path, per kind (and per context for a kind defined by a CRD).
// The backend builds their cells with the rows it already watches
// (`src/resources/custom_columns.rs`, whose checks these repeat so the
// chooser can say what is wrong as you type).

import type { ColumnDef, CustomColumn, CustomSource, ResourceKind, ResourceRef } from "./bindings";

/** At most this many per kind (`MAX_CUSTOM_COLUMNS`). */
export const MAX_CUSTOM = 10;
/** The longest header name (`MAX_CUSTOM_LABEL`). */
export const MAX_CUSTOM_LABEL = 64;
const MAX_SOURCE = 256;

export const SOURCE_LABELS: Record<CustomSource, string> = {
  label: "Label",
  annotation: "Annotation",
  field: "Field path",
};

export const SOURCE_HINTS: Record<CustomSource, string> = {
  label: "app.kubernetes.io/version",
  annotation: "deployment.kubernetes.io/revision",
  field: ".spec.priorityClassName",
};

/** The table column key of a custom column. */
export function customKey(id: string): string {
  return `custom:${id}`;
}

/** Whether a column key is a custom column's. */
export function isCustomKey(key: string): boolean {
  return key.startsWith("custom:");
}

const nameChar = /[A-Za-z0-9_-]/;

function badChar(c: string): string {
  const shown = /\s/.test(c) ? "A space" : `"${c}"`;
  return (
    `${shown} cannot be in a field name. Field names have letters, digits, "-" and "_"; ` +
    "for a label or an annotation, pick Label or Annotation instead."
  );
}

/** What is wrong with a field path, in plain words ("" if nothing). */
export function fieldPathError(path: string): string {
  const p = path.trim();
  if (!p) return "Type a field path, for example .spec.priorityClassName.";
  if ([...p].length > MAX_SOURCE) return `The path is too long: at most ${MAX_SOURCE} characters.`;
  if (!p.startsWith(".")) return "A field path starts with a dot, for example .status.podIP.";
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === ".") {
      i++;
      const start = i;
      while (i < p.length && nameChar.test(p[i])) i++;
      if (i === start) {
        const next = p[i];
        if (next === undefined || next === "." || next === "[") {
          const after = p.slice(0, start - 1);
          return after
            ? `A field name is missing after "${after}.".`
            : "A field name must follow the first dot, for example .metadata.name.";
        }
        return badChar(next);
      }
    } else if (c === "[") {
      const end = p.indexOf("]", i + 1);
      if (end < 0) return 'A "[" is not closed with "]".';
      const inner = p.slice(i + 1, end);
      if (!/^\s*\d+\s*$/.test(inner)) return `Only numbers work in brackets, like [0]; "[${inner}]" is not supported.`;
      i = end + 1;
    } else {
      return badChar(c);
    }
  }
  return "";
}

function keyError(what: string, key: string): string {
  const k = key.trim();
  if (!k) return `Type the ${what} key, for example app.kubernetes.io/version.`;
  if ([...k].length > MAX_SOURCE) return `The ${what} key is too long: at most ${MAX_SOURCE} characters.`;
  if (/[\s\p{Cc}]/u.test(k)) return `A ${what} key has no spaces.`;
  return "";
}

/** Said for a column that would show a Secret's data (#571). */
export const SECRET_DATA_REFUSED =
  "A column on Secrets cannot show their data: open the Secret and press Reveal to see it.";

/** Annotations that hold a copy of the whole object (`COPY_ANNOTATIONS`). */
const COPY_ANNOTATIONS = ["kubectl.kubernetes.io/last-applied-configuration", "kapp.k14s.io/original"];

/** Whether a valid column would read a Secret's data, which the Secret
 *  panel shows only after Reveal (#571; `check_custom_column_for`): a field
 *  path under `.data` or `.stringData`, or an annotation that holds a copy
 *  of the Secret, compared without case. */
function readsSecretData(resource: Pick<ResourceRef, "group" | "kind">, source: CustomSource, value: string): boolean {
  if (resource.group !== "" || resource.kind !== "Secret") return false;
  const v = value.trim().toLowerCase();
  if (source === "annotation") return COPY_ANNOTATIONS.includes(v);
  if (source === "field") return /^\.(data|stringdata)(?![A-Za-z0-9_-])/.test(v);
  return false;
}

/** What is wrong with the value of a column from `source` ("" if nothing),
 *  in the table of `resource` if given. */
export function sourceError(
  source: CustomSource,
  value: string,
  resource?: Pick<ResourceRef, "group" | "kind">,
): string {
  const err = source === "field" ? fieldPathError(value) : keyError(source, value);
  if (err) return err;
  return resource && readsSecretData(resource, source, value) ? SECRET_DATA_REFUSED : "";
}

/** What is wrong with a column the user is adding or editing, among the
 *  kind's `others`, in the table of `resource` if given ("" if nothing). */
export function customColumnError(
  c: Pick<CustomColumn, "label" | "source" | "value">,
  others: readonly string[],
  resource?: Pick<ResourceRef, "group" | "kind">,
): string {
  const label = c.label.trim();
  if (!label) return "Give the column a name.";
  if ([...label].length > MAX_CUSTOM_LABEL) return `The name is too long: at most ${MAX_CUSTOM_LABEL} characters.`;
  if (others.some((o) => o.trim().toLowerCase() === label.toLowerCase()))
    return `The table already has a column named "${label}".`;
  return sourceError(c.source, c.value, resource);
}

/** A new id, unique among `existing` ones. */
export function newCustomId(existing: readonly CustomColumn[]): string {
  let n = existing.length + 1;
  const taken = new Set(existing.map((c) => c.id));
  while (taken.has(`c${n}`)) n++;
  return `c${n}`;
}

/** The custom columns of `kind` that apply in `context`: all of them for a
 *  built-in kind; for a CRD's kind, those added in this context. */
export function customFor(
  custom: readonly CustomColumn[] | undefined,
  kind: Pick<ResourceKind, "crd">,
  context: string,
): CustomColumn[] {
  const all = custom ?? [];
  return kind.crd ? all.filter((c) => !c.context || c.context === context) : [...all];
}

/** What a custom column is read from, for its tooltip and the chooser. */
export function customSourceText(c: Pick<CustomColumn, "source" | "value">): string {
  return `${SOURCE_LABELS[c.source]}: ${c.value.trim()}`;
}

/** A string that changes whenever what the backend extracts does (not
 *  when a column is only renamed). */
export function customSignature(custom: readonly CustomColumn[]): string {
  return JSON.stringify(custom.map((c) => [c.id, c.source, c.value.trim()]));
}

const kinds = new WeakMap<ResourceKind, Map<string, ResourceKind>>();

/**
 * `kind` with its custom columns after its own, in the order the backend
 * fills their cells (`cmd_watch_start`). The same object for the same
 * columns, so what is cached per kind (`columnsFor`) stays cached.
 */
export function withCustom(kind: ResourceKind, custom: readonly CustomColumn[]): ResourceKind {
  if (custom.length === 0) return kind;
  let byKind = kinds.get(kind);
  if (!byKind) kinds.set(kind, (byKind = new Map()));
  const sig = JSON.stringify(custom.map((c) => [c.id, c.label.trim()]));
  let out = byKind.get(sig);
  if (!out) {
    const defs: ColumnDef[] = custom.map((c) => ({
      key: customKey(c.id),
      label: c.label.trim(),
      kind: "text",
      default_hidden: false,
    }));
    out = { ...kind, columns: [...kind.columns, ...defs] };
    byKind.set(sig, out);
  }
  return out;
}

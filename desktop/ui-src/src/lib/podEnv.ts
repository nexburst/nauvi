import type { EnvFromGroup, EnvValue, ResourceRef } from "./bindings";

/** The Secret kind, for revealing one key through `cmdRevealDataValue`. */
export const SECRET_REF: ResourceRef = {
  group: "",
  version: "v1",
  kind: "Secret",
  plural: "secrets",
  namespaced: true,
};

/** What replaces a hidden value. */
export const MASK = "••••";

/** Longer than this, a value starts folded to one line. */
export const LONG_VALUE = 60;

const KIND_TEXT: Record<string, string> = {
  configmap: "ConfigMap",
  secret: "Secret",
};

/** Where a row's value comes from: `ConfigMap app-cfg/level`,
 *  `Secret db/password`, `field metadata.name`, `resource limits.cpu`;
 *  empty for a literal. */
export function envValueSource(r: EnvValue): string {
  switch (r.kind) {
    case "configmap":
    case "secret":
      return `${KIND_TEXT[r.kind]} ${r.object}/${r.key}`;
    case "field":
      return `field ${r.key}`;
    case "resource":
      return `resource ${r.key}`;
    case "unknown":
      return "unknown source";
    default:
      return "";
  }
}

/** `all of ConfigMap app-cfg (prefix CFG_, optional)`. */
export function envGroupTitle(g: EnvFromGroup): string {
  const what = g.kind === "unknown" ? "an unknown source" : `${KIND_TEXT[g.kind]} ${g.object}`;
  const extra = [g.prefix ? `prefix ${g.prefix}` : "", g.optional ? "optional" : ""].filter(Boolean);
  return `all of ${what}${extra.length ? ` (${extra.join(", ")})` : ""}`;
}

/** The key a revealed value is kept under: unique within one container. */
export function envRowId(group: number | "env", index: number): string {
  return `${group}|${index}`;
}

/** The text in the value column of a row that is not revealed. */
export function envShownValue(r: EnvValue): string {
  if (r.hidden) return MASK;
  if (r.kind === "resource") return `resourceFieldRef(${r.key})`;
  if (r.kind === "field" && !r.value) return `fieldRef(${r.key})`;
  return r.value;
}

/** Control characters (C0, C1) other than newline and tab, and format
 *  characters (bidi overrides and isolates, zero-width): the classes
 *  `askAi.ts` drops from names. */
const INVISIBLE = /[\p{Cf}\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

/** `text` with every invisible or bidi character shown as `\u{202E}`, so a
 *  value from the cluster cannot reorder or hide what is on screen.
 *  Newlines and tabs stay (multi-line values keep their shape). */
export function visibleText(text: string): string {
  return text.replace(INVISIBLE, (c) => `\\u{${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}}`);
}

/** Number of variables the container gets (overridden ones not counted). */
export function envCount(groups: EnvFromGroup[], env: EnvValue[]): number {
  return [...groups.flatMap((g) => g.rows), ...env].filter((r) => !r.overridden).length;
}

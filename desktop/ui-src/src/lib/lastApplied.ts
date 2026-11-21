/** kubectl's copy of the object as last applied (#409). The backend masks
 *  it before it reaches the panel; the panel collapses it by default. */
export const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";

/** What the backend puts where it hid a value (`src/resources/mask.rs`). */
const MASK = "••••";

/** Size of `text` in UTF-8, as "512 B" or "3.4 KB". */
export function sizeText(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** `text` indented if it is JSON, as it is otherwise. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** Whether the backend hid anything in `text`. */
export function hasMasked(text: string): boolean {
  return text.includes(MASK);
}

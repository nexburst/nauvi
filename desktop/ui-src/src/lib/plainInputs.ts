// Every text field of the app takes names, paths, ports, labels or YAML, not
// prose: macOS WKWebView would otherwise autocapitalise ("shell" -> "Shell"),
// autocorrect and spellcheck them, and its suggestion bubble swallows the
// next click (#176). Instead of repeating four attributes on every <input>,
// `plainInputs` sets them on each text field as it is added to the page. A
// field that really takes prose opts out with `data-prose` (on it or an
// ancestor); an attribute a field already sets is kept.

export const PLAIN_ATTRS: Record<string, string> = {
  autocapitalize: "off",
  autocorrect: "off",
  spellcheck: "false",
  autocomplete: "off",
};

/** `<input>` types that take typed text. */
const TEXT_TYPES = new Set(["", "text", "search", "url", "email", "tel", "password", "number"]);

export function isTextField(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true;
  return el instanceof HTMLInputElement && TEXT_TYPES.has((el.getAttribute("type") ?? "").toLowerCase());
}

/** Turn autocorrect, autocapitalisation, spellcheck and autofill off on `el`. */
export function makePlain(el: Element) {
  if (!isTextField(el) || el.closest("[data-prose]")) return;
  for (const [name, value] of Object.entries(PLAIN_ATTRS)) {
    if (!el.hasAttribute(name)) el.setAttribute(name, value);
  }
}

function applyTree(node: Node) {
  if (!(node instanceof Element)) return;
  makePlain(node);
  for (const el of node.querySelectorAll("input, textarea")) makePlain(el);
}

/**
 * Keep every text field under `root` plain, now and as fields are added
 * (a MutationObserver runs before anything can be typed into them; focus is
 * a fallback). Returns a function that stops it.
 */
export function plainInputs(root: Element): () => void {
  applyTree(root);
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      if (m.type === "attributes") makePlain(m.target as Element);
      else m.addedNodes.forEach(applyTree);
    }
  });
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["type"] });
  const onFocus = (e: FocusEvent) => {
    if (e.target instanceof Element) makePlain(e.target);
  };
  root.addEventListener("focusin", onFocus as EventListener, true);
  return () => {
    observer.disconnect();
    root.removeEventListener("focusin", onFocus as EventListener, true);
  };
}

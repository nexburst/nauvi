// Reading the resource table, the namespace picker and the error banner.
// WebKitWebDriver's getText() is unreliable inside the table, so these read
// innerText / textContent through app.js().

import { By } from "selenium-webdriver";

/**
 * The rendered table: its column labels and every rendered row as an object
 * keyed by column label (the virtual list renders only the rows in view).
 */
export function tableData(app) {
  return app.js(`
    const table = document.querySelector('[data-testid="resource-table"]');
    if (!table) return null;
    const headers = Array.from(table.querySelectorAll('.head [role="columnheader"]'), (h) =>
      h.textContent.replace(/[▲▼]/g, "").trim());
    const rows = Array.from(table.querySelectorAll('[data-testid="resource-row"]'), (r) => {
      const cells = r.querySelectorAll('[role="gridcell"]');
      const o = { _selected: r.classList.contains("selected"), _problem: r.dataset.problem ?? "" };
      // A cut cell (#482) has its whole value as its name.
      headers.forEach((h, i) => { if (h) o[h] = cells[i]?.getAttribute("aria-label") ?? cells[i]?.textContent.trim() ?? ""; });
      return o;
    });
    const empty = table.querySelector(".empty")?.textContent.trim() ?? "";
    return { headers, rows, empty };
  `);
}

/** The visible error banner's text, or "". */
export function bannerText(app) {
  return app.js(`
    return Array.from(document.querySelectorAll('[role="alert"]'))
      .filter((e) => e.offsetParent !== null)
      .map((e) => e.innerText.trim())
      .join("\\n");
  `);
}

/** The namespace picker's button label ("All namespaces", "demo", "2 namespaces", ...). */
export function namespaceLabel(app) {
  return app.js(`return document.querySelector('button[aria-label="Namespace"]')?.textContent.trim() ?? ""`);
}

/** Is the toolbar's namespace control shown (it is only for namespaced kinds)? */
export function namespaceControlVisible(app) {
  return app.js(`
    const b = document.querySelector('button[aria-label="Namespace"]');
    return !!b && getComputedStyle(b).visibility !== "hidden" && b.offsetParent !== null;
  `);
}

/** Open the namespace popover (if closed) and return it. */
export async function openNamespacePicker(app) {
  const trigger = await app.find(By.css('button[aria-label="Namespace"]'));
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  return app.find(By.css('[role="dialog"][aria-label="Namespaces"]'));
}

/** Close the namespace popover with Escape. */
export async function closeNamespacePicker(app) {
  await app.js(`
    const pop = document.querySelector('[role="dialog"][aria-label="Namespaces"]');
    pop?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  `);
  await app.waitFor(async () => (await app.driver.findElements(By.css('[aria-label="Namespaces"]'))).length === 0, {
    message: "the namespace popover to close",
  });
}

/** The namespaces offered in the open popover. */
export function namespaceOptions(app) {
  return app.js(`
    return Array.from(document.querySelectorAll('[aria-label="Namespace list"] label'), (l) => l.textContent.trim());
  `);
}

/**
 * Select exactly `namespaces` ([] for all) through the popover, the way a
 * user clicks the checkboxes, and close it.
 */
export async function pickNamespaces(app, namespaces) {
  await openNamespacePicker(app);
  // "All namespaces" clears the selection.
  await app.js(`
    const all = document.querySelector('[aria-label="Namespaces"] .option.all input');
    if (!all.checked) all.click();
  `);
  for (const ns of namespaces) {
    await app.waitFor(
      () =>
        app.js(
          `const l = Array.from(document.querySelectorAll('[aria-label="Namespace list"] label'))
             .find((l) => l.textContent.trim() === arguments[0]);
           if (!l) return false;
           const input = l.querySelector("input");
           if (!input.checked) input.click();
           return true;`,
          ns,
        ),
      { message: `namespace ${ns} in the picker` },
    );
  }
  await closeNamespacePicker(app);
}

/** The chips of the selected namespaces (shown when more than one is picked). */
export function namespaceChips(app) {
  return app.js(`
    return Array.from(document.querySelectorAll('[aria-label="Selected namespaces"] li'), (l) =>
      l.firstChild.textContent.trim());
  `);
}

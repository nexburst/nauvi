// The sidebar's cluster tree (ADR 0007, #333): its nodes, their state, and
// expanding, selecting and disconnecting them as a click would.

/** CSS selector of cluster `id`'s node. */
export const treeNode = (id) => `[data-testid="cluster-node"][data-cluster=${JSON.stringify(id)}]`;

/** `visible`, `idle`, `consent`, `connecting`, `connected` or `failed` ("" without the node). */
export function nodeState(app, id) {
  return app.js(`return document.querySelector(arguments[0])?.dataset.state ?? ""`, treeNode(id));
}

/** Wait until node `id` is in `state`. */
export function waitNodeState(app, id, state, timeout = 60_000) {
  return app.waitFor(async () => (await nodeState(app, id)) === state, { timeout, message: `${id} ${state}` });
}

/** Click a button of node `id` by its accessible name. The row's buttons
 *  show on hover (WebDriver counts them as not displayed until then), so
 *  it is found and clicked in the page. */
async function clickIn(app, id, name) {
  await app.waitFor(
    () =>
      app.js(
        `const row = document.querySelector(arguments[0] + " > .row");
         const b = row && Array.from(row.querySelectorAll("button")).find(
           (b) => b.getAttribute("aria-label") === arguments[1] || b.textContent.trim() === arguments[1]);
         if (!b) return false;
         b.scrollIntoView({ block: "center" });
         b.click();
         return true;`,
        treeNode(id),
        name,
      ),
    { message: `the ${name} button of ${id}` },
  );
}

/** Expand node `id` (connects it in the background). */
export const expandCluster = (app, id) => clickIn(app, id, `Expand ${id}`);
/** Collapse node `id`. */
export const collapseCluster = (app, id) => clickIn(app, id, `Collapse ${id}`);
/** Select node `id`: the window shows that cluster. */
export const selectCluster = (app, id) => clickIn(app, id, id);
/** Disconnect background cluster `id`. */
export const disconnectCluster = (app, id) => clickIn(app, id, `Disconnect ${id}`);

/** The text of node `id` (its name and what it shows when expanded). */
export function nodeText(app, id) {
  return app.js(`return document.querySelector(arguments[0])?.innerText ?? ""`, treeNode(id));
}

/** The cluster labels shown on the dock's tabs, in order. */
export function dockTabClusters(app) {
  return app.js(`return Array.from(document.querySelectorAll('[data-testid="dock-tab-cluster"]'), (c) => c.textContent.trim())`);
}

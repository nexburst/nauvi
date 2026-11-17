// The sidebar's cluster tree (ADR 0007, #333): its nodes, their state, and
// expanding, selecting and disconnecting them as a click would.

import { By } from "selenium-webdriver";
import { xq } from "./app.mjs";

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
 *  show on hover, so the click is a DOM click. */
async function clickIn(app, id, name) {
  const button = await app.find(
    By.xpath(`//*[@data-testid='cluster-node'][@data-cluster=${xq(id)}]/div[@class and contains(@class,'row')]//button[@aria-label=${xq(name)} or normalize-space()=${xq(name)}]`),
  );
  await app.js("arguments[0].scrollIntoView({ block: 'center' }); arguments[0].click()", button);
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

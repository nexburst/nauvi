// Checks (#140): the generic resource tables at 1280x800 in WebKitGTK.
// Each header starts where its column's cells do (WebKitGTK's overlay
// scrollbars take no gutter, so the header must not reserve one), and with
// the detail panel open a header label that does not fit its column is cut
// with an ellipsis instead of running into the next one. Services and Nodes, without and with the panel, light and
// dark theme. The Service lives in a temp namespace; the node is only read.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { closePanel, setTheme, waitPanelTitle } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";

const T = { timeout: 120_000 };
const SERVICE = "qa-layout-service-with-a-long-name";

const serviceYaml = `apiVersion: v1
kind: Service
metadata:
  name: ${SERVICE}
spec:
  type: ClusterIP
  externalIPs: ["192.0.2.10"]
  ports:
    - { name: http, port: 8080, targetPort: 8080 }
    - { name: metrics, port: 9090, targetPort: 9090 }
`;

/**
 * Left edges of the headers and of the first row's cells, plus the headers
 * whose content is wider than the header (a label running into the next one).
 */
const layout = (app) =>
  app.js(`
    const grid = document.querySelector('[data-testid="resource-table"] [role="grid"]');
    const left = (els) => Array.from(els, (e) => Math.round(e.getBoundingClientRect().left * 10) / 10);
    const heads = grid.querySelectorAll('[role="columnheader"]');
    const scroller = grid.querySelector('.scroller');
    return {
      heads: left(heads),
      cells: left(grid.querySelector('[data-testid="resource-row"]').querySelectorAll('[role="gridcell"]')),
      overflowing: Array.from(heads).filter((h) => h.scrollWidth > h.clientWidth + 1).map((h) => h.textContent.trim()),
      cut: Array.from(grid.querySelectorAll('[role="columnheader"] .label'))
        .filter((l) => l.scrollWidth > l.clientWidth)
        .map((l) => ({ label: l.textContent.trim(), title: l.parentElement.title, ellipsis: getComputedStyle(l).textOverflow })),
      gutter: scroller.offsetWidth - scroller.clientWidth,
      padRight: getComputedStyle(grid.querySelector('.head')).paddingRight,
    };`);

function assertLayout(what, l) {
  console.log(`${what}: ${JSON.stringify(l)}`);
  assert.equal(l.cells.length, l.heads.length);
  // The last column is the row's ⋮ (#382): its cell sticks to the table's
  // right edge when the columns scroll sideways (the detail panel open),
  // and its header is empty.
  l.heads.slice(0, -1).forEach((h, i) => assert.ok(Math.abs(h - l.cells[i]) <= 1, `${what}, column ${i}: header at ${h}, cells at ${l.cells[i]}`));
  assert.deepEqual(l.overflowing, [], `${what}: header labels running past their column`);
  for (const c of l.cut) {
    assert.equal(c.ellipsis, "ellipsis", `${what}: ${c.label} is cut with an ellipsis`);
    assert.equal(c.title.toUpperCase(), c.label.toUpperCase(), `${what}: ${c.label} has its full label as a tooltip`);
  }
  return l;
}

let ns;
let node;

describe("resource table layout (#140)", { timeout: 10 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-table-layout", serviceYaml);
    node = kubectl(["get", "nodes", "-o", "jsonpath={.items[0].metadata.name}"]);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("table-layout");

  for (const theme of ["light", "dark"]) {
    it(`Services: headers over their cells, then cut at the panel (${theme})`, T, async () => {
      const { app } = s;
      await waitLive(app);
      if ((await app.driver.findElements(By.css('[data-testid="detail-panel"]'))).length) await closePanel(app);
      await setTheme(app, theme);
      await app.nav("Services");
      await pickNamespaces(app, [ns]);
      await app.filter(SERVICE);
      await app.find(app.row(SERVICE, ns), { timeout: 60_000 });
      assertLayout(`services ${theme}`, await layout(app));

      await app.clickRow(SERVICE, ns);
      await waitPanelTitle(app, `${ns}/${SERVICE}`);
      // Columns fit their headers now (#482): a header is cut only when its
      // column gives way, and then with an ellipsis and its title (above).
      assertLayout(`services + panel ${theme}`, await layout(app));
    });

    it(`Nodes: headers over their cells, with and without the panel (${theme})`, T, async () => {
      const { app } = s;
      if ((await app.driver.findElements(By.css('[data-testid="detail-panel"]'))).length) await closePanel(app);
      await setTheme(app, theme);
      await app.nav("Nodes");
      await app.filter(node);
      await app.find(app.row(node), { timeout: 60_000 });
      assertLayout(`nodes ${theme}`, await layout(app));
      await app.clickRow(node);
      await waitPanelTitle(app, node);
      assertLayout(`nodes + panel ${theme}`, await layout(app));
      // Leave the panel open for the screenshot; the next test closes it.
    });
  }
});

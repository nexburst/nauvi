// Uses helm (qa.sh puts one on PATH, from the cache if needed).
// Checks (#123): Helm > Releases at 1280x800 in WebKitGTK. The header's
// columns start where their cells do (overlay scrollbars take no gutter), and
// with a release open the header is clipped at the 560px detail panel
// instead of drawing STATUS / UPDATED over it. Light and dark theme.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { CONTEXT, REPO, xq } from "../lib/app.mjs";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";

const T = { timeout: 120_000 };
const CHART = `${REPO}/scripts/test-cluster/charts/demo-chart`;
let skip = false;
try {
  execFileSync("helm", ["version", "--short"], { stdio: "ignore" });
} catch {
  skip = "helm is not on PATH";
}

const releaseRow = (name, ns) =>
  By.xpath(`//*[@data-testid='helm-row'][*[@role='gridcell'][1][normalize-space()=${xq(name)}]][*[@role='gridcell'][2][normalize-space()=${xq(ns)}]]`);

/** Left edges of the headers and of the first row's cells. */
const columnEdges = (app) =>
  app.js(`
    const grid = document.querySelector('[data-testid="helm-releases"] [role="grid"]');
    const left = (els) => Array.from(els, (e) => Math.round(e.getBoundingClientRect().left));
    return {
      heads: left(grid.querySelectorAll('[role="columnheader"]')),
      cells: left(grid.querySelector('[data-testid="helm-row"]').querySelectorAll('[role="gridcell"]')),
    };`);

function assertAligned({ heads, cells }) {
  console.log(`header x ${JSON.stringify(heads)}, cell x ${JSON.stringify(cells)}`);
  assert.equal(cells.length, heads.length);
  heads.forEach((h, i) => assert.ok(Math.abs(h - cells[i]) <= 1, `column ${i}: header at ${h}, cells at ${cells[i]}`));
}

/** Header labels painted over the detail panel (what is drawn there is the header). */
const headersOverPanel = (app) =>
  app.js(`
    const panel = document.querySelector('[data-testid="helm-detail"]').getBoundingClientRect();
    const grid = document.querySelector('[data-testid="helm-releases"] [role="grid"]').getBoundingClientRect();
    const over = Array.from(document.querySelectorAll('[data-testid="helm-releases"] [role="columnheader"]')).flatMap((th) => {
      const r = th.getBoundingClientRect();
      const x = Math.max(r.left, panel.left) + 4;
      if (x >= r.right) return [];
      const hit = document.elementFromPoint(x, r.top + r.height / 2);
      return hit && th.contains(hit) ? [th.textContent.trim()] : [];
    });
    return { over, gridRight: Math.round(grid.right), panelLeft: Math.round(panel.left), panelWidth: Math.round(panel.width) };`);

let ns;

describe("helm releases layout (#123)", { timeout: 10 * 60_000, skip }, () => {
  before(() => {
    ns = tempNamespace("qa-helm-layout");
    for (const name of ["qa-layout-a", "qa-layout-b"]) {
      execFileSync("helm", ["--kube-context", CONTEXT, "-n", ns, "install", name, CHART, "--set", "replicas=0"], { stdio: "pipe" });
    }
  });
  after(() => deleteNamespace(ns));
  const s = appSession("helm-layout");

  it("headers sit over their cells", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.nav("Releases");
    await pickNamespaces(app, [ns]);
    await app.find(releaseRow("qa-layout-b", ns), { timeout: 60_000 });
    await app.waitFor(async () => (await app.js(`return document.querySelector('[data-testid="helm-row"]')?.innerText ?? ""`)).includes("demo-chart"), {
      message: "the chart column filled in",
    });
    assertAligned(await columnEdges(app));
  });

  for (const theme of ["dark", "light"]) {
    it(`with a release open, the header stops at the panel (${theme})`, T, async () => {
      const { app } = s;
      await setTheme(app, theme);
      if ((await app.driver.findElements(By.css('[data-testid="helm-detail"]'))).length === 0) {
        await (await app.find(releaseRow("qa-layout-a", ns))).click();
      }
      await app.find(By.css('[data-testid="helm-detail"]'));
      await app.waitFor(async () => (await app.js(`return document.querySelector('[data-testid="helm-status"]')?.innerText ?? ""`)) !== "", {
        message: "the release loaded",
      });
      const r = await headersOverPanel(app);
      console.log(`${theme}: ${JSON.stringify(r)}`);
      assert.deepEqual(r.over, [], `headers over the panel: ${JSON.stringify(r.over)}`);
      assert.ok(r.gridRight <= r.panelLeft, `grid ends at ${r.gridRight}, panel starts at ${r.panelLeft}`);
      assertAligned(await columnEdges(app));
    });
  }
});

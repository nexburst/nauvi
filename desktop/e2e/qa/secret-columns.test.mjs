// Custom columns on Secrets (#571): a column that would show a Secret's
// data without Reveal is refused in the chooser, with the reason: a field
// path under .data or .stringData (any case) and the last-applied
// annotation, which `kubectl apply` fills with the whole Secret. The
// Secret's other fields work, and an annotation that holds a JSON copy of
// it shows as {…}. The Secret's value appears nowhere on the page. At
// 1280x800, dark and light.
//
// Objects it creates live in a temporary qa-secret-cols-* namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { xq } from "../lib/app.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { tableData } from "../lib/table.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const PASSWORD = "qa-571-hunter2";
const B64 = Buffer.from(PASSWORD).toString("base64");
const REFUSED = "A column on Secrets cannot show their data: open the Secret and press Reveal to see it.";

const secret = `
apiVersion: v1
kind: Secret
metadata:
  name: qa-secret-cols
  annotations:
    qa.nauvi.dev/copy: '{"data":{"password":"${B64}"}}'
    qa.nauvi.dev/team: blue
type: Opaque
data:
  password: ${B64}
`;

const DIALOG = "//*[@role='dialog'][@aria-label='Columns']";
const chooserButton = By.xpath("//button[starts-with(normalize-space(), 'Columns')]");
const inDialog = (xpath) => By.xpath(`${DIALOG}${xpath}`);
const button = (label) => inDialog(`//button[normalize-space()=${xq(label)}]`);
const field = (label) => inDialog(`//label[starts-with(normalize-space(), ${xq(label)})]//*[self::input or self::select]`);

async function click(app, locator) {
  const el = await app.waitFor(async () => (await app.driver.findElements(locator))[0], { message: String(locator) });
  await app.js("arguments[0].scrollIntoView({ block: 'center', inline: 'center' })", el);
  try {
    await el.click();
  } catch (e) {
    if (e.name !== "ElementNotInteractableError") throw e;
    await app.js("arguments[0].click()", el);
  }
}
const headers = async (app) => (await tableData(app)).headers.filter(Boolean);
const draftError = (app) => app.js(`return document.getElementById("column-draft-error")?.textContent.trim() ?? ""`);

async function openChooser(app) {
  if ((await app.driver.findElements(By.xpath(DIALOG))).length === 0) await click(app, chooserButton);
  await app.find(By.xpath(DIALOG));
}
async function closeChooser(app) {
  if ((await app.driver.findElements(By.xpath(DIALOG))).length) await app.driver.actions().sendKeys(Key.ESCAPE).perform();
  await app.waitFor(async () => (await app.driver.findElements(By.xpath(DIALOG))).length === 0, {
    message: "the chooser closed",
  });
}
/** Fill the form of a new column (the chooser open) and press Add; the error shown, if any. */
async function tryColumn(app, { name, from, value }) {
  // The column list has a "Name" checkbox too: look for the form itself.
  if ((await app.driver.findElements(inDialog("//form[contains(@class, 'draft')]"))).length === 0)
    await click(app, button("+ Add column…"));
  await app.setValue(await app.find(field("Name")), name);
  const select = await app.find(field("From"));
  await (await select.findElement(By.xpath(`./option[normalize-space()=${xq(from)}]`))).click();
  await app.setValue(await app.find(field(from === "Field path" ? "Path" : "Key")), value);
  await click(app, button("Add"));
  return draftError(app);
}
const pageText = (app) => app.js("return document.body.innerText");

describe("custom columns on Secrets", { timeout: 10 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-secret-cols", secret);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("secret-columns");

  async function showSecrets(app) {
    await app.nav("Secrets");
    await waitLive(app);
    await app.filter("qa-secret-cols");
    await app.waitFor(async () => (await tableData(app)).rows.length === 1, { message: "the Secret of the namespace" });
  }

  it("a column under .data or .stringData, or the last-applied annotation, is refused and says why", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, "dark");
    await showSecrets(app);
    await openChooser(app);
    for (const value of [".data.password", ".data", ".Data.password", ".stringData.password"]) {
      assert.equal(await tryColumn(app, { name: "Password", from: "Field path", value }), REFUSED, value);
    }
    await app.shot("refused-path-dark");
    await setTheme(app, "light");
    await app.shot("refused-path-light");
    await setTheme(app, "dark");
    const key = "kubectl.kubernetes.io/last-applied-configuration";
    assert.equal(await tryColumn(app, { name: "Applied", from: "Annotation", value: key }), REFUSED);
    await app.shot("refused-annotation-dark");
    // A path the chooser cannot read says so first.
    const err = await tryColumn(app, { name: "Password", from: "Field path", value: ".['data']" });
    assert.match(err, /^A field name must follow the first dot/);
    await click(app, button("Cancel"));
    await closeChooser(app);
    assert.deepEqual(
      (await headers(app)).filter((h) => ["Password", "Applied"].includes(h)),
      [],
      "nothing was added",
    );
  });

  it("the Secret's other fields work; a JSON copy in an annotation shows as {…}; the value is nowhere", T, async () => {
    const { app } = s;
    await openChooser(app);
    assert.equal(await tryColumn(app, { name: "Secret type", from: "Field path", value: ".type" }), "");
    assert.equal(await tryColumn(app, { name: "Team", from: "Annotation", value: "qa.nauvi.dev/team" }), "");
    assert.equal(await tryColumn(app, { name: "Copy", from: "Annotation", value: "qa.nauvi.dev/copy" }), "");
    await closeChooser(app);
    await app.waitFor(async () => (await tableData(app)).rows[0]?.["Secret type"] === "Opaque", {
      message: "the custom cells",
    });
    const [row] = (await tableData(app)).rows;
    assert.equal(row.Team, "blue");
    assert.equal(row.Copy, "{…}");
    await app.js(`document.querySelector('[data-testid="resource-table"] .scroller').scrollLeft = 1e6`);
    await app.shot("allowed-columns-dark");
    await setTheme(app, "light");
    await app.shot("allowed-columns-light");
    const text = await pageText(app);
    assert.ok(!text.includes(B64) && !text.includes(PASSWORD), "the Secret's value is not on the page");
    const html = await app.js("return document.documentElement.outerHTML");
    assert.ok(!html.includes(B64) && !html.includes(PASSWORD), "nor in its markup");
  });
});

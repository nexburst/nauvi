// Checks (#221): Export CSV in the toolbar saves the rows and columns on
// screen through the native save dialog (GTK under Xvfb, answered with real
// X11 key presses), and the toolbar says where the file went.
//
// - a large table (1200 ConfigMaps): every filtered row, in table order;
// - the sort and the column choice are what the file has;
// - Escape in the dialog saves nothing; an empty table saves the header;
// - a path that cannot be written shows the error in the toolbar;
// - an Event whose message is a spreadsheet formula is written as text;
// - a Secret's export has its name, type and key count, never its value.
// Screenshots at 1280x800 in light and dark theme. Everything lives in a
// temp namespace.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, kubectl, tempNamespace } from "../lib/cluster.mjs";
import { appPid } from "../lib/dock.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { cannotCloseLikeUser, resizeWindow, x11Windows } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const MAPS = 1200;
const SECRET_VALUE = "qa-csv-secret-value-do-not-export";
const FORMULA = '=HYPERLINK("http://evil.example","click")';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const xkey = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "xkey.py");

// The save dialog needs X11 tools to answer it (xwininfo, xprop, python3).
const skip = cannotCloseLikeUser();

function configMaps(ns) {
  const items = Array.from({ length: MAPS }, (_, i) => ({
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: `cm-${String(i).padStart(4, "0")}`, namespace: ns },
    data: Object.fromEntries(Array.from({ length: (i % 3) + 1 }, (_, k) => [`k${k}`, "v"])),
  }));
  return JSON.stringify({ apiVersion: "v1", kind: "List", items });
}

let ns;
let pid;

/** The app's "Export to CSV" dialog window, once it is shown. */
async function dialogWindow(app) {
  return app.waitFor(
    () => {
      for (const id of x11Windows(pid)) {
        const title = execFileSync("xprop", ["-id", id, "_NET_WM_NAME"], { encoding: "utf8" });
        if (title.includes('"Export to CSV"')) return id;
      }
      return null;
    },
    { timeout: 20_000, message: "the Export to CSV dialog" },
  );
}

/** Wait until the dialog is gone. */
function dialogClosed(app) {
  return app.waitFor(
    () =>
      x11Windows(pid).every(
        (id) => !execFileSync("xprop", ["-id", id, "_NET_WM_NAME"], { encoding: "utf8" }).includes("Export to CSV"),
      ),
    { timeout: 20_000, message: "the dialog to close" },
  );
}

/** Click Export CSV, then answer the save dialog with these X11 keysyms. */
async function exportWith(app, ...keys) {
  const button = await app.find(By.xpath("//button[normalize-space()='Export CSV']"));
  await app.waitFor(async () => await button.isEnabled(), { message: "Export CSV enabled" });
  await button.click();
  const id = await dialogWindow(app);
  // GTK needs a moment to put the focus in the name field.
  await sleep(1500);
  execFileSync("python3", [xkey, id, ...keys], { stdio: "inherit" });
  await dialogClosed(app);
}

/** The toolbar keeps one row (54 px) at 1280x800 while a note is shown. */
async function assertOneRowToolbar(app) {
  const h = await app.js(`return Math.round(document.querySelector('.toolbar').getBoundingClientRect().height)`);
  assert.ok(h <= 60, `the toolbar keeps one row with the note (${h}px)`);
}

const noteText = (app) => app.js(`return document.querySelector('[data-testid="csv-saved"]')?.textContent ?? ""`);

/** X11 keysyms that type `text` (letters, digits, `-`, `/`, `.`). */
const keysOf = (text) => [...text].map((c) => ({ "-": "minus", "/": "slash", ".": "period" })[c] ?? c);

/**
 * Export, typing `stem` over the suggested name (GTK selects the part before
 * ".csv", so the extension stays; "" keeps the suggested name) and Return;
 * the dialog starts in Downloads. Returns the new file and its records.
 */
async function exportToDownloads(app, stem) {
  const before = new Set(app.profile.downloadedFiles());
  await exportWith(app, ...keysOf(stem), "Return");
  const name = await app.waitFor(() => app.profile.downloadedFiles().find((f) => !before.has(f)), {
    timeout: 20_000,
    message: `${stem}.csv in Downloads`,
  });
  const path = join(app.profile.downloads, name);
  const text = readFileSync(path, "utf8");
  assert.ok(text.endsWith("\r\n"), "records end with CRLF");
  return { path, text, lines: text.slice(0, -2).split("\r\n") };
}

/** The footer's "N of M items". */
const footerCount = (app) => app.js(`return document.querySelector('footer span')?.textContent ?? ""`);

describe("CSV export", { timeout: 15 * 60_000, skip }, () => {
  before(() => {
    ns = tempNamespace("qa-csv");
    kubectl(["-n", ns, "apply", "-f", "-"], configMaps(ns));
    kubectl(
      ["-n", ns, "apply", "-f", "-"],
      `apiVersion: v1
kind: Secret
metadata:
  name: qa-csv-secret
type: Opaque
stringData:
  password: ${SECRET_VALUE}
---
apiVersion: v1
kind: Event
metadata:
  name: qa-csv-formula
involvedObject:
  kind: ConfigMap
  name: cm-0000
  namespace: ${ns}
reason: QaFormula
type: Normal
message: '${FORMULA}'
`,
    );
  });
  after(() => deleteNamespace(ns));
  const s = appSession("csv-export");

  it("a large table: every row shown, in table order, and the toolbar says where", T, async () => {
    const { app } = s;
    pid = appPid(app.profile.home);
    assert.ok(pid, "the app's pid");
    await waitLive(app);
    await resizeWindow(app, 1280, 800);
    await app.nav("Config Maps");
    await pickNamespaces(app, [ns]);
    // The ConfigMaps plus kube-root-ca.crt.
    await app.waitFor(async () => (await footerCount(app)).startsWith(`${MAPS + 1} of`), {
      timeout: 60_000,
      message: `${MAPS + 1} config maps`,
    });
    const { path, lines } = await exportToDownloads(app, "qa-large");
    assert.deepEqual(lines[0].split(","), ["Name", "Namespace", "Data", "Age"]);
    assert.equal(lines.length, MAPS + 2, "the header and every row");
    const names = lines.slice(1).map((l) => l.split(",")[0]);
    assert.deepEqual(names.slice(0, 2), ["cm-0000", "cm-0001"]);
    assert.equal(names.at(-1), "kube-root-ca.crt");
    assert.equal(lines[1], `cm-0000,${ns},1,${lines[1].split(",")[3]}`);
    assert.equal(lines[3].split(",")[2], "3");
    const file = basename(path);
    await app.waitFor(async () => (await noteText(app)) === `Saved ${MAPS + 1} rows to Downloads/${file}`, {
      message: `"Saved ${MAPS + 1} rows to Downloads/${file}"`,
    });
    assert.equal(await app.js(`return document.querySelector('[data-testid="csv-saved"]').title`), path);
    const toolbar = await app.js(`
      const t = document.querySelector('.toolbar').getBoundingClientRect();
      const n = document.querySelector('[data-testid="csv-saved"]').getBoundingClientRect();
      return { toolbarH: Math.round(t.height), noteH: Math.round(n.height), noteRight: Math.round(n.right), width: innerWidth };`);
    console.log(`saved ${path}; toolbar ${JSON.stringify(toolbar)}`);
    assert.ok(toolbar.noteH <= 20, `the note is one line (${toolbar.noteH}px)`);
    await assertOneRowToolbar(app);
    assert.ok(toolbar.noteRight <= toolbar.width, "the note fits the window");
    await setTheme(app, "dark");
    await app.shot("large-table-saved-dark");
    await setTheme(app, "light");
    await app.shot("large-table-saved-light");
    await setTheme(app, null);
  });

  it("the file follows the sort and the column choice", T, async () => {
    const { app } = s;
    const name = await app.find(By.xpath("//*[@role='columnheader'][.//span[normalize-space()='Name']]"));
    await name.click();
    await name.click();
    await app.waitFor(async () => (await name.getAttribute("aria-sort")) === "descending", { message: "sorted by name, descending" });
    await (await app.find(By.xpath("//button[starts-with(normalize-space(), 'Columns')]"))).click();
    const age = await app.find(By.xpath("//*[@role='dialog'][@aria-label='Columns']//label[normalize-space()='Age']//input"));
    await age.click();
    await (await app.find(By.xpath("//button[starts-with(normalize-space(), 'Columns')]"))).click();
    await app.filter("cm-11");
    await app.waitFor(async () => (await footerCount(app)).startsWith("100 of"), { message: "100 rows matching cm-11" });
    const { lines } = await exportToDownloads(app, "qa-sorted");
    assert.deepEqual(lines[0].split(","), ["Name", "Namespace", "Data"]);
    assert.equal(lines.length, 101);
    assert.equal(lines[1].split(",")[0], "cm-1199");
    assert.equal(lines.at(-1).split(",")[0], "cm-1100");
    await app.shot("sorted-hidden-column");
    // Back to the defaults for the next tests.
    await name.click();
    await (await app.find(By.xpath("//button[starts-with(normalize-space(), 'Columns')]"))).click();
    await (await app.find(By.xpath("//*[@role='dialog'][@aria-label='Columns']//button[normalize-space()='Show all']"))).click();
    await (await app.find(By.xpath("//button[starts-with(normalize-space(), 'Columns')]"))).click();
  });

  it("Escape saves nothing; an empty table saves just the header", T, async () => {
    const { app } = s;
    // The last note goes after 10 s.
    await app.waitFor(async () => (await noteText(app)) === "", { timeout: 15_000, message: "the last note to go" });
    const before = app.profile.downloadedFiles().length;
    await exportWith(app, "Escape");
    await sleep(1000);
    assert.equal(app.profile.downloadedFiles().length, before, "no file after Escape");
    assert.equal(await noteText(app), "", "no note after Escape");

    await app.filter("nothing-matches-this");
    await app.waitFor(async () => (await footerCount(app)).startsWith("0 of"), { message: "an empty table" });
    // The suggested name, as is: kind, context and time.
    const { path, lines } = await exportToDownloads(app, "");
    assert.match(basename(path), /^config-maps_kind-[a-z0-9-]+_\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.csv$/);
    assert.deepEqual(lines, ["Name,Namespace,Data,Age"]);
    await app.waitFor(async () => (await noteText(app)).startsWith("Saved 0 rows to Downloads/"), { message: "Saved 0 rows" });
    await assertOneRowToolbar(app);
    await setTheme(app, "dark");
    await app.shot("empty-table-saved-dark");
    await setTheme(app, null);
  });

  it("a folder that cannot be written shows the error in the toolbar", T, async () => {
    const { app } = s;
    // GTK selects the suggested name: typing replaces it with a path in /proc.
    await exportWith(app, ...keysOf("/proc/qa"), "Return");
    await app.waitFor(async () => (await noteText(app)).startsWith("Could not export:"), {
      message: "the export error in the toolbar",
    });
    const text = await noteText(app);
    console.log(`error note: ${text}`);
    assert.match(text, /\/proc\/qa\.csv/);
    await assertOneRowToolbar(app);
    await setTheme(app, "dark");
    await app.shot("write-error-dark");
    await setTheme(app, "light");
    await app.shot("write-error-light");
    await setTheme(app, null);
    await app.filter("");
  });

  it("an Event message that is a formula is written as text", T, async () => {
    const { app } = s;
    await app.nav("Events");
    await app.filter("QaFormula");
    await app.waitFor(async () => (await footerCount(app)).startsWith("1 of"), { timeout: 60_000, message: "the formula event" });
    const { text, lines } = await exportToDownloads(app, "qa-events");
    assert.equal(lines.length, 2);
    assert.ok(text.includes(`"'=HYPERLINK(""http://evil.example"",""click"")"`), `the formula is prefixed: ${lines[1]}`);
    assert.ok(!/(^|,)=HYPERLINK/m.test(text), "no cell starts with =");
    await app.shot("event-formula");
  });

  it("the Secrets export has names, types and key counts, never values", T, async () => {
    const { app } = s;
    await app.nav("Secrets");
    await app.filter("qa-csv-secret");
    await app.waitFor(async () => (await footerCount(app)).startsWith("1 of"), { timeout: 60_000, message: "the secret" });
    const { text, lines } = await exportToDownloads(app, "qa-secrets");
    assert.deepEqual(lines[0].split(","), ["Name", "Namespace", "Type", "Data", "Age"]);
    assert.match(lines[1], new RegExp(`^qa-csv-secret,${ns},Opaque,1,`));
    assert.ok(!text.includes(SECRET_VALUE), "no secret value");
    assert.ok(!text.includes(Buffer.from(SECRET_VALUE).toString("base64")), "no base64 secret value");
    await app.shot("secrets");
  });
});

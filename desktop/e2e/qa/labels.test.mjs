// #483, #491: every control says what it is, and the problem pill leads to
// the problem pods, in WebKitGTK against kind.
// - The header pill counts the problem pods in plain words; a click lists
//   them, each with its reason, and one more click opens the pod. The watch
//   log (streak, insignia) is the popover's second tab.
// - Titles show as the app's own tooltip (hover and keyboard focus); the
//   header's icon buttons say their name and shortcut.
// - The table filter's options are labelled toggles (Aa Match case, .* Regex,
//   ☆ Star); the detail panel names Logs, Shell and Edit, Delete stands apart.
// - The footer's timeline is labelled, its legend is its tooltip, a click
//   opens the watch log.
// - No visible button of the main window lacks a word or a tooltip with an
//   accessible name (Overview, Pods table, pod detail).
// Screenshots at 1280x800 in dark and light.
//
// A pod that cannot pull its image (in a temp namespace) is the problem pod.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "../lib/theme.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const POD = "qa-no-image";
const POD_YAML = `---
apiVersion: v1
kind: Pod
metadata:
  name: ${POD}
spec:
  containers:
    - name: app
      image: registry.invalid/nauvi-qa/none:1
`;

let ns;

/** Shots at 1280x800 in dark and light; `again` re-shows what a theme switch hid. */
async function shots(app, label, again = async () => {}) {
  for (const theme of ["dark", "light"]) {
    await setTheme(app, theme);
    await again();
    await app.shot(`${label}-${theme}`);
  }
  await setTheme(app, null);
}

const tooltip = (app) => app.js(`return document.querySelector('[data-testid="tooltip"]')?.innerText.trim() ?? ""`);

/** Move the pointer onto `css` and wait for the app's tooltip. */
async function hover(app, css, want) {
  const el = await app.find(By.css(css));
  // Off it first, so the tip shows again after a theme switch.
  await app.driver.actions().move({ x: 2, y: 400 }).perform();
  await app.driver.actions().move({ origin: el }).perform();
  const t = await app.waitFor(
    async () => {
      const t = await tooltip(app);
      return want.test(t) ? t : false;
    },
    { message: `the tooltip of ${css} (${want})` },
  );
  // Past its fade-in, for the screenshot.
  await new Promise((r) => setTimeout(r, 250));
  return t;
}

/** What `labels.spec.ts` checks in Chromium: visible buttons without a word or a tooltip with a name. */
const unlabelled = (app) =>
  app.js(`
    const shown = (el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== "hidden"; };
    const visibleText = (b) => {
      let out = "";
      const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const p = n.parentElement;
        if (!p || p.closest("[aria-hidden='true']") || !shown(p)) continue;
        out += n.textContent || "";
      }
      return out.trim();
    };
    const bad = [];
    for (const b of document.querySelectorAll("button, [role='button'], [role='tab']")) {
      if (!shown(b) || b.getAttribute("tabindex") === "-1") continue;
      const title = b.getAttribute("title") || b.getAttribute("data-tip-title") || b.dataset.tip || "";
      const name = (b.getAttribute("aria-label") || b.textContent || title).trim();
      const word = /\\p{L}{3,}/u.test(visibleText(b));
      if (name && (word || title)) continue;
      bad.push(b.outerHTML.slice(0, 160));
    }
    return bad;`);

describe("labels and the problem pill (#483, #491)", { timeout: 15 * 60_000 }, () => {
  before(() => {
    ns = tempNamespace("qa-labels", POD_YAML);
  });
  after(() => deleteNamespace(ns));
  const s = appSession("labels");

  it("the pill counts the problem pods; its tooltip says what a click does", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.nav("Overview");
    const text = await app.waitFor(
      async () => {
        const t = await app.js(`return document.querySelector('[data-testid="watch-dial"]')?.innerText.trim() ?? ""`);
        return /^\d+ problem pods?$/.test(t) ? t : false;
      },
      { timeout: 120_000, message: "the pill counts problem pods" },
    );
    console.log(`pill: ${text}`);
    const tip = await hover(app, '[data-testid="watch-dial"]', /need(s)? a look\. Click to see/);
    console.log(`pill tooltip: ${tip}`);
    await shots(app, "pill-tooltip", () => hover(app, '[data-testid="watch-dial"]', /a look/));
  });

  it("a click lists the problem pods with their reason; one more opens the pod", T, async () => {
    const { app } = s;
    await (await app.find(By.css('[data-testid="watch-dial"]'))).click();
    const line = await app.waitFor(
      () =>
        app.js(
          `const r = Array.from(document.querySelectorAll('[data-testid="watch-problem"]')).find((r) => r.innerText.includes(${JSON.stringify(`${ns}/${POD}`)}));
           return r ? r.innerText : null;`,
        ),
      { timeout: 120_000, message: "the image-less pod in the pill's list" },
    );
    console.log(`listed: ${line.replace(/\s+/g, " ")}`);
    assert.match(line, /ImagePull|ErrImage/);
    const panel = await app.js(`return document.querySelector('[data-testid="watch-panel"]').innerText`);
    assert.doesNotMatch(panel, /streak|insignia/i, "no streak on the first tab");
    await shots(app, "pill-problems", async () => {
      if ((await app.driver.findElements(By.css('[data-testid="watch-panel"]'))).length === 0)
        await (await app.find(By.css('[data-testid="watch-dial"]'))).click();
    });

    await (await app.find(By.css(`[data-testid="watch-problem"] button[title="Open ${ns}/${POD}"]`))).click();
    await app.waitFor(
      () => app.js(`return document.querySelector('[data-testid="detail-panel"]')?.innerText.includes(${JSON.stringify(POD)}) ?? false`),
      { message: "the pod's detail panel" },
    );
    assert.equal(await app.js(`return document.querySelectorAll('[data-testid="watch-panel"]').length`), 0);
  });

  it("the detail panel names Logs, Shell and Edit; the rest show their name on hover", T, async () => {
    const { app } = s;
    const words = await app.js(
      `return Array.from(document.querySelectorAll('[data-testid="detail-panel"] [role="toolbar"] .word'), (w) => w.textContent.trim())`,
    );
    console.log(`labelled actions: ${words.join(", ")}`);
    assert.deepEqual(words, ["Logs", "Shell", "Edit YAML"]);
    const show = async () => {
      const b = await app.find(By.css('[data-testid="detail-panel"] [data-action="link"]'));
      await app.driver.actions().move({ x: 2, y: 400 }).perform();
      await app.driver.actions().move({ origin: b }).perform();
      await app.waitFor(() => app.js(`return !!document.querySelector('[data-testid="action-tip"]')`), { message: "Copy link's tip" });
    };
    await show();
    await shots(app, "detail-actions", show);
    assert.deepEqual(await unlabelled(app), [], "every button of the pod's detail is labelled");
  });

  it("the filter's options are labelled toggles", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await pickNamespaces(app, [ns]);
    assert.deepEqual(await unlabelled(app), [], "every button of the Pods table is labelled");
    const regex = await app.find(By.css('[data-testid="table-filter-box"] button[aria-label="Regex (regular expression)"]'));
    await regex.click();
    await app.waitFor(async () => (await regex.getAttribute("aria-pressed")) === "true", { message: "regex on" });
    const texts = await app.js(
      `return Array.from(document.querySelectorAll('[data-testid="table-filter-box"] > button'), (b) => b.innerText.replace(/\\s+/g, " ").trim())`,
    );
    console.log(`filter options: ${texts.join(" | ")}`);
    assert.deepEqual(texts.slice(0, 2), ["Aa Match case", ".* Regex"]);
    const sel = '[data-testid="table-filter-box"] button[aria-label="Regex (regular expression)"]';
    const tip = await hover(app, sel, /Regular expression: on/);
    console.log(`regex tooltip: ${tip}`);
    await shots(app, "filter-options", () => hover(app, sel, /Regular expression/));
    await regex.click();
  });

  it("the header's icon buttons say their name and shortcut", T, async () => {
    const { app } = s;
    const tip = await hover(app, 'header button[aria-label="Settings"]', /^Settings \((Ctrl|⌘)/);
    console.log(`settings tooltip: ${tip}`);
    await shots(app, "settings-tooltip", () => hover(app, 'header button[aria-label="Settings"]', /^Settings/));
    const help = await hover(app, 'header [data-testid="help-menu-button"]', /keyboard shortcuts/);
    console.log(`help tooltip: ${help}`);
  });

  it("the footer's timeline is labelled, explains itself and opens the watch log", T, async () => {
    const { app } = s;
    await app.nav("Overview");
    const caption = await app.js(`return document.querySelector('[data-testid="wake-caption"]')?.innerText.trim() ?? ""`);
    assert.equal(caption, "Problem pods, last 12h");
    const legend = await hover(app, '[data-testid="wake-line"]', /teal line: none/);
    console.log(`timeline legend: ${legend.replace(/\n/g, " / ")}`);
    await shots(app, "timeline-legend", () => hover(app, '[data-testid="wake-line"]', /teal line/));
    assert.deepEqual(await unlabelled(app), [], "every button of the Overview is labelled");
    await (await app.find(By.css('[data-testid="wake-line"]'))).click();
    await app.waitFor(
      () => app.js(`return document.querySelector('[data-testid="watch-tab-log"]')?.getAttribute("aria-selected") === "true"`),
      { message: "the watch log tab" },
    );
    await shots(app, "watch-log", async () => {
      if ((await app.driver.findElements(By.css('[data-testid="watch-panel"]'))).length === 0)
        await (await app.find(By.css('[data-testid="wake-line"]'))).click();
    });
  });

  it("the catalog's Open says it switches this window", T, async (t) => {
    const { app } = s;
    // The watch log is still open from the last test.
    await app.driver.actions().sendKeys(Key.ESCAPE).perform();
    await app.waitFor(async () => (await app.driver.findElements(By.css('[data-testid="watch-panel"]'))).length === 0, {
      message: "the popover closed",
    });
    await (await app.find(By.css('header button[aria-label="Cluster catalog"]'))).click();
    const others = await app.js(`return document.querySelectorAll('table button[aria-label^="Open "]:not(:disabled)').length`);
    if (others === 0) {
      t.skip("only one context: no Open button to hover");
      return;
    }
    const tip = await hover(app, 'table button[aria-label^="Open "]:not(:disabled)', /in this window/);
    console.log(`catalog Open tooltip: ${tip}`);
    await shots(app, "catalog-open", () => hover(app, 'table button[aria-label^="Open "]:not(:disabled)', /in this window/));
  });
});

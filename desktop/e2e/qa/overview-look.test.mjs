// #480: the visual hierarchy of the Overview and the top bar, in WebKitGTK.
// Checks: the UI font (Inter, bundled) is loaded and used for headings,
// labels and figures, and mono only where it should be; every stat card
// and every top-bar button draws an icon of the set (lib/icons); a problem
// pod is a card with its actions, and its Logs opens the pod's logs in the
// dock without leaving the Overview. Screenshots at 1280x800 and 860x800,
// in the light and the dark theme.
//
// Reads the demo objects only (demo/crashed is the problem pod).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 120_000 };

/** The computed font family of the first element matching each selector. */
function fonts(app, selectors) {
  return app.js(
    `return Object.fromEntries(arguments[0].map((s) => {
       const el = document.querySelector(s);
       return [s, el ? getComputedStyle(el).fontFamily : null];
     }))`,
    selectors,
  );
}

describe("Overview look (#480)", { timeout: 10 * 60_000 }, () => {
  const s = appSession("overview-look");

  it("shows the problem pods as cards", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    await app.nav("Overview");
    await app.waitFor(
      () => app.js(`return document.querySelectorAll('.overview section[aria-label="Problem pods"] .problem').length > 0`),
      { timeout: 90_000, message: "a problem pod on the Overview" },
    );
  });

  it("uses the UI font for text and the bundled Inter on Linux", T, async () => {
    const { app } = s;
    const loaded = await app.js(`return document.fonts.ready.then(() => document.fonts.check('600 16px "Inter Variable"'))`);
    assert.equal(loaded, true, "Inter Variable is loaded");
    const f = await fonts(app, [
      ".overview .headline",
      ".overview h3",
      ".overview .card .label",
      ".overview .card .num",
      ".overview .problem .name",
      "header .word",
    ]);
    console.log(JSON.stringify(f, null, 1));
    for (const [sel, family] of Object.entries(f)) {
      assert.ok(family, `${sel} is on the page`);
      assert.match(family, /Inter Variable/, `${sel} in the UI font`);
      assert.doesNotMatch(family.split(",")[0], /Mono|monospace/, `${sel} not mono`);
    }
    // Real sizes: the headline is the biggest text, section headings above body.
    const sizes = await app.js(`
      const px = (s) => parseFloat(getComputedStyle(document.querySelector(s)).fontSize);
      return { headline: px(".overview .headline"), h3: px(".overview h3"), body: px(".overview .problem .meta") };`);
    console.log(JSON.stringify(sizes));
    assert.ok(sizes.headline > sizes.h3 && sizes.h3 > sizes.body, JSON.stringify(sizes));
  });

  it("draws an icon on every stat card and top-bar button", T, async () => {
    const { app } = s;
    const icons = await app.js(`
      const cards = Array.from(document.querySelectorAll(".overview .card"), (c) => c.querySelector("svg.icon")?.dataset.icon ?? "");
      const bar = Array.from(document.querySelectorAll("header svg.icon"), (i) => i.dataset.icon);
      const box = document.querySelector(".overview .card svg.icon").getBoundingClientRect();
      return { cards, bar, box: [box.width, box.height] };`);
    console.log(JSON.stringify(icons));
    assert.ok(icons.cards.length >= 3 && icons.cards.every(Boolean), `cards: ${icons.cards}`);
    for (const name of ["arrowLeft", "arrowRight", "grid", "search", "refresh", "bell", "help", "settings"]) {
      assert.ok(icons.bar.includes(name), `${name} in the top bar: ${icons.bar}`);
    }
    assert.ok(icons.box[0] > 0 && icons.box[1] > 0, "the icons are drawn");
  });

  for (const [w, h] of [
    [1280, 800],
    [860, 800],
  ]) {
    for (const theme of ["dark", "light"]) {
      it(`screenshot ${w}x${h} ${theme}`, T, async () => {
        const { app } = s;
        await resizeWindow(app, w, h);
        await setTheme(app, theme);
        await app.js(`document.querySelector(".overview").scrollTo(0, 0)`);
        await new Promise((r) => setTimeout(r, 600));
        await app.shot(`overview-${w}-${theme}`);
        // Scroll the view only: scrollIntoView would scroll the window too.
        await app.js(`const o = document.querySelector(".overview");
          const c = o.querySelector('section[aria-label="Capacity"]');
          if (c) o.scrollTo(0, c.getBoundingClientRect().top - o.getBoundingClientRect().top + o.scrollTop - 12);`);
        await new Promise((r) => setTimeout(r, 600));
        await app.shot(`overview-${w}-${theme}-capacity`);
      });
    }
  }

  it("a problem pod's Logs opens its logs in the dock, on the Overview", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await setTheme(app, null);
    await app.js(`document.querySelector(".overview").scrollTo(0, 0)`);
    const clicked = await app.js(`
      const card = Array.from(document.querySelectorAll('.overview section[aria-label="Problem pods"] .problem'))
        .find((p) => p.querySelector(".name")?.textContent.trim() === "demo/crashed");
      const logs = card && Array.from(card.querySelectorAll(".actions button")).find((b) => b.textContent.trim() === "Logs");
      logs?.click();
      return !!logs;`);
    assert.ok(clicked, "demo/crashed has a Logs action");
    const tab = await app.waitFor(
      () =>
        app.js(
          `return Array.from(document.querySelectorAll('[data-testid="dock"] [role="tab"]'), (t) => t.textContent.trim()).find((t) => t.includes("crashed")) ?? null`,
        ),
      { timeout: 30_000, message: "a Logs tab for demo/crashed" },
    );
    console.log(`dock tab: ${tab}`);
    assert.ok(await app.js(`return !!document.querySelector('[data-testid="deck-headline"]')`), "still on the Overview");
    await new Promise((r) => setTimeout(r, 1500));
    await app.shot("overview-logs-dock");
    await app.js(`document.querySelectorAll('[data-testid="dock"] button[aria-label^="Close "]').forEach((b) => b.click())`);
  });
});

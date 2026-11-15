// The update banner's layout (#124): a plain debug binary cannot update
// itself, so the banner shows a long note next to its text. The text
// ("kubeloupe 9.9.9 is available — Release notes · Download from the release
// page") must stay on one line at 1280x800, with the note beside it or on its
// own row, in the dark and the light theme. A local `latest.json` is served
// through KUBELOUPE_UPDATE_ENDPOINT; nothing is downloaded or installed.

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import { byTestId } from "../lib/app.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "./area-2-helpers.mjs";

const T = { timeout: 120_000 };

const LATEST = JSON.stringify({
  version: "9.9.9",
  notes: "QA update banner test release",
  pub_date: "2026-11-01T00:00:00Z",
  platforms: {
    "linux-x86_64": { signature: "not-a-signature", url: "http://127.0.0.1:1/kubeloupe.AppImage" },
  },
});

let server;
let endpoint;

/** The banner's parts: boxes of the text, the note and ✕, and the text's line height. */
function layout(app) {
  return app.js(`
    const b = document.querySelector('[data-testid="update-banner"]');
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    const text = b.querySelector('.text');
    return {
      banner: box(b),
      text: box(text),
      note: box(b.querySelector('.note')),
      x: box(b.querySelector('button[aria-label="Dismiss update"]')),
      lineHeight: parseFloat(getComputedStyle(text).lineHeight) || 18,
    };
  `);
}

describe("update banner with a note (#124)", { timeout: 10 * 60_000 }, () => {
  before(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(LATEST) });
      res.end(LATEST);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    endpoint = `http://127.0.0.1:${server.address().port}/latest.json`;
  });
  after(() => server?.close());
  const s = appSession("update-banner", () => ({ env: { KUBELOUPE_UPDATE_ENDPOINT: endpoint } }));

  for (const theme of ["dark", "light"]) {
    it(`the text stays on one line beside the note (${theme})`, T, async () => {
      const { app } = s;
      await waitLive(app);
      await setTheme(app, theme);
      const banner = await app.find(byTestId("update-banner"), { timeout: 30_000 });
      const text = await app.js("return arguments[0].innerText", banner);
      console.log(`banner: ${text.replace(/\s+/g, " ")}`);
      assert.match(text, /cannot update itself/);
      const l = await layout(app);
      console.log(`layout: ${JSON.stringify(l)}`);
      assert.ok(l.text.h < l.lineHeight * 1.5, `the text is one line (${l.text.h}px high)`);
      assert.ok(l.note.x >= l.text.x + l.text.w || l.note.y >= l.text.y + l.text.h, "the note is beside or below the text");
      assert.ok(l.banner.x + l.banner.w - (l.x.x + l.x.w) < 20, "✕ at the right end");
    });
  }
});

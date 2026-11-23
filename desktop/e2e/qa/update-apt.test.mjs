// The update banner of a .deb install (#427). The debug build acts as a
// .deb install (NAUVI_UPDATE_BUNDLE=deb) with its apt sources in a temp
// directory (NAUVI_UPDATE_APT_DIR), and finds a newer version in a local
// `latest.json` (NAUVI_UPDATE_ENDPOINT). Nothing is downloaded or installed.
// - With the nauvi apt repository as a source, the banner says to update
//   with apt (the command and Copy), with no Install button and no
//   download link, its text on one line at 1280x800, dark and light.
// - Without it, a release with a signed .deb update still offers Install
//   (tauri-plugin-updater installs it with pkexec dpkg -i); it is not
//   clicked.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { byTestId } from "../lib/app.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { setTheme } from "../lib/theme.mjs";

const T = { timeout: 120_000 };
const COMMAND = "sudo apt update && sudo apt install nauvi";

const LATEST = JSON.stringify({
  version: "9.9.9",
  notes: "QA apt update banner test release",
  pub_date: "2026-11-01T00:00:00Z",
  platforms: {
    "linux-x86_64": { signature: "not-a-signature", url: "http://127.0.0.1:1/nauvi.AppImage" },
    "linux-x86_64-deb": { signature: "not-a-signature", url: "http://127.0.0.1:1/nauvi.deb" },
  },
});

let server;
let endpoint;
const dirs = [];

/** An /etc/apt stand-in, with the nauvi source or without. */
function aptDir(withNauvi) {
  const dir = mkdtempSync(join(tmpdir(), "nauvi-qa-apt-"));
  dirs.push(dir);
  mkdirSync(join(dir, "sources.list.d"));
  writeFileSync(join(dir, "sources.list"), "deb http://archive.ubuntu.com/ubuntu jammy main\n");
  if (withNauvi) {
    writeFileSync(
      join(dir, "sources.list.d", "nauvi.list"),
      "deb [signed-by=/etc/apt/keyrings/nauvi.gpg] https://nexburst.github.io/nauvi/apt stable main\n",
    );
  }
  return dir;
}

const buttons = (app) =>
  app.js(`return [...document.querySelectorAll('[data-testid="update-banner"] button')].map((b) => b.innerText.trim())`);

before(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(LATEST) });
    res.end(LATEST);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${server.address().port}/latest.json`;
});
after(() => {
  server?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe("a .deb from the apt repository (#427)", { timeout: 10 * 60_000 }, () => {
  const s = appSession("update-apt", () => ({
    env: { NAUVI_UPDATE_ENDPOINT: endpoint, NAUVI_UPDATE_BUNDLE: "deb", NAUVI_UPDATE_APT_DIR: aptDir(true) },
  }));

  for (const theme of ["dark", "light"]) {
    it(`says to update with apt, with no Install button (${theme})`, T, async () => {
      const { app } = s;
      await waitLive(app);
      await setTheme(app, theme);
      const banner = await app.find(byTestId("update-banner"), { timeout: 30_000 });
      const text = (await app.js("return arguments[0].innerText", banner)).replace(/\s+/g, " ");
      console.log(`banner: ${text}`);
      assert.ok(text.includes(`nauvi 9.9.9 is available — Release notes · Update with apt: ${COMMAND}`), text);
      assert.match(text, /installed from the nauvi apt repository/);
      const names = await buttons(app);
      console.log(`buttons: ${JSON.stringify(names)}`);
      assert.ok(!names.includes("Install and restart"), "no Install button");
      assert.ok(!names.includes("Download from the release page"), "no download link");
      assert.ok(names.includes("Copy"), "a Copy button");
      const h = await app.js(`
        const t = document.querySelector('[data-testid="update-banner"] .text');
        return { h: t.getBoundingClientRect().height, line: parseFloat(getComputedStyle(t).lineHeight) || 18 };
      `);
      assert.ok(h.h < h.line * 1.5, `the text is one line (${h.h}px high)`);
    });
  }
});

describe("a .deb without the apt repository (#427)", { timeout: 10 * 60_000 }, () => {
  const s = appSession("update-deb", () => ({
    env: { NAUVI_UPDATE_ENDPOINT: endpoint, NAUVI_UPDATE_BUNDLE: "deb", NAUVI_UPDATE_APT_DIR: aptDir(false) },
  }));

  it("offers Install for a signed .deb update", T, async () => {
    const { app } = s;
    await waitLive(app);
    const banner = await app.find(byTestId("update-banner"), { timeout: 30_000 });
    const text = (await app.js("return arguments[0].innerText", banner)).replace(/\s+/g, " ");
    console.log(`banner: ${text}`);
    assert.ok(text.includes("nauvi 9.9.9 is available — Release notes · Install and restart"), text);
    assert.ok(!text.includes("Update with apt"), text);
  });
});

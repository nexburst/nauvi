// No cluster needed: also the Windows job's scenario (qa.yml).
// Checks (#18, #39): with an unreachable cluster the app starts, shows the
// red status and the error banner; Settings opens and the Dark/Light theme
// applies and survives a restart.

import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { appSession } from "../lib/qa.mjs";

const T = { timeout: 120_000 };

/** A kubeconfig whose only context points at a closed local port. */
function unreachableKubeconfig() {
  const dir = mkdtempSync(join(tmpdir(), "kubeloupe-qa-kc-"));
  const path = join(dir, "kubeconfig");
  writeFileSync(
    path,
    `apiVersion: v1
kind: Config
clusters:
  - name: nowhere
    cluster:
      server: https://127.0.0.1:1
contexts:
  - name: qa-unreachable
    context:
      cluster: nowhere
      user: nobody
current-context: qa-unreachable
users:
  - name: nobody
    user:
      token: not-a-token
`,
  );
  return path;
}

const theme = (app) => app.js("return document.documentElement.dataset.theme ?? ''");

describe("startup without a reachable cluster, settings and theme", { timeout: 10 * 60_000 }, () => {
  const s = appSession("startup", { kubeconfig: unreachableKubeconfig() });

  it("shows the error banner and a red status", T, async () => {
    const { app } = s;
    const banner = await app.find(By.css('[role="alert"]'), { timeout: 60_000 });
    const text = await app.js("return arguments[0].innerText", banner);
    console.log(`banner: ${text}`);
    assert.match(text, /127\.0\.0\.1:1|reach|connect/i);
    const dot = await app.find(By.css("header .dot"));
    assert.match(await dot.getAttribute("class"), /error/);
  });

  it("opens Settings and switches to the Light theme", T, async () => {
    const { app } = s;
    await (await app.find(By.css('header button[aria-label="Settings"]'))).click();
    const dialog = await app.find(byTestId("settings"));
    for (const [label, value] of [
      ["Dark", "dark"],
      ["Light", "light"],
    ]) {
      const radio = await dialog.findElement(By.xpath(`.//label[normalize-space()='${label}']/input`));
      await app.js("arguments[0].click()", radio);
      await app.waitFor(async () => (await theme(app)) === value, { message: `data-theme=${value}` });
      await app.shot(`theme-${value}`);
    }
  });

  it("keeps the Light theme after a restart", T, async () => {
    const { app } = s;
    await app.restart();
    await app.find(By.css("header"));
    await app.waitFor(async () => (await theme(app)) === "light", { timeout: 30_000, message: "data-theme=light" });
  });
});

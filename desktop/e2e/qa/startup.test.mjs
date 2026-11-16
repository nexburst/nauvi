// No cluster needed: also the Windows job's scenario (qa.yml).
// Checks (#18, #39): with an unreachable cluster the app starts, shows the
// red status and the error banner; Settings opens and the Dark/Light theme
// applies and survives a restart.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId } from "../lib/app.mjs";
import { appSession, unreachableKubeconfig } from "../lib/qa.mjs";
import { waitTheme } from "../lib/theme.mjs";

const T = { timeout: 120_000 };


describe("startup without a reachable cluster, settings and theme", { timeout: 10 * 60_000 }, () => {
  const s = appSession("startup", { kubeconfig: unreachableKubeconfig() });

  it("shows the error banner and a red status", T, async () => {
    const { app } = s;
    const banner = await app.find(By.css('[role="alert"]'), { timeout: 60_000 });
    const text = await app.js("return arguments[0].innerText", banner);
    console.log(`banner: ${text}`);
    assert.match(text, /127\.0\.0\.1:1|reach|connect/i);
    // The status check can finish after the discovery banner (on Windows a
    // refused connect takes about 2 s, after its SYN retries).
    const dot = await app.find(By.css("header .dot"));
    await app.waitFor(async () => /\berror\b/.test(await dot.getAttribute("class")), {
      timeout: 60_000,
      message: "the red status dot",
    });
    await app.shot("unreachable");
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
      await waitTheme(app, value);
      await app.shot(`theme-${value}`);
    }
  });

  it("keeps the Light theme after a restart", T, async () => {
    const { app } = s;
    await app.restart();
    await app.find(By.css("header"));
    await waitTheme(app, "light", { timeout: 30_000 });
  });
});

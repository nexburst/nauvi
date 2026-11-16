// Checks (#217): port-forwards are saved per context and come back after a
// restart (stopped, or started when "Start automatically" is checked); the
// manager edits, starts, stops and deletes them; the dialog's "https" and
// "Open in browser" options change the URL and open it through the opener.
// Screenshots: the empty manager, the edit dialog, the manager in light and
// dark, and the manager after a restart.

import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { byTestId, xq } from "../lib/app.mjs";
import { deleteNamespace, httpPodYaml, tempNamespace, waitPodReady } from "../lib/cluster.mjs";
import { setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";

const T = { timeout: 120_000 };
const HELLO = "hello from saved forwards";
let ns;
let port;

/** A local port that is free right now. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

const viewText = (app) => app.js(`return document.querySelector('[data-testid="port-forwards"]')?.innerText ?? ""`);
const rowTexts = (app) =>
  app.js(`return Array.from(document.querySelectorAll('[data-testid="forward-row"]'), (r) => r.innerText.replace(/\\s+/g, " "))`);
const button = (app, label) => app.find(By.css(`button[aria-label=${JSON.stringify(label)}]`));

async function forwardFromPanel(app, local) {
  await app.openDetail("Pods", ns, "web");
  const panel = await app.find(byTestId("detail-panel"));
  await app.setValue(await panel.findElement(By.css('input[aria-label="Pod port"]')), "8080");
  await app.setValue(await panel.findElement(By.css('input[aria-label="Local port"]')), local);
  // The section's own Forward button (a container card's "Forward port 8080" ignores the local port).
  await (await panel.findElement(By.xpath(".//input[@aria-label='Local port']/following-sibling::button[normalize-space()='Forward']"))).click();
  const url = await app.waitFor(async () => (await panel.getText()).match(/Forwarding (http:\/\/127\.0\.0\.1:\d+)/)?.[1], {
    message: "Forwarding http://127.0.0.1:<port>",
  });
  await (await app.find(By.css('[data-testid="detail-panel"] button[aria-label="Close details"]'))).click();
  return url;
}

async function answers(url) {
  const plain = url.replace(/^https:/, "http:");
  return (await (await fetch(plain)).text()).includes(HELLO);
}

describe("saved port-forwards (#217)", { timeout: 15 * 60_000 }, () => {
  before(async () => {
    ns = tempNamespace("qa-pf-saved", httpPodYaml("web", 8080, HELLO));
    waitPodReady(ns, "web");
    port = await freePort();
  });
  after(() => deleteNamespace(ns));
  const s = appSession("port-forward-saved");
  const target = () => `pod/${ns}/web:8080`;

  it("the manager starts empty and says how to add one", T, async () => {
    const { app } = s;
    await waitLive(app);
    await app.nav("Port Forwards");
    await app.find(byTestId("forwards-empty"));
    await app.shot("empty-light");
    await setTheme(app, "dark");
    await app.shot("empty-dark");
    await setTheme(app, "light");
  });

  it("a forward is saved; editing it to https restarts it and opens it in the browser", T, async () => {
    const { app } = s;
    const url = await forwardFromPanel(app, String(port));
    assert.equal(url, `http://127.0.0.1:${port}`);
    assert.ok(await answers(url), "the forward answers");
    await app.nav("Port Forwards");
    await (await button(app, `Edit ${target()}`)).click();
    const dialog = await app.find(byTestId("forward-dialog"));
    assert.match(await dialog.getText(), /Edit port forward/);
    for (const label of ["https", "Open in browser", "Start automatically"]) {
      await (await dialog.findElement(By.css(`input[aria-label=${JSON.stringify(label)}]`))).click();
    }
    await app.shot("edit-dialog");
    const confirm = await dialog.findElement(byTestId("forward-confirm"));
    assert.equal((await confirm.getText()).trim(), "Save and restart");
    await confirm.click();
    const https = `https://127.0.0.1:${port}`;
    await app.waitFor(async () => (await viewText(app)).includes(https), { message: `${https} listed` });
    await app.waitFor(() => app.profile.opened().includes(https), {
      timeout: 10_000,
      message: `${https} opened (opened: ${app.profile.opened().join(", ")})`,
    });
    // The URL says https; the forward is TCP, so the plain-HTTP pod still answers on that port.
    assert.ok(await answers(https), "the restarted forward answers on the same port");
  });

  it("a second forward is listed; the manager in light and dark", T, async () => {
    const { app } = s;
    // "0": any free port, a second saved forward to the same pod port.
    await forwardFromPanel(app, "0");
    await app.nav("Port Forwards");
    await app.waitFor(async () => (await rowTexts(app)).length === 2, { message: "two saved forwards" });
    console.log(`rows: ${JSON.stringify(await rowTexts(app))}`);
    await app.shot("manager-light");
    const overflow = await app.js(
      `const v = document.querySelector('[data-testid="port-forwards"]'); return v.scrollWidth - v.clientWidth;`,
    );
    assert.ok(overflow <= 0, `the manager fits at 1280 px without scrolling sideways (overflow ${overflow} px)`);
    await setTheme(app, "dark");
    await app.shot("manager-dark");
    await setTheme(app, "light");
    // Saved forwards hold no credentials: just the target, ports and options.
    const saved = await app.waitFor(() => {
      const all = Object.values(app.profile.settings()?.forwards ?? {}).flat();
      return all.length === 2 ? all : null;
    }, { message: "two forwards in settings.json" });
    for (const f of saved) {
      assert.deepEqual(Object.keys(f).sort(), ["auto_start", "https", "id", "local_port", "open_in_browser", "remote", "target"]);
    }
    console.log(`settings.json forwards: ${JSON.stringify(saved)}`);
  });

  it("after a restart the auto-start one runs and the other is stopped", T, async () => {
    const { app } = s;
    const opened = app.profile.opened().length;
    await app.restart();
    await waitLive(app);
    await app.nav("Port Forwards");
    const https = `https://127.0.0.1:${port}`;
    await app.waitFor(async () => {
      const rows = await rowTexts(app);
      return rows.length === 2 && rows[0].includes(https) && rows[0].includes("Listening") && rows[1].includes("Stopped");
    }, { timeout: 30_000, message: "first forward running, second stopped" });
    await app.shot("after-restart");
    assert.ok(await answers(https), "the auto-started forward answers");
    assert.equal(app.profile.opened().length, opened, "starting on its own opens no browser");

    // Start the stopped one from the manager, stop it again, then delete it.
    await (await button(app, `Start ${target()}`)).click();
    await app.waitFor(async () => (await rowTexts(app))[1]?.includes("Listening"), { message: "second forward started" });
    const second = (await rowTexts(app))[1].match(/http:\/\/127\.0\.0\.1:\d+/)[0];
    assert.ok(await answers(second), "the second forward answers");
    await (await button(app, `Stop ${second}`)).click();
    await app.waitFor(async () => (await rowTexts(app))[1]?.includes("Stopped"), { message: "second forward stopped" });
    await assert.rejects(fetch(second), "the stopped forward's port is closed");
    // Both rows name the same target: delete the second (stopped) one.
    const deletes = await app.driver.findElements(By.css(`button[aria-label=${JSON.stringify(`Delete ${target()}`)}]`));
    await deletes[1].click();
    await app.waitFor(async () => (await rowTexts(app)).length === 1, { message: "one forward left" });
    await app.find(By.xpath(`//*[@data-testid='port-forwards']//*[contains(normalize-space(), ${xq("Forwards are saved for this cluster.")})]`));
  });

  it("the deleted one stays deleted after another restart", T, async () => {
    const { app } = s;
    await app.restart();
    await waitLive(app);
    await app.nav("Port Forwards");
    await app.waitFor(async () => (await rowTexts(app)).length === 1, { timeout: 30_000, message: "one saved forward" });
    await (await button(app, `Delete ${target()}`)).click();
    await app.find(byTestId("forwards-empty"));
    await assert.rejects(fetch(`http://127.0.0.1:${port}`), "deleting a running forward stops it");
  });
});

// #415: annotations that copy a Secret, in the detail panel.
// - a Secret with kapp's `kapp.k14s.io/original` (the whole object as JSON,
//   stringData in it) shows that annotation as "<hidden: reveal to view>",
//   like its last-applied-configuration, in light and dark
// - an annotation that only repeats one of its values is hidden too
// - other annotations keep their text
// - the YAML tab (not revealed) has none of the values either
// The redaction is done in the backend: the values never reach the webview.
// Everything lives in a temp namespace.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { By } from "selenium-webdriver";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { panelText, setTheme } from "../lib/panels.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 180_000 };
const PASSWORD = "qa-415-kapp-pw-71c4";
const TOKEN = "qa-415-token-9e02";
const HIDDEN = "<hidden: reveal to view>";
const KAPP = "kapp.k14s.io/original";
const b64 = (s) => Buffer.from(s).toString("base64");
const LEAKS = [PASSWORD, TOKEN, b64(PASSWORD), b64(TOKEN)];

const original = JSON.stringify({
  apiVersion: "v1",
  kind: "Secret",
  metadata: { name: "qa-kapp-secret", labels: { "kapp.k14s.io/app": "qa" } },
  stringData: { password: PASSWORD, token: TOKEN },
});

const fixtures = `
apiVersion: v1
kind: Secret
metadata:
  name: qa-kapp-secret
  annotations:
    ${KAPP}: '${original}'
    qa.example.com/note: 'rotated by hand, token ${TOKEN}'
    qa.example.com/team: platform
stringData:
  password: ${PASSWORD}
  token: ${TOKEN}
`;

/** The Annotations section opened, as { key: shown text }. */
async function annotations(app) {
  return app.waitFor(
    () =>
      app.js(`
        const p = document.querySelector('[data-testid="detail-panel"]');
        const d = Array.from(p?.querySelectorAll('details') ?? []).find((d) => d.querySelector('summary')?.textContent.startsWith('Annotations'));
        if (!d) return null;
        d.open = true;
        d.scrollIntoView({ block: 'start' });
        const out = {};
        for (const dt of d.querySelectorAll('dl.annotations > dt')) {
          out[dt.textContent.trim()] = dt.nextElementSibling?.textContent.replace(/\\s+/g, ' ').trim() ?? '';
        }
        return Object.keys(out).length ? out : null;`),
    { message: "the Annotations section" },
  );
}

function panelHtml(app) {
  return app.js(`return document.querySelector('[data-testid="detail-panel"]').innerHTML`);
}

function assertNoLeak(text, where) {
  for (const s of LEAKS) assert.ok(!text.includes(s), `${s} in ${where}`);
}

describe("annotations that copy a Secret (#415)", { timeout: 10 * 60_000 }, () => {
  let ns;
  before(() => {
    ns = tempNamespace("qa-415-copies", fixtures);
  });
  after(() => deleteNamespace(ns));

  const s = appSession("secret-copies");

  for (const theme of ["light", "dark"]) {
    it(`kapp's original and a value-carrying note are hidden (${theme})`, T, async () => {
      const { app } = s;
      await resizeWindow(app, 1280, 800);
      await waitLive(app);
      await setTheme(app, theme);
      await app.openDetail("Secrets", ns, "qa-kapp-secret");
      const a = await annotations(app);
      console.log(`annotations: ${JSON.stringify(a)}`);
      assert.equal(a[KAPP], HIDDEN);
      assert.equal(a["qa.example.com/note"], HIDDEN);
      assert.equal(a["qa.example.com/team"], "platform");
      assert.ok(
        Object.keys(a).some((k) => k.endsWith("last-applied-configuration")),
        "kubectl apply left its annotation",
      );
      assertNoLeak(await panelHtml(app), "the panel");
    });
  }

  it("the YAML tab shows the copies redacted too", T, async () => {
    const { app } = s;
    await setTheme(app, "light");
    await app.openDetail("Secrets", ns, "qa-kapp-secret");
    await annotations(app);
    await (await app.find(By.xpath("//*[@data-testid='detail-panel']//button[@role='tab'][normalize-space()='YAML']"))).click();
    await app.find(By.css('[data-testid="detail-panel"] .cm-content'), { timeout: 20_000 });
    const yaml = await app.waitFor(
      async () => {
        const t = await panelText(app);
        return t.includes(KAPP) ? t : null;
      },
      { message: "the kapp annotation in the YAML tab" },
    );
    assertNoLeak(yaml, "the YAML tab");
    assertNoLeak(await panelHtml(app), "the YAML tab's HTML");
  });
});

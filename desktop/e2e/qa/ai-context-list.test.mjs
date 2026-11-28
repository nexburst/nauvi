// #608: the AI context list. In WebKitGTK against kind, with a fake
// `claude` on PATH:
// - a Deployment from the Overview's Problem group (+), a PVC from its
//   table's row menu ("Add to Ask AI", next to "Ask AI about this…") and a
//   Node by Alt+click on its name: the header's Ask AI shows "| 3" (split
//   button) at 1280 and 1024 px, light and dark, and the header fits;
// - the count opens the list; "Ask AI about these 3" opens the dialog with
//   a prompt naming all three with their reasons, nothing from logs or
//   events; Cancel keeps the list, Start empties it and the CLI gets it;
// - four Pods selected: the bulk bar's "Ask AI about these 4";
// - the key strip says "Alt+click add to Ask AI";
// - on a read-only context, and without an AI CLI, none of it shows.
//
// Everything it creates is in a temporary namespace.

import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, describe, it } from "node:test";
import { By, Key } from "selenium-webdriver";
import { byTestId, CONTEXT, xq } from "../lib/app.mjs";
import { deleteNamespace, tempNamespace } from "../lib/cluster.mjs";
import { closeTab, dockTabs } from "../lib/dock.mjs";
import { createProfile } from "../lib/profile.mjs";
import { appSession, waitLive } from "../lib/qa.mjs";
import { pickNamespaces } from "../lib/table.mjs";
import { terminal } from "../lib/terminal.mjs";
import { setTheme } from "../lib/theme.mjs";
import { resizeWindow } from "../lib/window.mjs";

const T = { timeout: 300_000 };
const AI_NAMES = ["claude", "codex", "gemini"];
const GROUPS = '.overview section[aria-label="Problem groups"]';

const YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: crashy
spec:
  replicas: 4
  selector: { matchLabels: { app: crashy } }
  template:
    metadata: { labels: { app: crashy } }
    spec:
      terminationGracePeriodSeconds: 0
      containers:
        - name: app
          image: busybox:1.36
          imagePullPolicy: IfNotPresent
          command: ["sh", "-c", "echo LOG-LINE-NOT-IN-PROMPT; exit 1"]
          resources: { requests: { cpu: 1m, memory: 4Mi } }
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: claim
spec:
  storageClassName: qa-no-such-class
  accessModes: [ReadWriteOnce]
  resources: { requests: { storage: 1Mi } }
`;

// The fake AI CLI: records its arguments, then waits for "done".
const FAKE_CLAUDE = `#!/bin/sh
for a in "$@"; do printf '%s\\n--ARG--\\n' "$a"; done > "$ASK_AI_RECORD"
echo "FAKE-AI started"
while read -r line; do [ "$line" = done ] && break; done
`;

/** PATH without the directories that hold a real AI CLI. */
function pathWithoutAiClis(extra = []) {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((d) => d && !AI_NAMES.some((n) => existsSync(join(d, n))));
  return [...extra, ...dirs].join(delimiter);
}

const count = (app) => app.js(`return document.querySelector('[data-testid="ai-context-count"]')?.textContent.trim() ?? ""`);
const promptValue = (app) => app.js(`return document.querySelector('[data-testid="ask-ai-prompt"]')?.value ?? ""`);

function waitCount(app, n) {
  return app.waitFor(async () => (await count(app)) === (n ? String(n) : ""), { message: `the Ask AI count to read ${n}` });
}

async function waitDialog(app) {
  await app.find(byTestId("ask-ai-dialog"));
  await app.waitFor(async () => (await promptValue(app)) !== "", { message: "the Ask AI prompt" });
  await new Promise((r) => setTimeout(r, 400));
}

async function shotBoth(app, name) {
  for (const theme of ["light", "dark"]) {
    await setTheme(app, theme);
    await new Promise((r) => setTimeout(r, 200));
    await app.shot(`${name}-${theme}`);
  }
}

/** The header: whether it fits on one line, its height and Go to's width. */
function headerFit(app) {
  return app.js(`
    const h = document.querySelector('[data-testid="cluster-band"]');
    const free = (el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return r.right <= window.innerWidth && !!hit && el.contains(hit);
    };
    return {
      fits: h.scrollWidth <= h.clientWidth + 1,
      height: Math.round(h.getBoundingClientRect().height),
      goto: Math.round(document.querySelector('[data-testid="rail-goto"]').getBoundingClientRect().width),
      settings: free(document.querySelector('button[aria-label="Settings"]')),
      count: free(document.querySelector('[data-testid="ai-context-count"]')),
    };`);
}

async function contextMenu(app, name, namespace) {
  for (let attempt = 1; ; attempt++) {
    const row = await app.find(app.row(name, namespace));
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", row);
    await app.driver.actions().contextClick(row).perform();
    try {
      await app.find(byTestId("context-menu"), { timeout: 4000 });
      break;
    } catch (e) {
      if (attempt >= 4) throw e;
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  return app.js(`
    return Array.from(document.querySelectorAll('[data-testid="context-menu"] [role="menuitem"]'), (e) => e.textContent.trim());`);
}

async function closeMenu(app) {
  await app.driver.actions().sendKeys(Key.ESCAPE).perform();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("context-menu"))).length === 0, {
    message: "the context menu to close",
  });
}

async function setMode(app, label) {
  if ((await app.driver.findElements(byTestId("cluster-settings"))).length === 0) {
    await app.palette("cluster settings", "Cluster settings");
  }
  const dialog = await app.find(byTestId("cluster-settings"));
  const radio = await dialog.findElement(
    By.xpath(`.//label[contains(@class,'mode-choice')][.//strong[normalize-space()=${xq(label)}]]/input`),
  );
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", radio);
  await radio.click();
  await app.waitFor(async () => radio.isSelected(), { message: `${label} selected` });
  await (await dialog.findElement(By.xpath(".//button[normalize-space()='Close']"))).click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("cluster-settings"))).length === 0, {
    message: "the cluster settings to close",
  });
}

/** The crashy pods in the table. */
function crashyPods(app) {
  return app.waitFor(
    async () => {
      const names = (await app.rows()).map(([n]) => n).filter((n) => /^crashy-/.test(n));
      return names.length >= 4 ? names : null;
    },
    { timeout: 120_000, message: "4 crashy pods in the table" },
  );
}

let ns = "";
after(() => deleteNamespace(ns));

describe("The AI context list, with a fake claude on PATH (#608)", { timeout: 25 * 60_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), "nauvi-qa-ai-list-608-"));
  const bin = join(work, "bin");
  const record = join(work, "record.txt");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);
  const profile = createProfile();
  const s = appSession("ai-context-list", () => ({
    profile,
    env: { PATH: pathWithoutAiClis([profile.bin, bin]), ASK_AI_RECORD: record, CLAUDE_CONFIG_DIR: "" },
  }));
  after(() => {
    profile.remove();
    rmSync(work, { recursive: true, force: true });
  });

  let node = "";

  it("collects a Deployment (Overview), a PVC (row menu) and a Node (Alt+click)", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    ns = tempNamespace("qa-608", YAML);
    await app.find(byTestId("ask-ai-header"));
    assert.equal(await count(app), "", "no count while the list is empty");

    await app.nav("Pods");
    await pickNamespaces(app, [ns]);
    await app.nav("Overview");
    const add = await app.waitFor(
      async () => {
        const els = await app.driver.findElements(
          By.xpath(
            `//section[@aria-label='Problem groups']//*[@data-testid='problem-group'][contains(normalize-space(.), 'crashy')]//*[@data-testid='add-to-ask-ai']`,
          ),
        );
        return els[0] ?? null;
      },
      { timeout: 240_000, interval: 2000, message: "crashy's Problem group with Add to Ask AI" },
    );
    await app.js("arguments[0].scrollIntoView({ block: 'center' })", add);
    await shotBoth(app, "problem-group");
    await add.click();
    await waitCount(app, 1);
    assert.equal(await add.getAttribute("title"), "Already in the Ask AI list.");

    await app.nav("Persistent Volume Claims");
    await app.find(app.row("claim", ns));
    const items = await contextMenu(app, "claim", ns);
    console.log(JSON.stringify(items));
    assert.equal(items[items.indexOf("Ask AI about this…") + 1], "Add to Ask AI", "next to Ask AI about this…");
    await shotBoth(app, "row-menu");
    await (
      await app.find(By.xpath("//*[@data-testid='context-menu']//*[@role='menuitem'][normalize-space()='Add to Ask AI']"))
    ).click();
    await waitCount(app, 2);

    await app.nav("Nodes");
    [[node]] = await app.waitFor(async () => {
      const r = await app.rows();
      return r.length > 0 ? r : null;
    }, { message: "a node" });
    const row = await app.find(app.row(node));
    const cell = await row.findElement(By.xpath(`./*[@role='gridcell'][normalize-space()=${xq(node)} or @aria-label=${xq(node)}]`));
    await app.driver.actions().keyDown(Key.ALT).click(cell).keyUp(Key.ALT).perform();
    await waitCount(app, 3);
    assert.equal((await app.driver.findElements(byTestId("detail-panel"))).length, 0, "Alt+click opens no panel");

    // The key strip names the gesture (the focused row's strip).
    await app.clickRow(node);
    const keys = await app.waitFor(
      () => app.js(`return document.querySelector('[data-testid="row-keys"]')?.innerText ?? null`),
      { message: "the key strip" },
    );
    assert.match(keys.replace(/\s+/g, " "), /Alt\+click ?add to Ask AI/);
    await app.driver.actions().sendKeys(Key.ESCAPE).perform();
    await shotBoth(app, "key-strip");
  });

  it("the header: Ask AI | 3, on one line at 1280 and 1024 px, light and dark", T, async () => {
    const { app } = s;
    for (const [w, h] of [
      [1280, 800],
      [1024, 768],
    ]) {
      await resizeWindow(app, w, h);
      await new Promise((r) => setTimeout(r, 400));
      const fit = await headerFit(app);
      console.log(w, JSON.stringify(fit));
      assert.ok(fit.fits, `the header fits at ${w}`);
      assert.ok(fit.height <= 41, `one line at ${w}: ${fit.height}px`);
      assert.ok(fit.goto >= (w >= 1180 ? 280 : 120), `Go to keeps its floor at ${w}: ${fit.goto}px`);
      assert.ok(fit.settings && fit.count, `Settings and the count are reachable at ${w}`);
      await shotBoth(app, `header-${w}`);
    }
    await resizeWindow(app, 1280, 800);
  });

  it("the list names all three; one Ask AI asks about them; Cancel keeps it, Start empties it", T, async () => {
    const { app } = s;
    await (await app.find(byTestId("ai-context-count"))).click();
    await app.find(byTestId("ai-context-panel"));
    const listed = await app.js(
      `return Array.from(document.querySelectorAll('[data-testid="ai-context-item"]'), (e) => e.innerText.replace(/\\s+/g, " ").trim())`,
    );
    console.log(JSON.stringify(listed));
    assert.equal(listed.length, 3);
    await new Promise((r) => setTimeout(r, 300));
    await shotBoth(app, "list-open");

    await (await app.find(byTestId("ai-context-ask"))).click();
    await waitDialog(app);
    const prompt = await promptValue(app);
    console.log(prompt);
    const lines = prompt.split("\n");
    assert.equal(lines[0], `Look at these objects in context ${CONTEXT} and tell me how they relate and what is wrong:`);
    assert.match(lines[1], new RegExp(`^- Deployment ${ns}/crashy \\(\\S+`));
    assert.match(lines[2], new RegExp(`^- PersistentVolumeClaim ${ns}/claim`));
    assert.equal(lines[3], `- Node ${node}`);
    assert.ok(!prompt.includes("LOG-LINE-NOT-IN-PROMPT"), "nothing from the logs");
    assert.ok(!prompt.includes("qa-no-such-class"), "nothing from the events");
    await shotBoth(app, "dialog-3");

    await (await app.find(By.xpath("//*[@data-testid='ask-ai-dialog']//button[normalize-space()='Cancel']"))).click();
    await app.waitFor(async () => (await app.driver.findElements(byTestId("ask-ai-dialog"))).length === 0, {
      message: "the dialog to close",
    });
    assert.equal(await count(app), "3", "Cancel keeps the list");

    await (await app.find(byTestId("ai-context-count"))).click();
    await (await app.find(byTestId("ai-context-ask"))).click();
    await waitDialog(app);
    await (await app.find(byTestId("ask-ai-start"))).click();
    const term = terminal(app);
    await term.waitFor("FAKE-AI started", { timeout: 90_000 });
    await waitCount(app, 0);
    assert.deepEqual((await dockTabs(app)).map((t) => t.title), ["AI: 3 objects"]);
    const args = readFileSync(record, "utf8").split("\n--ARG--\n").filter(Boolean);
    assert.ok(args.at(-1).startsWith(prompt), `the CLI got the list's prompt: ${args.at(-1)}`);
    await closeTab(app, "AI: 3 objects");
  });

  it("four selected Pods: Ask AI about these 4", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    const pods = await crashyPods(app);
    for (const p of pods.slice(0, 4)) await (await app.find(By.css(`input[aria-label="Select ${p}"]`))).click();
    const ask = await app.find(byTestId("bulk-ask-ai"));
    assert.equal((await ask.getText()).trim(), "Ask AI about these 4");
    await shotBoth(app, "bulk");
    await ask.click();
    await waitDialog(app);
    const lines = (await promptValue(app)).split("\n");
    assert.equal(lines.slice(1, 5).filter((l) => l.startsWith(`- Pod ${ns}/crashy-`)).length, 4, lines.join("\n"));
    await shotBoth(app, "dialog-4");
    await app.driver.actions().sendKeys(Key.ESCAPE).perform();
    await (await app.find(By.xpath("//*[@aria-label='Selection']//button[normalize-space()='Clear']"))).click();
    assert.equal(await count(app), "", "the selection is not the list");
  });

  it("a read-only context offers none of it", T, async () => {
    const { app } = s;
    await setMode(app, "Read-only");
    try {
      const pods = await crashyPods(app);
      const items = await contextMenu(app, pods[0], ns);
      assert.ok(!items.includes("Add to Ask AI"), JSON.stringify(items));
      await closeMenu(app);
      await (await app.find(By.css(`input[aria-label="Select ${pods[0]}"]`))).click();
      assert.equal((await app.driver.findElements(byTestId("bulk-ask-ai"))).length, 0);
      await shotBoth(app, "read-only-table");
      await (await app.find(By.xpath("//*[@aria-label='Selection']//button[normalize-space()='Clear']"))).click();
      await app.nav("Overview");
      await app.find(By.css(GROUPS));
      assert.equal((await app.driver.findElements(byTestId("add-to-ask-ai"))).length, 0);
      await shotBoth(app, "read-only-overview");
    } finally {
      await setMode(app, "Normal");
    }
  });
});

describe("The AI context list without an AI CLI on PATH (#608)", { timeout: 10 * 60_000 }, () => {
  const profile = createProfile();
  const s = appSession("ai-context-list-none", () => ({ profile, env: { PATH: pathWithoutAiClis([profile.bin]) } }));
  after(() => profile.remove());

  it("no Ask AI, no Add to Ask AI, no hint", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    assert.equal((await app.driver.findElements(byTestId("ask-ai-header"))).length, 0);
    if (ns) {
      await app.nav("Pods");
      await pickNamespaces(app, [ns]);
      await app.nav("Overview");
      await app.find(By.css(GROUPS));
      assert.equal((await app.driver.findElements(byTestId("add-to-ask-ai"))).length, 0);
      await app.nav("Pods");
      const pods = await crashyPods(app);
      await app.clickRow(pods[0], ns);
      const keys = await app.waitFor(
        () => app.js(`return document.querySelector('[data-testid="row-keys"]')?.innerText ?? null`),
        { message: "the key strip" },
      );
      assert.ok(!/Ask AI/.test(keys), keys);
      await shotBoth(app, "no-cli");
    }
  });
});

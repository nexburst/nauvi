// #607: Ask AI stands out and is where problems are. In WebKitGTK against
// kind, with a fake `claude` on PATH:
// - the header's Ask AI is accented (tint, accent border and icon; the
//   label in the accent in dark, in --text in light), at 1280x800 in both
//   themes; Go to keeps its x when Ask AI is not there (second app, no CLI);
// - a Problem group (a Deployment of 3 crash-looping pods) has Ask AI after
//   Logs and Describe; it opens the dialog with a prompt naming the
//   Deployment, the reason and "3 of 3 pods", and nothing from its logs or
//   events; Start runs the CLI with that prompt;
// - a Warning group (a PVC whose StorageClass does not exist) has Ask AI,
//   naming the PVC and the reason;
// - the dialog: a prompt of 8 lines or more, one line of caveats and
//   Details, a filled Start;
// - the row menu is grouped with rules, "Ask AI about this…" with its icon
//   next to "Copy prompt for your AI", destructive items last; the detail
//   panel's Ask AI is a labelled button;
// - on a read-only context the rows, the row menu and the panel offer no
//   Ask AI; without an AI CLI nothing does.
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
const WARNINGS = '.overview section[aria-label="Warning groups"]';

const YAML = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: crashy
spec:
  replicas: 3
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

/** Colours and box of the header's Ask AI, and the x of Go to. */
function headerState(app) {
  return app.js(`
    const probe = (v) => {
      const s = document.createElement("span");
      s.style.color = "var(" + v + ")";
      document.body.append(s);
      const c = getComputedStyle(s).color;
      s.remove();
      return c;
    };
    const b = document.querySelector('[data-testid="ask-ai-header"]');
    const st = b && getComputedStyle(b);
    return {
      gotoX: Math.round(document.querySelector('[data-testid="rail-goto"]').getBoundingClientRect().left),
      button: b ? {
        border: st.borderTopColor,
        background: st.backgroundColor,
        label: getComputedStyle(b.querySelector("span")).color,
        icon: getComputedStyle(b.querySelector("svg")).color,
        padding: st.padding,
        fontSize: st.fontSize,
      } : null,
      accent: probe("--accent"),
      text: probe("--text"),
    };`);
}

const dialogText = (app) => app.js(`return document.querySelector('[data-testid="ask-ai-dialog"]')?.innerText ?? ""`);
const promptValue = (app) => app.js(`return document.querySelector('[data-testid="ask-ai-prompt"]')?.value ?? ""`);

async function waitDialog(app) {
  await app.find(byTestId("ask-ai-dialog"));
  await app.waitFor(async () => (await promptValue(app)) !== "", { message: "the Ask AI prompt" });
  // Past the dialog's fade-in, so screenshots show it settled.
  await new Promise((r) => setTimeout(r, 400));
}

async function closeDialog(app) {
  await app.driver.actions().sendKeys(Key.ESCAPE).perform();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("ask-ai-dialog"))).length === 0, {
    message: "the Ask AI dialog to close",
  });
}

async function shotBoth(app, name) {
  for (const theme of ["light", "dark"]) {
    await setTheme(app, theme);
    await app.shot(`${name}-${theme}`);
  }
}

/** The row of `name` in a group section, once it is there. */
function groupRow(app, section, rowSel, text) {
  return app.waitFor(
    () =>
      app.js(
        `return Array.from(document.querySelectorAll(arguments[0] + " " + arguments[1]))
           .map((r) => ({ text: r.innerText.replace(/\\s+/g, " ").trim(),
                          actions: Array.from(r.querySelectorAll(".actions button"), (b) => b.textContent.trim()) }))
           .find((r) => r.text.includes(arguments[2])) ?? null`,
        section,
        rowSel,
        text,
      ),
    { timeout: 240_000, interval: 2000, message: `a row with ${text} in ${section}` },
  );
}

async function clickRowAskAi(app, section, rowSel, text) {
  const button = await app.find(
    By.xpath(
      `//section[@aria-label=${xq(section)}]//*[contains(concat(' ', normalize-space(@class), ' '), ' ${rowSel} ')][contains(normalize-space(.), ${xq(text)})]//*[@data-testid='ask-ai-row']`,
    ),
  );
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", button);
  await button.click();
}

/** The row menu's items and rules, as drawn: "|" for a rule. */
async function openRowMenu(app, name, namespace) {
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
    return Array.from(document.querySelectorAll('[data-testid="context-menu"] [role="menuitem"], [data-testid="context-menu"] [role="separator"]'),
      (e) => e.getAttribute("role") === "separator" ? "|" : e.textContent.trim());`);
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

let gotoWithAskAi = -1;
let ns = "";
// After both apps: the second looks at the same namespace.
after(() => deleteNamespace(ns));

describe("Ask AI where problems are, with a fake claude on PATH (#607)", { timeout: 25 * 60_000 }, () => {
  const work = mkdtempSync(join(tmpdir(), "nauvi-qa-ask-ai-607-"));
  const bin = join(work, "bin");
  const record = join(work, "record.txt");
  mkdirSync(bin);
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  chmodSync(join(bin, "claude"), 0o755);
  const profile = createProfile();
  const s = appSession("ask-ai-everywhere", () => ({
    profile,
    env: { PATH: pathWithoutAiClis([profile.bin, bin]), ASK_AI_RECORD: record, CLAUDE_CONFIG_DIR: "" },
  }));
  after(() => {
    profile.remove();
    rmSync(work, { recursive: true, force: true });
  });

  it("the header's Ask AI is accented, readable in light and dark at 1280x800", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    ns = tempNamespace("qa-607", YAML);
    await app.find(byTestId("ask-ai-header"));
    for (const theme of ["dark", "light"]) {
      await setTheme(app, theme);
      const h = await headerState(app);
      console.log(theme, JSON.stringify(h));
      assert.equal(h.button.border, h.accent, "accent border");
      assert.equal(h.button.icon, h.accent, "accent icon");
      assert.equal(h.button.label, theme === "dark" ? h.accent : h.text, "label colour");
      assert.notEqual(h.button.background, "rgba(0, 0, 0, 0)", "a tinted fill");
      assert.equal(h.button.padding, "3px 8px");
      assert.equal(h.button.fontSize, "12px");
      gotoWithAskAi = h.gotoX;
      await app.shot(`header-${theme}`);
    }
  });

  it("a Problem group's Ask AI asks about the Deployment, its reason and its pods", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    await pickNamespaces(app, [ns]);
    await app.nav("Overview");
    const row = await app.waitFor(
      async () => {
        const r = await groupRow(app, GROUPS, '[data-testid="problem-group"]', "crashy");
        return /3 of 3 pods/.test(r.text) ? r : null;
      },
      { timeout: 240_000, interval: 2000, message: "crashy as one group of 3 pods" },
    );
    assert.deepEqual(row.actions, ["Logs", "Describe", "Ask AI"], "Ask AI after Logs and Describe");
    await shotBoth(app, "problem-group");

    await clickRowAskAi(app, "Problem groups", "problem", "crashy");
    await waitDialog(app);
    assert.match(await dialogText(app), new RegExp(`Ask AI about Deployment ${ns}/crashy`));
    const prompt = await promptValue(app);
    assert.match(
      prompt,
      new RegExp(`^Look at Deployment ${ns}/crashy in context ${CONTEXT}: 3 of 3 pods are (in )?\\S+.*\\. Find out why`),
    );
    assert.ok(!prompt.includes("LOG-LINE-NOT-IN-PROMPT"), "nothing from the logs");
    assert.ok(!/crashy-[a-z0-9]+-[a-z0-9]{5}/.test(prompt), "no pod names, only the workload");
    // The dialog: 8 lines or more, one line of caveats, a filled Start.
    const box = await app.js(`
      const t = document.querySelector('[data-testid="ask-ai-prompt"]');
      const start = document.querySelector('[data-testid="ask-ai-start"]');
      return { height: t.getBoundingClientRect().height, fits: t.scrollHeight <= t.clientHeight + 1,
               open: document.querySelector('[data-testid="ask-ai-shell-note"]').open,
               startBg: getComputedStyle(start).backgroundColor,
               width: document.querySelector('[data-testid="ask-ai-dialog"]').getBoundingClientRect().width };`);
    console.log(JSON.stringify(box));
    assert.ok(box.height >= 150, `the prompt shows 8 lines: ${box.height}px`);
    assert.ok(box.fits, "the whole prompt shows");
    assert.equal(box.open, false, "the caveats are folded");
    assert.match(await dialogText(app), /Runs Claude Code in a local terminal with this cluster's kubeconfig/);
    await shotBoth(app, "dialog-problem-group");

    await (await app.find(byTestId("ask-ai-start"))).click();
    const term = terminal(app);
    await term.waitFor("FAKE-AI started", { timeout: 90_000 });
    assert.deepEqual((await dockTabs(app)).map((t) => t.title), ["AI: crashy"]);
    const args = readFileSync(record, "utf8").split("\n--ARG--\n").filter(Boolean);
    // One argument: the prompt, then (without the nauvi CLI on PATH) the
    // guidance the backend adds.
    assert.ok(args.at(-1).startsWith(prompt), `the CLI got the prompt as one argument: ${args.at(-1)}`);
    assert.ok(!args.at(-1).includes("LOG-LINE-NOT-IN-PROMPT"));
    await closeTab(app, "AI: crashy");
  });

  it("a Warning group's Ask AI asks about the object and the reason", T, async () => {
    const { app } = s;
    const row = await groupRow(app, WARNINGS, '[data-testid="warning-group"]', "claim");
    assert.deepEqual(row.actions, ["Ask AI"]);
    await shotBoth(app, "warning-group");
    await clickRowAskAi(app, "Warning groups", "event", "claim");
    await waitDialog(app);
    const prompt = await promptValue(app);
    assert.match(
      prompt,
      new RegExp(`^Look at PersistentVolumeClaim ${ns}/claim in context ${CONTEXT}: it has warning events with reason \\w+`),
    );
    assert.ok(!prompt.includes("qa-no-such-class"), "nothing from the event's message");
    await closeDialog(app);
  });

  it("the row menu is grouped; Ask AI about this… sits next to Copy prompt for your AI", T, async () => {
    const { app } = s;
    await app.nav("Pods");
    const pod = await app.waitFor(
      () =>
        app.js(
          `return Array.from(document.querySelectorAll('[data-testid="resource-row"] [role="gridcell"]'), (c) => c.textContent.trim())
             .find((t) => /^crashy-/.test(t)) ?? null`,
        ),
      { message: "a crashy pod in the table" },
    );
    const items = await openRowMenu(app, pod, ns);
    console.log(JSON.stringify(items));
    assert.deepEqual(items, [
      "Logs",
      "Shell",
      "Attach",
      "Debug…",
      "|",
      "Edit YAML",
      "Port forward…",
      "|",
      "Ask AI about this…",
      "Copy prompt for your AI",
      "Copy link",
      "|",
      "Evict",
      "Delete",
      "Force delete…",
    ]);
    await shotBoth(app, "row-menu");
    await (
      await app.find(By.xpath("//*[@data-testid='context-menu']//*[@role='menuitem'][normalize-space()='Ask AI about this…']"))
    ).click();
    await waitDialog(app);
    assert.match(await promptValue(app), new RegExp(`^Look at Pod ${ns}/${pod} in context ${CONTEXT}`));
    await closeDialog(app);

    // The detail panel: a labelled Ask AI.
    await app.clickRow(pod, ns);
    const label = await app.waitFor(
      () =>
        app.js(
          `return document.querySelector('[data-testid="detail-panel"] [role="toolbar"] button[data-action="askAi"]')?.textContent.trim() ?? null`,
        ),
      { message: "the panel's Ask AI" },
    );
    assert.equal(label, "Ask AI");
    await shotBoth(app, "detail-panel");
    await app.driver.actions().sendKeys(Key.ESCAPE).perform();
  });

  it("the Workloads overview's Problem workloads have Ask AI, naming the workload and its reason", T, async () => {
    const { app } = s;
    await (await app.find(By.css('nav button[aria-label="Workloads overview"]'))).click();
    const row = await groupRow(app, '[data-testid="workloads-overview"]', '[data-testid="problem-workload"]', "crashy");
    assert.deepEqual(row.actions, ["Ask AI"]);
    await shotBoth(app, "workloads-overview");
    await clickRowAskAi(app, "Problem workloads", "problem", "crashy");
    await waitDialog(app);
    const prompt = await promptValue(app);
    assert.match(prompt, new RegExp(`^Look at Deployment ${ns}/crashy in context ${CONTEXT}: it shows (\\d of 3 ready|"[^"]*"|\\w+)\\. Find out why`));
    assert.ok(!prompt.includes("LOG-LINE-NOT-IN-PROMPT"));
    await closeDialog(app);
    await app.nav("Pods");
  });

  it("a read-only context offers no Ask AI on the rows, the menu or the panel", T, async () => {
    const { app } = s;
    await setMode(app, "Read-only");
    try {
      const pod = await app.js(
        `return Array.from(document.querySelectorAll('[data-testid="resource-row"] [role="gridcell"]'), (c) => c.textContent.trim())
           .find((t) => /^crashy-/.test(t)) ?? null`,
      );
      const items = await openRowMenu(app, pod, ns);
      assert.ok(!items.includes("Ask AI about this…"), JSON.stringify(items));
      assert.ok(items.includes("Copy prompt for your AI"));
      await closeMenu(app);
      await app.nav("Overview");
      await groupRow(app, GROUPS, '[data-testid="problem-group"]', "crashy");
      assert.equal((await app.driver.findElements(byTestId("ask-ai-row"))).length, 0);
      await shotBoth(app, "read-only-overview");
    } finally {
      await setMode(app, "Normal");
    }
  });
});

describe("Ask AI without an AI CLI on PATH (#607)", { timeout: 10 * 60_000 }, () => {
  const profile = createProfile();
  const s = appSession("ask-ai-everywhere-none", () => ({ profile, env: { PATH: pathWithoutAiClis([profile.bin]) } }));
  after(() => profile.remove());

  it("no Ask AI anywhere; Go to keeps its place", T, async () => {
    const { app } = s;
    await resizeWindow(app, 1280, 800);
    await waitLive(app);
    assert.equal((await app.driver.findElements(byTestId("ask-ai-header"))).length, 0);
    const h = await headerState(app);
    if (gotoWithAskAi >= 0) assert.ok(Math.abs(h.gotoX - gotoWithAskAi) <= 1, `Go to at ${h.gotoX}, was ${gotoWithAskAi}`);
    await shotBoth(app, "header-no-cli");
    if (ns) {
      await app.nav("Pods");
      await pickNamespaces(app, [ns]);
      await app.nav("Overview");
      await groupRow(app, GROUPS, '[data-testid="problem-group"]', "crashy");
      assert.equal((await app.driver.findElements(byTestId("ask-ai-row"))).length, 0);
      await shotBoth(app, "overview-no-cli");
    }
  });
});

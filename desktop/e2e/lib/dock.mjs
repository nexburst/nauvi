// The bottom dock (#42): its tabs, its panes, resizing and maximizing it,
// and the pod panel's buttons that open tabs in it. Also a kubeconfig with
// a second context on the same cluster, for checks that switch context.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { By, Key, Origin } from "selenium-webdriver";
import { CONTEXT, byTestId, xq } from "./app.mjs";

/** CSS selector of the pane of dock tab `id` (e.g. `logs:ns/pod`, `shell:ns/pod`). */
export const pane = (id) => `[data-testid="dock-pane"][data-tab=${JSON.stringify(id)}]`;

/** CSS selector of the terminal in dock tab `id`, for `terminal(app, root)`. */
export const paneTerminal = (id) => `${pane(id)} [data-testid="terminal"]`;

/** The dock's tabs: `{ title, active }` in order (empty without a dock). */
export function dockTabs(app) {
  return app.js(
    `return Array.from(document.querySelectorAll('[data-testid="dock"] [role="tab"]'), (t) => ({
       title: t.textContent.trim(),
       active: t.getAttribute("aria-selected") === "true",
     }));`,
  );
}

/** Ids of the mounted dock panes, in order. */
export function dockPaneIds(app) {
  return app.js(`return Array.from(document.querySelectorAll('[data-testid="dock-pane"]'), (p) => p.dataset.tab);`);
}

/** The dock's height in CSS pixels (0 without a dock). */
export function dockHeight(app) {
  return app.js(`return document.querySelector('[data-testid="dock"]')?.getBoundingClientRect().height ?? 0;`);
}

/** Click a dock tab by its title. */
export async function activateTab(app, title) {
  await clickInStrip(app, By.xpath(`//*[@data-testid='dock']//button[@role='tab'][normalize-space()=${xq(title)}]`));
}

/** Click the ✕ of a dock tab by its title. */
export async function closeTab(app, title) {
  await clickInStrip(app, By.css(`[data-testid="dock"] button[aria-label=${JSON.stringify(`Close ${title}`)}]`));
}

/**
 * The tab strip scrolls sideways when many tabs are open; WebKitGTK's driver
 * refuses to click a button that is not fully in view.
 */
async function clickInStrip(app, locator) {
  const button = await app.find(locator);
  await app.js("arguments[0].scrollIntoView({ block: 'nearest', inline: 'center' })", button);
  try {
    await button.click();
  } catch (e) {
    if (e.name !== "ElementNotInteractableError") throw e;
    // #116: WebKitGTK's overlay scrollbar used to cover the lower half of an
    // overflowing strip and take the clicks. Say what is in the way.
    const at = await app.js(
      `const r = arguments[0].getBoundingClientRect();
       const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
       return JSON.stringify({ rect: [r.x, r.y, r.width, r.height], at: el?.outerHTML.slice(0, 120) });`,
      button,
    );
    throw new Error(`WebDriver could not click a dock strip button (#116): ${at}`, { cause: e });
  }
}

/**
 * The strip's hit test: whether a click at the centre and near the bottom of
 * every tab's label and ✕ reaches that button, and how much room the strip's
 * scrollbar takes (`offsetHeight - clientHeight`; 0 for an overlay one).
 */
export function stripHitTest(app) {
  return app.js(`
    const strip = document.querySelector('[data-testid="dock"] [role="tablist"]');
    const misses = [];
    for (const b of strip.querySelectorAll('.tab button')) {
      b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = b.getBoundingClientRect();
      for (const y of [r.y + r.height / 2, r.y + r.height - 3]) {
        const el = document.elementFromPoint(r.x + r.width / 2, y);
        if (el !== b && !b.contains(el)) {
          misses.push((b.getAttribute('aria-label') || b.textContent.trim()) + ' at y=' + Math.round(y) + ': ' + (el?.outerHTML.slice(0, 60) ?? 'nothing'));
        }
      }
    }
    strip.scrollLeft = 0;
    return {
      tabs: strip.querySelectorAll('.tab').length,
      overflows: strip.scrollWidth > strip.clientWidth,
      scrollbar: strip.offsetHeight - strip.clientHeight,
      misses,
    };
  `);
}

/** Click one of the strip's controls by aria-label ("Maximize dock", "New local terminal", ...). */
export async function dockControl(app, label) {
  await (await app.find(By.css(`[data-testid="dock"] button[aria-label=${JSON.stringify(label)}]`))).click();
}

/**
 * Drag the dock's top edge by `dy` pixels (negative: up, a taller dock)
 * with real pointer events. Returns the new height.
 */
export async function dragDock(app, dy) {
  const resizer = await app.find(byTestId("dock-resizer"));
  await app.driver
    .actions()
    .move({ origin: resizer })
    .press()
    .move({ origin: Origin.POINTER, x: 0, y: Math.round(dy / 2) })
    .move({ origin: Origin.POINTER, x: 0, y: dy - Math.round(dy / 2) })
    .release()
    .perform();
  return dockHeight(app);
}

/** Press Ctrl+<key> on whatever has the focus. */
export async function pressCtrl(app, key) {
  await app.driver.actions().keyDown(Key.CONTROL).sendKeys(key).keyUp(Key.CONTROL).perform();
}

/** Click a button in the open detail panel: its action bar ("Attach", "Debug…", "Shell") or "Logs" / "Open terminal". */
export async function panelButton(app, label) {
  const button = await app.find(
    By.xpath(`//*[@data-testid='detail-panel']//button[normalize-space()=${xq(label)}]`),
  );
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", button);
  await button.click();
}

/** Open a pod's detail panel and click Logs; returns the tab id. */
export async function openPodLogs(app, namespace, name) {
  await app.openDetail("Pods", namespace, name);
  await panelButton(app, "Logs");
  const id = `logs:${namespace}/${name}`;
  await app.find(By.css(pane(id)));
  return id;
}

/** The log lines rendered in a log tab, as text. */
export function logLines(app, id) {
  return app.js(
    `return Array.from(document.querySelectorAll(arguments[0] + ' [data-testid="log-line"]'), (l) => l.textContent);`,
    pane(id),
  );
}

/** The status text next to the log filter ("123 lines", "paused · …", "saved to …"). */
export function logStatus(app, id) {
  return app.js(
    `return Array.from(document.querySelectorAll(arguments[0] + ' .logs-options > span.muted'), (s) => s.textContent.trim()).join(' ');`,
    pane(id),
  );
}

/**
 * A kubeconfig with the test context plus `alias`, a second context on the
 * same cluster and user, so a scenario can switch context without a second
 * cluster. Written to a private temp dir; call `remove()` when done.
 */
export function aliasKubeconfig(alias = `${CONTEXT}-alias`) {
  const dir = mkdtempSync(join(tmpdir(), "kubeloupe-qa-area4-"));
  const path = join(dir, "kubeconfig");
  const yaml = execFileSync("kubectl", ["config", "view", "--minify", "--flatten", "--context", CONTEXT], {
    encoding: "utf8",
  });
  writeFileSync(path, yaml, { mode: 0o600 });
  const env = { ...process.env, KUBECONFIG: path };
  const cfg = JSON.parse(execFileSync("kubectl", ["config", "view", "-o", "json"], { encoding: "utf8", env }));
  const ctx = cfg.contexts.find((c) => c.name === CONTEXT).context;
  execFileSync("kubectl", ["config", "set-context", alias, `--cluster=${ctx.cluster}`, `--user=${ctx.user}`], { env });
  return { path, alias, remove: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Local shell temp kubeconfigs (`kubeloupe-shell-<pid>-<n>.yaml`) in `dir`. */
export function shellKubeconfigs(dir) {
  try {
    return readdirSync(dir).filter((f) => /^kubeloupe-shell-\d+-\d+\.yaml$/.test(f));
  } catch {
    return [];
  }
}

/** The pid of the app whose HOME is `home` (Linux: reads /proc), or null. */
export function appPid(home) {
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      if (!comm.startsWith("kubeloupe-desk")) continue;
      const env = readFileSync(`/proc/${pid}/environ`, "utf8").split("\0");
      if (env.includes(`HOME=${home}`)) return Number(pid);
    } catch {
      /* gone, or not ours */
    }
  }
  return null;
}

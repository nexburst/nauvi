// The detail panel's sections (#34, #35, #47, #77, #79): related groups,
// usage charts, the theme. Reads the DOM with `app.js` (WebKitWebDriver's
// getText() is unreliable inside tables).

import { By } from "selenium-webdriver";
import { byTestId, xq } from "./app.mjs";

const PANEL = '[data-testid="detail-panel"]';

/** The detail panel's visible text ("" when no panel is open). */
export function panelText(app) {
  return app.js(`return document.querySelector('${PANEL}')?.innerText ?? ""`);
}

/** The panel's title line, e.g. "Deployment demo/web". */
export function panelTitle(app) {
  return app.js(`return document.querySelector('${PANEL} .title')?.textContent.trim() ?? ""`);
}

/** Wait until the panel's title contains `text`. */
export function waitPanelTitle(app, text, timeout = 20_000) {
  return app.waitFor(async () => (await panelTitle(app)).includes(text), {
    timeout,
    message: `detail panel titled "${text}"`,
  });
}

/**
 * Open a cluster-scoped object (a Node, a ClusterRole, ...) from its table.
 */
export async function openClusterDetail(app, kindLabel, name) {
  await app.nav(kindLabel);
  await app.filter(name);
  await (await app.find(app.row(name))).click();
  await waitPanelTitle(app, name);
}

/**
 * The related groups of the open panel:
 * [{ title, count, error, columns, rows: [[cell, ...]], links: [name, ...] }].
 */
export function relatedGroups(app) {
  return app.js(`
    return Array.from(document.querySelectorAll('${PANEL} [data-testid="related-group"]'), (g) => ({
      title: g.getAttribute('aria-label'),
      count: g.querySelector('h3 .count')?.textContent.trim() ?? '',
      error: g.querySelector('.error-text')?.textContent.trim() ?? '',
      columns: Array.from(g.querySelectorAll('thead th'), (th) => th.textContent.trim()),
      rows: Array.from(g.querySelectorAll('tbody tr'), (tr) => Array.from(tr.cells, (td) => td.textContent.trim())),
      links: Array.from(g.querySelectorAll('tbody button.link'), (b) => b.textContent.trim()),
    }));`);
}

/** Wait for a related group titled `title` (with rows, unless `empty`). */
export function waitRelatedGroup(app, title, { empty = false, timeout = 30_000 } = {}) {
  return app.waitFor(
    async () => {
      const g = (await relatedGroups(app)).find((x) => x.title === title);
      return g && (empty || g.error || g.rows.length > 0) ? g : null;
    },
    { timeout, message: `related group "${title}"` },
  );
}

/** Click the link `name` in the related group `title`. */
export async function openRelated(app, title, name) {
  const link = await app.find(
    By.xpath(
      `//*[@data-testid='detail-panel']//section[@data-testid='related-group'][@aria-label=${xq(title)}]` +
        `//button[contains(@class,'link')][normalize-space()=${xq(name)}]`,
    ),
  );
  await app.js("arguments[0].scrollIntoView({ block: 'center' })", link);
  try {
    await link.click();
  } catch (e) {
    if (e.name !== "ElementNotInteractableError") throw e;
    // WebKitWebDriver sometimes refuses links inside a horizontally
    // scrolling table even when they are in view; say what is at the
    // link's centre, then click it the way a user's click lands.
    const hit = await app.js(
      `const r = arguments[0].getBoundingClientRect();
       const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
       return { rect: [r.x, r.y, r.width, r.height], hit: el?.outerHTML.slice(0, 120) ?? null, same: el === arguments[0] };`,
      link,
    );
    const before = await panelTitle(app);
    let moved = "no";
    try {
      const [x, y, w, h] = hit.rect;
      await app.driver
        .actions()
        .move({ origin: "viewport", x: Math.round(x + w / 2), y: Math.round(y + h / 2) })
        .click()
        .perform();
      moved = (await app.waitFor(async () => (await panelTitle(app)) !== before, { timeout: 3000 }).catch(() => false))
        ? "opened"
        : "nothing happened";
    } catch (e2) {
      moved = `refused: ${e2.name}`;
    }
    console.log(`openRelated: WebDriver refused the click on ${name} (${JSON.stringify(hit)}); pointer click: ${moved}`);
    if (moved === "opened") return;
    if (!hit.same) throw new Error(`the link ${name} is covered: ${JSON.stringify(hit)}`);
    await app.js("arguments[0].click()", link);
  }
}

/** The one-line kind summary and facts at the top of a generic panel. */
export function kindSummary(app) {
  return app.js(`
    return {
      line: document.querySelector('${PANEL} [data-testid="kind-summary"]')?.textContent.trim() ?? '',
      facts: document.querySelector('${PANEL} [data-testid="kind-facts"]')?.innerText.trim() ?? '',
    };`);
}

/**
 * The usage charts of the open panel, or null without them:
 * { source, since, empty, note, ranges: [{ label, active }],
 *   cpu|memory: { caption, series: { name: points }, refs: [label], legend: [text] } }.
 * `series` counts the points of each polyline (a lone sample is a circle: 1).
 */
export function usageCharts(app) {
  return app.js(`
    const c = document.querySelector('${PANEL} [data-testid="usage-charts"]');
    if (!c) return null;
    const chart = (r) => {
      const f = c.querySelector('[data-testid="usage-chart-' + r + '"]');
      if (!f) return null;
      const series = {};
      for (const el of f.querySelectorAll('[data-series]'))
        series[el.dataset.series] = el.tagName.toLowerCase() === 'circle' ? 1
          : (el.getAttribute('points') ?? '').trim().split(/\\s+/).filter(Boolean).length;
      return {
        caption: f.querySelector('figcaption')?.textContent.replace(/\\s+/g, ' ').trim() ?? '',
        series,
        refs: Array.from(f.querySelectorAll('line.ref'), (l) => l.dataset.ref),
        legend: Array.from(f.querySelectorAll('.legend li'), (li) => li.textContent.replace(/\\s+/g, ' ').trim()),
      };
    };
    const text = (id) => c.querySelector('[data-testid="' + id + '"]')?.textContent.trim() ?? '';
    return {
      source: text('usage-source'),
      since: text('usage-since'),
      empty: text('usage-empty'),
      note: text('usage-note'),
      ranges: Array.from(c.querySelectorAll('.ranges button'), (b) => ({
        label: b.textContent.trim(), active: b.getAttribute('aria-pressed') === 'true' })),
      text: c.innerText,
      cpu: chart('cpu'),
      memory: chart('memory'),
    };`);
}

/** Most points of any series in a chart (0 without the chart). */
export function maxPoints(chart) {
  return Math.max(0, ...Object.values(chart?.series ?? {}));
}

/** Wait for usage charts whose CPU total line has at least `points` points. */
export function waitUsagePoints(app, points, { timeout = 90_000, series } = {}) {
  return app.waitFor(
    async () => {
      const u = await usageCharts(app);
      if (!u?.cpu) return null;
      const n = series ? (u.cpu.series[series] ?? 0) : maxPoints(u.cpu);
      return n >= points ? u : null;
    },
    { timeout, interval: 1000, message: `usage charts with ${points}+ points` },
  );
}

/** Scroll the open panel so that `css` (inside it) is in view. */
export function scrollPanelTo(app, css) {
  return app.js(
    `document.querySelector('${PANEL} ' + arguments[0])?.scrollIntoView({ block: 'start' })`,
    css,
  );
}

// The theme: set it and wait until it shows (lib/theme.mjs, #276).
export { setTheme } from "./theme.mjs";

/** Whether the action buttons at the top of the panel are all disabled. */
export function actionButtons(app) {
  return app.js(`
    return Array.from(document.querySelectorAll('${PANEL} [role="toolbar"][aria-label="Actions"] button'),
      (b) => ({ label: b.textContent.trim(), disabled: b.disabled }));`);
}

/** Close the detail panel if one is open. */
export async function closePanel(app) {
  const close = await app.driver.findElements(By.css(`${PANEL} button[aria-label="Close details"]`));
  if (close.length) await close[0].click();
  await app.waitFor(async () => (await app.driver.findElements(byTestId("detail-panel"))).length === 0, {
    message: "the detail panel to close",
  });
}

/**
 * Show the metrics-server history ("Live") when the charts offer ranges
 * (a context with Prometheus starts on 1h). No-op without range buttons.
 * Waits for the charts to load first.
 */
export async function useLiveRange(app) {
  await app.waitFor(
    async () => {
      const u = await usageCharts(app);
      return u && !u.text.includes("Loading");
    },
    { timeout: 60_000, message: "the usage charts to load" },
  );
  const live = await app.driver.findElements(
    By.xpath("//*[@data-testid='detail-panel']//*[@aria-label='Usage range']//button[normalize-space()='Live']"),
  );
  if (live.length === 0) return false;
  await live[0].click();
  await app.waitFor(async () => !(await usageCharts(app))?.source, { message: "the Live (metrics-server) charts" });
  return true;
}

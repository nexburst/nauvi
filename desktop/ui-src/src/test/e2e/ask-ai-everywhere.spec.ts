import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import type { ContextMode } from "../../lib/bindings";
import type { FakeCluster } from "../fixtures/cluster";
import { problemGroups, warning } from "../fixtures/overview";
import { openApp, openKind, row } from "./helpers";

// Ask AI stands out and is where problems are (#607): the accented header
// button, Ask AI on Problem groups and Warning groups, "Ask AI about this…"
// in every table's row menu, and the dialog's layout.

const dialog = (page: Page) => page.getByTestId("ask-ai-dialog");
const prompt = (page: Page) => dialog(page).getByTestId("ask-ai-prompt");
const menu = (page: Page) => page.getByRole("menu");

// Init functions run in the page as source text: no captured variables.
const withClaude = (cluster: FakeCluster) => {
  cluster.askAi = { found: ["claude"], nauvi: true, customError: "" };
};

/** The page with an AI CLI and the context in `mode`. */
async function openWithMode(page: Page, mode: ContextMode) {
  await page.addInitScript(`window.__mode = ${JSON.stringify(mode)};`);
  return openApp(page, (cluster) => {
    cluster.askAi = { found: ["claude"], nauvi: true, customError: "" };
    cluster.settings.contexts["kind-dev"] = {
      view: "",
      namespaces: [],
      typed_namespaces: [],
      prometheus: "",
      display_name: "",
      color: "",
      default_namespace: "",
      shell_cwd: "",
      last_used: 0,
      hide_metrics: false,
      mode: (window as unknown as { __mode: ContextMode }).__mode,
      mode_source: { file: "", given: "", context: "" },
    };
  });
}

/** WCAG contrast of `el`'s text on what is drawn behind it (its own
 *  background, composited over its ancestors'). */
function contrast(el: Locator): Promise<number> {
  return el.evaluate((node) => {
    const parse = (c: string) => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
    };
    const over = (top: number[], bottom: number[]) => {
      const a = top[3] + bottom[3] * (1 - top[3]);
      return [0, 1, 2].map((i) => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / (a || 1)).concat(a);
    };
    const layers: number[][] = [];
    for (let n: Element | null = node; n; n = n.parentElement) layers.push(parse(getComputedStyle(n).backgroundColor));
    let bg = [255, 255, 255, 1];
    for (const l of layers.reverse()) bg = over(l, bg);
    const fg = over(parse(getComputedStyle(node).color), bg);
    const lum = (c: number[]) => {
      const [r, g, b] = c.slice(0, 3).map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
    return (hi + 0.05) / (lo + 0.05);
  });
}

const setTheme = (page: Page, theme: "light" | "dark") =>
  page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);

const cssVar = (page: Page, name: string) =>
  page.evaluate((n) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  }, name);

test("the header's Ask AI is accented and readable in both themes; Go to keeps its place without it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, withClaude);
  const button = page.getByTestId("ask-ai-header");
  const label = button.locator("span");
  const icon = button.locator("svg");
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    const accent = await cssVar(page, "--accent");
    await expect(button).toHaveCSS("border-top-color", accent);
    await expect(icon).toHaveCSS("color", accent);
    // The label: the accent in dark; --text in light, where the accent on
    // its tint would be 4.3:1.
    await expect(label).toHaveCSS("color", await cssVar(page, theme === "dark" ? "--accent" : "--text"));
    expect(await contrast(label)).toBeGreaterThanOrEqual(theme === "dark" ? 7 : 10);
    // Same size as before: 12 px, padding 3px 8px, radius 7 px.
    await expect(button).toHaveCSS("font-size", "12px");
    await expect(button).toHaveCSS("padding", "3px 8px");
    await expect(button).toHaveCSS("border-top-left-radius", "7px");
    await page.screenshot({ path: test.info().outputPath(`header-${theme}.png`), clip: { x: 0, y: 0, width: 1280, height: 48 } });
  }
  // The Terminal stays neutral.
  await expect(page.getByTestId("terminal-header")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  const gotoX = await page.getByTestId("rail-goto").evaluate((el) => el.getBoundingClientRect().left);

  const other = await page.context().newPage();
  await other.setViewportSize({ width: 1280, height: 800 });
  await openApp(other);
  await expect(other.getByTestId("ask-ai-header")).toHaveCount(0);
  const without = await other.getByTestId("rail-goto").evaluate((el) => el.getBoundingClientRect().left);
  expect(Math.abs(without - gotoX)).toBeLessThan(1);
  await other.close();
});

for (const withAi of [false, true]) {
  test(`at 1024 px the header keeps every button reachable (${withAi ? "with" : "without"} Ask AI)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 700 });
    await openApp(page, withAi ? withClaude : undefined);
    await expect(page.getByTestId("ask-ai-header")).toHaveCount(withAi ? 1 : 0);
    const header = page.getByTestId("cluster-band");
    expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    // Nothing overlaps them: the button itself is under its centre.
    for (const name of ["Open in new window", "Cluster catalog", "Settings"]) {
      const free = await page.getByRole("button", { name, exact: true }).evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return r.right <= window.innerWidth && !!hit && el.contains(hit);
      });
      expect(free, name).toBe(true);
    }
  });
}

test("a Problem group's Ask AI asks about the workload, its reason and its pods, nothing from logs", async ({
  page,
}) => {
  const fake = await openApp(page, withClaude);
  const created = Math.floor(Date.now() / 1000) - 3600;
  const pod = (i: number) => ({
    namespace: "demo",
    name: `web-5d8f-${i}`,
    status: "CrashLoopBackOff",
    reason: "CrashLoopBackOff",
    restarts: 10,
    created,
    owner_kind: "Deployment",
    owner_name: "web",
  });
  const problems = Array.from({ length: 18 }, (_, i) => pod(i));
  const backOff = warning({
    key: "demo/web-5d8f-0.1",
    reason: "BackOff",
    message: "Back-off restarting failed container app: SECRET-IN-MESSAGE",
    object_name: "web-5d8f-0",
    time: created + 3000,
    count: 40,
  });
  const base = (await page.evaluate(() => window.__fake.cluster.overview.pods))!;
  await fake.emitOverview({
    pods: {
      ...base,
      problems,
      problems_total: 18,
      ...problemGroups(problems, { "demo/Deployment/web": 20 }, [backOff]),
    },
    events: { namespace: null, items: [] },
  });
  const group = page.getByRole("region", { name: "Problem groups" }).locator(".problem").first();
  // Next to Logs and Describe.
  await expect(group.locator(".actions").getByRole("button")).toHaveText(["Logs", "Describe", "Ask AI", ""]);
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    expect(await contrast(group.getByTestId("ask-ai-row"))).toBeGreaterThanOrEqual(4.5);
    await page
      .getByRole("region", { name: "Problem groups" })
      .screenshot({ path: test.info().outputPath(`problem-groups-${theme}.png`) });
  }
  await group.getByRole("button", { name: "Ask AI about demo/web" }).click();
  await expect(dialog(page)).toContainText("Ask AI about Deployment demo/web");
  await expect(prompt(page)).toHaveValue(
    /^Look at Deployment demo\/web in context kind-dev: 18 of 20 pods are in CrashLoopBackOff \(180 restarts\)\. Find out why/,
  );
  const text = await prompt(page).inputValue();
  expect(text).not.toContain("SECRET-IN-MESSAGE");
  expect(text).not.toContain("web-5d8f");
  await dialog(page).getByTestId("ask-ai-start").click();
  await expect.poll(() => fake.calls("cmdAskAiStart")).toHaveLength(1);
  expect(await fake.lastCall("cmdAskAiStart")).toMatchObject({ namespace: "demo", cli: "claude", prompt: text });
  await expect(page.getByTestId("dock").getByRole("tab")).toHaveText(["AI: web"]);
  expect(fake.errors).toEqual([]);
});

test("a Warning group's Ask AI asks about its object and reason", async ({ page }) => {
  const fake = await openApp(page, withClaude);
  const now = Math.floor(Date.now() / 1000);
  await fake.emitOverview({
    events: {
      namespace: null,
      items: [
        warning({
          key: "payments/w0",
          reason: "BackOff",
          message: "Back-off restarting failed container worker: SECRET-IN-MESSAGE",
          object: "Pod/payments-worker-0",
          object_namespace: "payments",
          object_name: "payments-worker-0",
          time: now - 60,
          count: 212,
        }),
      ],
    },
  });
  const warningRow = page.getByRole("region", { name: "Warning groups" }).locator(".event");
  await expect(warningRow).toHaveCount(1);
  await warningRow.getByTestId("ask-ai-row").click();
  await expect(dialog(page)).toContainText("Ask AI about Pod payments/payments-worker-0");
  await expect(prompt(page)).toHaveValue(
    /^Look at Pod payments\/payments-worker-0 in context kind-dev: it has warning events with reason BackOff, 212 times\./,
  );
  expect(await prompt(page).inputValue()).not.toContain("SECRET-IN-MESSAGE");
  expect(fake.errors).toEqual([]);
});

test("every table's row menu has Ask AI about this…, next to Copy prompt for your AI", async ({ page }) => {
  const fake = await openApp(page, withClaude);
  for (const [kind, name, subject] of [
    ["Pods", "web-1", "Pod demo/web-1"],
    ["Deployments", "web", "Deployment demo/web"],
    ["Nodes", "node-1", "Node node-1"],
    ["Secrets", "db-creds", "Secret demo/db-creds"],
  ] as const) {
    await openKind(page, kind);
    await row(page, name).click({ button: "right" });
    const items = await menu(page).getByRole("menuitem").allTextContents();
    const at = items.indexOf("Ask AI about this…");
    expect(at, `${kind}: ${items.join(", ")}`).toBeGreaterThan(0);
    // "Add to Ask AI" sits next to it (#608).
    expect(items[at + 1]).toBe("Add to Ask AI");
    expect(items[at + 2]).toBe("Copy prompt for your AI");
    // With the header button's icon.
    await expect(menu(page).getByRole("menuitem", { name: "Ask AI about this…" }).locator("svg")).toHaveAttribute(
      "data-icon",
      "sparkles",
    );
    if (kind === "Pods") await menu(page).screenshot({ path: test.info().outputPath("row-menu.png") });
    await menu(page).getByRole("menuitem", { name: "Ask AI about this…" }).click();
    await expect(dialog(page)).toContainText(`Ask AI about ${subject}`);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
  }
  expect(await fake.calls("cmdAskAiStart")).toEqual([]);
  expect(fake.errors).toEqual([]);
});

test("the menu's items are 28 px, keys small and on the right; it enters from the pointer", async ({ page }) => {
  await openApp(page, withClaude);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  const logs = menu(page).getByRole("menuitem", { name: "Logs", exact: true });
  expect(await logs.evaluate((el) => el.getBoundingClientRect().height)).toBe(28);
  await expect(logs).toHaveCSS("font-size", "13px");
  await expect(menu(page).locator("kbd").first()).toHaveCSS("font-size", "11px");
  await expect(menu(page).getByRole("separator")).toHaveCount(3);
  // Nothing under reduced motion (the tests' default); 140 ms otherwise.
  await expect(menu(page)).toHaveCSS("animation-name", "none");
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await row(page, "web-1").click({ button: "right" });
  await expect(menu(page)).toHaveCSS("animation-duration", "0.14s");
});

test("the dialog: a prompt of 8 lines or more, one line of caveats with Details, a filled Start", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, withClaude);
  await page.getByTestId("ask-ai-header").click();
  await expect(prompt(page)).toHaveValue(/^Look at the cluster/);
  expect(await dialog(page).evaluate((el) => el.getBoundingClientRect().width)).toBe(600);
  const height = () => prompt(page).evaluate((el) => el.getBoundingClientRect().height);
  expect(await height()).toBeGreaterThanOrEqual(150);
  // The whole prompt shows: nothing scrolls.
  expect(await prompt(page).evaluate((el) => el.scrollHeight <= el.clientHeight)).toBe(true);
  // It grows with the text up to 12 lines, then scrolls.
  await prompt(page).press("End");
  await prompt(page).pressSequentially("\n1\n2\n3\n4\n5\n6\n7\n8\n9\n10");
  const tall = await height();
  expect(tall).toBeGreaterThan(150);
  expect(tall).toBeLessThan(260);

  const caveats = dialog(page).getByTestId("ask-ai-shell-note");
  await expect(dialog(page).getByTestId("ask-ai-caveat")).toHaveText(
    "Runs Claude Code in a local terminal with this cluster's kubeconfig; your CLI asks before it runs commands.",
  );
  await expect(caveats.getByText("the skill is not read-only")).toBeHidden();
  await caveats.getByText("Details").click();
  await expect(caveats.getByText(/the skill is not read-only/)).toBeVisible();
  // The skill line stays visible.
  await expect(dialog(page).getByTestId("ask-ai-skill")).toBeVisible();

  const start = dialog(page).getByTestId("ask-ai-start");
  for (const theme of ["dark", "light"] as const) {
    await setTheme(page, theme);
    await expect(start).toHaveCSS("background-color", await cssVar(page, "--accent"));
    await expect(start).toHaveCSS("color", await cssVar(page, "--on-accent"));
    expect(await contrast(start)).toBeGreaterThanOrEqual(4.5);
    await dialog(page).screenshot({ path: test.info().outputPath(`dialog-${theme}.png`) });
  }
});

test("the detail panel's Ask AI is a labelled button, on the bar's first row", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, withClaude);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  const panel = page.getByTestId("detail-panel");
  const ask = panel.getByRole("button", { name: "Ask AI about this…" });
  await expect(ask).toHaveText("Ask AI");
  await expect(ask).toHaveCSS("border-top-color", await cssVar(page, "--accent"));
  const top = (name: string) =>
    panel.getByRole("button", { name, exact: true }).evaluate((el) => Math.round(el.getBoundingClientRect().top));
  expect(await top("Ask AI about this…")).toBe(await top("Logs"));
  await panel.getByRole("toolbar", { name: "Actions" }).screenshot({ path: test.info().outputPath("action-bar.png") });
});

test("without an AI CLI and on a read-only context the rows offer no Ask AI", async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole("region", { name: "Problem groups" }).locator(".problem").first()).toBeVisible();
  await expect(page.getByTestId("ask-ai-row")).toHaveCount(0);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Copy prompt for your AI" })).toBeVisible();
  await expect(menu(page).getByRole("menuitem", { name: "Ask AI about this…" })).toHaveCount(0);
});

test("a read-only context hides the rows' and the panel's Ask AI", async ({ page }) => {
  await openWithMode(page, "readOnly");
  await expect(page.getByRole("region", { name: "Problem groups" }).locator(".problem").first()).toBeVisible();
  await expect(page.getByTestId("ask-ai-row")).toHaveCount(0);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await expect(menu(page).getByRole("menuitem", { name: "Copy prompt for your AI" })).toBeVisible();
  await expect(menu(page).getByRole("menuitem", { name: "Ask AI about this…" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await row(page, "web-1").click();
  await expect(page.getByTestId("detail-panel").getByRole("button", { name: "Copy link" })).toBeVisible();
  await expect(page.getByTestId("detail-panel").getByRole("button", { name: "Ask AI about this…" })).toHaveCount(0);
});

test("a protected context still asks for its name when a Problem group's Ask AI starts", async ({ page }) => {
  const fake = await openWithMode(page, "protected");
  const group = page.getByRole("region", { name: "Problem groups" }).locator(".problem").first();
  await group.getByTestId("ask-ai-row").click();
  await dialog(page).getByTestId("ask-ai-start").click();
  const confirm = page.getByTestId("protected-confirm");
  await expect(confirm).toBeVisible();
  expect(await fake.calls("cmdAskAiStart")).toEqual([]);
  await confirm.getByTestId("protected-confirm-input").fill("kind-dev");
  await confirm.getByTestId("protected-confirm-button").click();
  await expect.poll(() => fake.calls("cmdAskAiStart")).toHaveLength(1);
});

test("the Workloads overview's Problem workloads and Warning groups have Ask AI (#606)", async ({ page }) => {
  const fake = await openApp(page, withClaude);
  await page.getByRole("navigation").getByRole("button", { name: "Workloads overview" }).click();
  const view = page.getByTestId("workloads-overview");
  const problems = view.getByRole("region", { name: "Problem workloads" });
  await expect(problems.locator(".problem")).toHaveCount(3);
  await expect(problems.getByTestId("ask-ai-row")).toHaveCount(3);
  await problems.getByRole("button", { name: "Ask AI about Deployment demo/api" }).click();
  await expect(dialog(page)).toContainText("Ask AI about Deployment demo/api");
  await expect(prompt(page)).toHaveValue(
    /^Look at Deployment demo\/api in context kind-dev: it shows 1 of 3 ready\. Find out why/,
  );
  await page.keyboard.press("Escape");

  const warnings = view.getByRole("region", { name: "Warning groups" });
  await warnings.getByTestId("ask-ai-row").click();
  await expect(prompt(page)).toHaveValue(
    /^Look at \S+ demo\/\S+ in context kind-dev: it has warning events with reason \w+/,
  );
  expect(await prompt(page).inputValue()).not.toContain("Failed to create");
  await page.keyboard.press("Escape");
  await view.screenshot({ path: test.info().outputPath("workloads-overview.png") });
  expect(fake.errors).toEqual([]);
});

test("a read-only context: the Workloads overview's rows offer no Ask AI", async ({ page }) => {
  await openWithMode(page, "readOnly");
  await page.getByRole("navigation").getByRole("button", { name: "Workloads overview" }).click();
  const problems = page.getByTestId("workloads-overview").getByRole("region", { name: "Problem workloads" });
  await expect(problems.locator(".problem")).toHaveCount(3);
  await expect(page.getByTestId("ask-ai-row")).toHaveCount(0);
});

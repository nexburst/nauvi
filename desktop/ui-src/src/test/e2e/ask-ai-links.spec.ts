import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { FakeCluster } from "../fixtures/cluster";
import { openApp, openKind, row } from "./helpers";

// #548: nauvi:// links in the Ask AI terminal open the object in the same
// window (plain text or OSC 8); the same link printed by a pod shell does
// nothing.

const panel = (page: Page) => page.getByTestId("detail-panel");
const sidebar = (page: Page, name: string) => page.getByRole("navigation").getByRole("button", { name, exact: true });
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });
const osc8 = (uri: string, text: string) => `\x1b]8;;${uri}\x07${text}\x1b]8;;\x07`;

const withClis = (cluster: FakeCluster) => {
  cluster.askAi = { found: ["claude"], nauvi: true, customError: "" };
};

async function startAskAi(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("ask ai");
  await expect(palette(page).getByRole("option").first()).toContainText("Ask AI");
  await page.keyboard.press("Enter");
  await page.getByTestId("ask-ai-start").click();
  await expect(page.getByTestId("dock").getByRole("tab")).toHaveCount(1);
}

/** Hover the text `text` in the terminal until the tooltip says `title`, then click it. */
async function clickText(page: Page, text: string, title?: string) {
  const terminal = page.getByTestId("terminal");
  const span = terminal.locator(".xterm-rows span", { hasText: text }).first();
  const found: { box?: { x: number; y: number; width: number; height: number } | null } = {};
  await expect(async () => {
    found.box = await span.boundingBox({ timeout: 1000 });
    expect(found.box).not.toBeNull();
  }).toPass();
  const { x: left, y: top, width, height } = found.box!;
  // The start of the text: a plain-text link's span may hold more than the link.
  const x = left + Math.min(width / 2, 40);
  const y = top + height / 2;
  await page.mouse.move(x - 2, y);
  await page.mouse.move(x, y);
  if (title !== undefined) await expect(terminal.locator(".screen")).toHaveAttribute("title", title);
  await page.mouse.click(x, y);
}

test("a nauvi:// link in the Ask AI terminal opens the object in this window", async ({ page }) => {
  const fake = await openApp(page, withClis);
  await openKind(page, "Nodes");
  await startAskAi(page);
  await expect.poll(() => fake.calls("cmdAskAiStart")).toHaveLength(1);
  await page.evaluate(
    (data) => window.__fake.emitExecOutput("local-1", data),
    [
      "Pod demo/web-2 restarts:\r\n",
      "nauvi://kind-dev/core/v1/Pod/demo/web-2\r\n",
      osc8("nauvi://kind-dev/apps/v1/Deployment/demo/api", "DEPLOYLINK"),
      "\r\n",
      "nauvi://gone/core/v1/Pod/demo/web-1\r\n",
    ].join(""),
  );

  // Plain text: found by the link provider, opened here.
  await clickText(page, "nauvi://kind-dev/core/v1/Pod/demo/web-2", "Open Pod demo/web-2 (kind-dev) in nauvi");
  await expect(panel(page)).toContainText("web-2");
  await expect(sidebar(page, "Pods")).toHaveClass(/active/);
  expect(await fake.calls("cmdCheckLink")).toEqual([{ link: "nauvi://kind-dev/core/v1/Pod/demo/web-2" }]);

  // OSC 8: the tooltip says where it goes, whatever the text says.
  await clickText(page, "DEPLOYLINK", "Open Deployment demo/api (kind-dev) in nauvi");
  await expect(panel(page)).toContainText("api");
  await expect(sidebar(page, "Deployments")).toHaveClass(/active/);

  // A context that is not the user's: a notice, nothing opened.
  await clickText(page, "nauvi://gone/", "Open Pod demo/web-1 (gone) in nauvi");
  await expect(page.getByRole("alert")).toContainText("which is not in your kubeconfigs. Nothing was opened.");
  await expect(panel(page)).toContainText("api");
  // Navigating only: no context switch, no action, no new window.
  expect(await fake.calls("cmdSetContext")).toEqual([]);
  expect(await fake.calls("cmdRunAction")).toEqual([]);
  expect(await fake.calls("cmdOpenWindow")).toEqual([]);
  expect(fake.errors).toEqual([]);
});

test("the same link in a pod shell does nothing", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Shell" }).click();
  await expect.poll(async () => (await fake.calls("cmdExecStart")).length).toBe(1);
  await page.evaluate(
    (data) => window.__fake.emitExecOutput("exec-1", data),
    `nauvi://kind-dev/core/v1/Node/_/node-2\r\n${osc8("nauvi://kind-dev/core/v1/Node/_/node-1", "NODELINK")}\r\n`,
  );
  await clickText(page, "nauvi://kind-dev/core/v1/Node");
  await clickText(page, "NODELINK");
  await expect(page.getByTestId("terminal").locator(".screen")).not.toHaveAttribute("title", /in nauvi/);
  // Give a click time to have reached the backend, had it gone anywhere.
  await page.waitForTimeout(300);
  expect(await fake.calls("cmdCheckLink")).toEqual([]);
  await expect(sidebar(page, "Pods")).toHaveClass(/active/);
  await expect(panel(page).getByText(/node-/)).toHaveCount(0);
});

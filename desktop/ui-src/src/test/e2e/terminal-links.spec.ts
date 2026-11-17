import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// #245: OSC 8 links in a shell's output open only when they are http(s),
// in the browser through the opener; `javascript:`, `file:` and custom
// schemes do nothing (no `window.open`, no prompt, no navigation).

const osc8 = (uri: string, text: string) => `\x1b]8;;${uri}\x07${text}\x1b]8;;\x07`;

/**
 * Hover, then click the middle of the text `text` in the terminal. With
 * `title`, wait until xterm has resolved the hovered link (the tooltip shows
 * where it goes) before clicking: xterm only activates a link that was
 * already under the mouse on mousedown.
 */
async function clickText(page: Page, text: string, title?: string) {
  const terminal = page.getByTestId("terminal");
  const span = terminal.locator(".xterm-rows span", { hasText: text }).first();
  // xterm's DOM renderer rebuilds a row's spans whenever it redraws the row
  // (focus, cursor, selection), so the span found here may be detached by
  // the time it is measured. Its place on screen stays the same: retry the
  // measurement with a fresh span until one is attached.
  const found: { box?: { x: number; y: number; width: number; height: number } | null } = {};
  await expect(async () => {
    found.box = await span.boundingBox({ timeout: 1000 });
    expect(found.box).not.toBeNull();
  }).toPass();
  const { x: left, y: top, width, height } = found.box!;
  const x = left + width / 2;
  const y = top + height / 2;
  await page.mouse.move(x - 2, y);
  await page.mouse.move(x, y);
  if (title !== undefined) await expect(terminal.locator(".screen")).toHaveAttribute("title", title);
  await page.mouse.click(x, y);
}

test("terminal links open only http(s) URLs, through the opener", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __windowOpens: string[] };
    w.__windowOpens = [];
    window.open = (url?: string | URL) => {
      w.__windowOpens.push(String(url));
      return null;
    };
  });
  const dialogs: string[] = [];
  page.on("dialog", (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });

  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Shell" }).click();
  await expect(page.getByTestId("terminal").locator(".xterm-screen")).toBeVisible();
  await expect.poll(async () => (await fake.calls("cmdExecStart")).length).toBe(1);

  await page.evaluate(
    (data) => window.__fake.emitExecOutput("exec-1", data),
    [
      osc8("javascript:alert(document.domain)", "BADJSLINK"),
      " ",
      osc8("file:///etc/passwd", "BADFILELINK"),
      " ",
      osc8("vscode://file/etc/passwd", "BADSCHEMELINK"),
      "\r\n",
      osc8("https://example.com/nauvi-245", "GOODLINK"),
      "\r\n",
    ].join(""),
  );

  for (const bad of ["BADJSLINK", "BADFILELINK", "BADSCHEMELINK"]) await clickText(page, bad);
  await clickText(page, "GOODLINK", "https://example.com/nauvi-245");

  await expect.poll(() => page.evaluate(() => window.__fake.opened())).toEqual(["https://example.com/nauvi-245"]);
  expect(await page.evaluate(() => (window as unknown as { __windowOpens: string[] }).__windowOpens)).toEqual([]);
  expect(dialogs).toEqual([]);
  expect(page.url()).toContain("test.html");
});

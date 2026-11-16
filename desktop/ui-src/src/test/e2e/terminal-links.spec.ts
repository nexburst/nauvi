import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// #245: OSC 8 links in a shell's output open only when they are http(s),
// in the browser through the opener; `javascript:`, `file:` and custom
// schemes do nothing (no `window.open`, no prompt, no navigation).

const osc8 = (uri: string, text: string) => `\x1b]8;;${uri}\x07${text}\x1b]8;;\x07`;

/** Hover, then click the middle of the text `text` in the terminal. */
async function clickText(page: Page, text: string) {
  const span = page.getByTestId("terminal").locator(".xterm-rows span", { hasText: text }).first();
  await expect(span).toBeVisible();
  const box = (await span.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x - 2, y);
  await page.mouse.move(x, y);
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
      osc8("https://example.com/kubeloupe-245", "GOODLINK"),
      "\r\n",
    ].join(""),
  );

  for (const bad of ["BADJSLINK", "BADFILELINK", "BADSCHEMELINK"]) await clickText(page, bad);
  await clickText(page, "GOODLINK");
  await expect(page.getByTestId("terminal").locator(".screen")).toHaveAttribute("title", "https://example.com/kubeloupe-245");

  await expect.poll(() => page.evaluate(() => window.__fake.opened())).toEqual(["https://example.com/kubeloupe-245"]);
  expect(await page.evaluate(() => (window as unknown as { __windowOpens: string[] }).__windowOpens)).toEqual([]);
  expect(dialogs).toEqual([]);
  expect(page.url()).toContain("test.html");
});

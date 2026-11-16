import { expect, test } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

// #222: Ctrl+Shift+F (⌘F on macOS) searches a terminal's output; plain
// Ctrl+F still goes to the shell.

test("Ctrl+Shift+F searches the terminal, with a count and next/previous; Ctrl+F stays the shell's", async ({
  page,
}) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Shell" }).click();
  const terminal = page.getByTestId("terminal");
  await expect(terminal.locator(".xterm-screen")).toBeVisible();
  await expect.poll(async () => (await fake.calls("cmdExecStart")).length).toBe(1);
  await page.evaluate(() =>
    window.__fake.emitExecOutput("exec-1", "needle one\r\nhay\r\nneedle two\r\nNeedle three\r\n$ "),
  );
  await expect(terminal.locator(".xterm-rows")).toContainText("Needle three");
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();

  // Plain Ctrl+F is the shell's (forward-char).
  await page.keyboard.press("Control+f");
  await expect.poll(async () => (await fake.calls("cmdExecInput")).map((c) => c.data)).toContain("\x06");
  const search = page.getByTestId("terminal-search");
  await expect(search).toHaveCount(0);

  await page.keyboard.press("Control+Shift+F");
  await expect(search).toBeVisible();
  const input = search.getByRole("textbox", { name: "Find in terminal" });
  await expect(input).toBeFocused();
  const count = page.getByTestId("terminal-search-count");

  await input.fill("needle");
  await expect(count).toHaveText(/^\d of 3$/);
  const first = await count.textContent();
  await page.keyboard.press("Enter");
  await expect(count).not.toHaveText(first!);
  await page.keyboard.press("Shift+Enter");
  await expect(count).toHaveText(first!);
  await search.getByRole("button", { name: "Next match" }).click();
  await expect(count).not.toHaveText(first!);
  await expect(terminal.locator(".xterm-decoration-top-layer, .xterm-decoration-container").first()).toBeAttached();

  // Match case: "Needle" is no longer a match.
  await search.getByRole("button", { name: "Aa" }).click();
  await expect(count).toHaveText(/^\d of 2$/);
  await input.fill("nothing-here");
  await expect(count).toHaveText("No matches");
  await expect(search.getByRole("button", { name: "Next match" })).toBeDisabled();

  // Esc closes it and gives the shell the focus back, without sending Esc.
  const before = (await fake.calls("cmdExecInput")).length;
  await page.keyboard.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(page.locator(".xterm-helper-textarea")).toBeFocused();
  await page.keyboard.type("x");
  await expect.poll(async () => (await fake.calls("cmdExecInput")).slice(before).map((c) => c.data)).toEqual(["x"]);

  // Opened again: the last query is kept and selected.
  await page.keyboard.press("Control+Shift+F");
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("nothing-here");
  await page.keyboard.press("Escape");

  // Outside the terminal the shortcut does nothing.
  await row(page, "web-1").click();
  await page.keyboard.press("Control+Shift+F");
  await expect(search).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("the shortcut help lists the terminal search", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press("?");
  const help = page.getByTestId("shortcut-help");
  await expect(help.getByRole("heading", { name: "Terminal" })).toBeVisible();
  await expect(help).toContainText("Ctrl+Shift+F");
});

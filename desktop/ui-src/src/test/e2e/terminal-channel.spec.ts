import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";
import type { Fake } from "./helpers";

// #115: each terminal session has its own channel; output comes as raw
// bytes, written into xterm once per frame, and `closed` as JSON.

async function openShell(page: Page): Promise<Fake> {
  await page.setViewportSize({ width: 1280, height: 800 });
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Shell" }).click();
  await expect(page.getByTestId("terminal").locator(".xterm-screen")).toBeVisible();
  await expect.poll(() => fake.calls("cmdExecStart")).toHaveLength(1);
  return fake;
}

const rows = (page: Page) => page.getByTestId("terminal").locator(".xterm-rows");

test("a character split between two messages is drawn whole", async ({ page }) => {
  await openShell(page);
  const bytes = [...new TextEncoder().encode("grüße €5 😀\r\n$ ")];
  // Cut inside "ü", "€" and the emoji.
  const cuts = [3, 9, 14, bytes.length];
  await page.evaluate(
    async ({ bytes, cuts }) => {
      let from = 0;
      for (const to of cuts) {
        await window.__fake.emitExecOutput("exec-1", bytes.slice(from, to));
        from = to;
      }
    },
    { bytes, cuts },
  );
  await expect(rows(page)).toContainText("grüße €5 😀");
  await expect(rows(page)).not.toContainText("�");
});

test("a flood of output is all drawn while typing still reaches the shell", async ({ page }) => {
  const fake = await openShell(page);
  // 4 MB in 2,000 messages, all at once.
  await page.evaluate(async () => {
    const line = "x".repeat(99) + "\r\n";
    const chunk = line.repeat(20);
    for (let i = 0; i < 2000; i++) await window.__fake.emitExecOutput("exec-1", chunk);
    await window.__fake.emitExecOutput("exec-1", "FLOOD-END\r\n$ ");
  });
  await page.locator(".xterm-helper-textarea").pressSequentially("ls");
  await expect.poll(async () => (await fake.calls("cmdExecInput")).map((c) => c.data).join("")).toBe("ls");
  await expect(rows(page)).toContainText("FLOOD-END", { timeout: 30_000 });
});

test("the end of the session is noted after its last output", async ({ page }) => {
  await openShell(page);
  await page.evaluate(async () => {
    await window.__fake.emitExecOutput("exec-1", "bye\r\n");
    await window.__fake.emitExecClosed("exec-1");
  });
  await expect(rows(page)).toContainText("bye");
  await expect(rows(page)).toContainText("[session closed]");
  const text = (await rows(page).textContent()) ?? "";
  expect(text.indexOf("bye")).toBeLessThan(text.indexOf("[session closed]"));
});

test("an attach note sent before the start answers shows first", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: "Attach", exact: true }).click();
  await expect.poll(() => fake.calls("cmdAttachStart")).toHaveLength(1);
  await expect(rows(page)).toContainText("Closing this tab detaches");
});

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp } from "./helpers";

// In-app updates (#30). The fake backend behaves like a release build: the
// check on start runs unless Settings turn it off (fixtures/updates.ts).

const banner = (page: Page) => page.getByTestId("update-banner");
const notice = (page: Page) => page.getByTestId("update-notice");
const noticeText = (page: Page) => notice(page).locator(".text");
const RELEASE = "https://github.com/nexburst/nauvi/releases/tag/v0.2.0";

async function openSettings(page: Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  return page.getByRole("dialog", { name: "Settings" });
}

test("a newer release shows a banner; install only starts on a click, with progress", async ({ page }) => {
  const fake = await openApp(page, (_c, f) => f.offerUpdate("0.2.0"));
  await expect(banner(page)).toContainText("nauvi 0.2.0 is available — Release notes · Install and restart");
  expect((await fake.calls("cmdUpdateCheck")).map((c) => c.startup)).toEqual([true]);
  expect(await fake.calls("cmdUpdateInstall")).toEqual([]);

  await banner(page).getByRole("button", { name: "Release notes" }).click();
  await expect.poll(() => page.evaluate(() => window.__fake.opened())).toEqual([RELEASE]);
  expect(await fake.calls("cmdUpdateInstall")).toEqual([]);

  await banner(page).getByRole("button", { name: "Install and restart" }).click();
  const progress = page.getByTestId("update-progress");
  await expect(progress).toContainText("Downloading… 45% (6.1 of 13.5 MB)");
  await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "45");
  // No closing or second install while it runs.
  await expect(banner(page).getByRole("button", { name: "Dismiss update" })).toHaveCount(0);
  await expect(banner(page).getByRole("button", { name: "Install and restart" })).toBeDisabled();

  await page.evaluate(() => window.__fake.finishUpdateDownload());
  await expect(progress).toContainText("Installing…");
  await expect.poll(() => page.evaluate(() => window.__fake.restarted())).toBe(true);
  expect(await fake.calls("cmdUpdateInstall")).toHaveLength(1);
  expect(fake.errors).toEqual([]);
});

test("a failed install says why and can be tried again", async ({ page }) => {
  const fake = await openApp(page, (_c, f) => {
    f.offerUpdate("0.2.0");
    f.failNext("cmdUpdateInstall", "Could not download nauvi 0.2.0: connection reset");
  });
  await banner(page).getByRole("button", { name: "Install and restart" }).click();
  await expect(banner(page).getByRole("alert")).toHaveText("Could not download nauvi 0.2.0: connection reset");
  await expect(page.getByTestId("update-progress")).toHaveCount(0);
  await banner(page).getByRole("button", { name: "Install and restart" }).click();
  await expect(page.getByTestId("update-progress")).toContainText("Downloading…");
  expect(await fake.calls("cmdUpdateInstall")).toHaveLength(2);
});

test("where the update cannot be installed in place, the banner links to the release page", async ({ page }) => {
  await openApp(page, (_c, f) =>
    f.offerUpdate(
      "0.2.0",
      false,
      "nauvi was installed from a .deb package, and this release has no signed .deb update.",
    ),
  );
  await expect(banner(page)).toContainText("nauvi 0.2.0 is available — Release notes · Download from the release page");
  await expect(banner(page)).toContainText("installed from a .deb package");
  await expect(banner(page).getByRole("button", { name: "Install and restart" })).toHaveCount(0);
  await banner(page).getByRole("button", { name: "Download from the release page" }).click();
  await expect.poll(() => page.evaluate(() => window.__fake.opened())).toEqual([RELEASE]);
});

test("a .deb from the apt repository says to update with apt, with no Install button (#427)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp(page, (_c, f) =>
    f.offerUpdate(
      "0.2.0",
      false,
      "nauvi was installed from the nauvi apt repository, so apt updates it.",
      "sudo apt update && sudo apt install nauvi",
    ),
  );
  await expect(banner(page)).toContainText(
    "nauvi 0.2.0 is available — Release notes · Update with apt: sudo apt update && sudo apt install nauvi",
  );
  await expect(banner(page)).toContainText("installed from the nauvi apt repository");
  await expect(banner(page).getByRole("button", { name: "Install and restart" })).toHaveCount(0);
  await expect(banner(page).getByRole("button", { name: "Download from the release page" })).toHaveCount(0);
  const text = banner(page).locator(".text");
  const lineHeight = await text.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 18);
  expect((await text.boundingBox())!.height).toBeLessThan(lineHeight * 1.5);

  await banner(page).getByRole("button", { name: "Copy" }).click();
  await expect(banner(page).getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("sudo apt update && sudo apt install nauvi");
});

test("a long note does not squeeze the banner's text into a column (#124)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openApp(page, (_c, f) =>
    f.offerUpdate(
      "9.9.9",
      false,
      "This copy was not installed from a release download, so it cannot update itself. Download the new version from the release page.",
    ),
  );
  const text = banner(page).locator(".text");
  const note = banner(page).locator(".note");
  await expect(note).toContainText("cannot update itself");
  // The main text is one line, left of the note.
  const lineHeight = await text.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 18);
  const t = (await text.boundingBox())!;
  const n = (await note.boundingBox())!;
  expect(t.height).toBeLessThan(lineHeight * 1.5);
  expect(n.x).toBeGreaterThanOrEqual(t.x + t.width);
  // The ✕ stays at the right end of the banner.
  const b = (await banner(page).boundingBox())!;
  const x = (await banner(page).getByRole("button", { name: "Dismiss update" }).boundingBox())!;
  expect(b.x + b.width - (x.x + x.width)).toBeLessThan(20);
});

// The notes of `updater::ReadOnlyLocation` (#206).
const READ_ONLY_NOTES = [
  "nauvi is running from the disk image, which is read-only. Move nauvi to Applications to update it in place, or download the new version from the release page.",
  "macOS runs this copy of nauvi from a temporary read-only location (App Translocation). Move nauvi to Applications with Finder to update it in place, or download the new version from the release page.",
];

for (const [i, note] of READ_ONLY_NOTES.entries()) {
  test(`a copy on a disk image or translocated offers no install (#206, ${i ? "translocated" : "disk image"})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    // `init` is serialized, so the note reaches it through the page.
    await page.addInitScript((n) => ((window as unknown as { note206: string }).note206 = n), note);
    await openApp(page, (_c, f) =>
      f.offerUpdate("0.2.0", false, (window as unknown as { note206: string }).note206),
    );
    await expect(banner(page)).toContainText("nauvi 0.2.0 is available — Release notes · Download from the release page");
    await expect(banner(page).getByRole("button", { name: "Install and restart" })).toHaveCount(0);
    const text = banner(page).locator(".text");
    const noteEl = banner(page).locator(".note");
    await expect(noteEl).toHaveText(note);
    await expect(noteEl).toContainText("Move nauvi to Applications");
    // One line of text with the note next to it or below, inside the banner.
    const lineHeight = await text.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 18);
    const t = (await text.boundingBox())!;
    const n = (await noteEl.boundingBox())!;
    const b = (await banner(page).boundingBox())!;
    expect(t.height).toBeLessThan(lineHeight * 1.5);
    expect(n.x + n.width).toBeLessThanOrEqual(b.x + b.width);
    await banner(page).getByRole("button", { name: "Download from the release page" }).click();
    await expect.poll(() => page.evaluate(() => window.__fake.opened())).toEqual([RELEASE]);
  });
}

test("the banner can be closed, and checking again brings it back", async ({ page }) => {
  await openApp(page, (_c, f) => f.offerUpdate("0.2.0"));
  await banner(page).getByRole("button", { name: "Dismiss update" }).click();
  await expect(banner(page)).toHaveCount(0);

  const dialog = await openSettings(page);
  await dialog.getByRole("button", { name: "Check for updates" }).click();
  await expect(dialog.getByTestId("update-status")).toHaveText("nauvi 0.2.0 is available (you have 0.1.0).");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(banner(page)).toBeVisible();
});

test("turning the check off in Settings skips it on start; asking still checks", async ({ page }) => {
  const fake = await openApp(page, (_c, f) => f.offerUpdate("0.2.0"));
  await expect(banner(page)).toBeVisible();
  const dialog = await openSettings(page);
  const toggle = dialog.getByRole("checkbox", { name: "Check for updates on start" });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  expect((await fake.lastCall("cmdUpdateSettings")).patch).toEqual({ check_updates: false });

  // Restart: the setting is remembered and the check is skipped.
  await page.reload();
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toBeVisible();
  await expect.poll(() => fake.calls("cmdUpdateCheck")).toHaveLength(1);
  expect((await fake.calls("cmdUpdateCheck"))[0].startup).toBe(true);
  await expect(banner(page)).toHaveCount(0);
  await expect(notice(page)).toHaveCount(0);

  const again = await openSettings(page);
  await expect(again.getByRole("checkbox", { name: "Check for updates on start" })).not.toBeChecked();
  await again.getByRole("button", { name: "Check for updates" }).click();
  expect((await fake.lastCall("cmdUpdateCheck")).startup).toBe(false);
  await again.getByRole("button", { name: "Close" }).click();
  await expect(banner(page)).toContainText("nauvi 0.2.0 is available");
});

test("Check for updates is in the palette and says when there is nothing new", async ({ page }) => {
  const fake = await openApp(page);
  await expect.poll(() => fake.calls("cmdUpdateCheck")).toHaveLength(1);
  // Up to date on start: nothing is shown.
  await expect(notice(page)).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("check for updates");
  await page.keyboard.press("Enter");
  await expect(noticeText(page)).toHaveText("nauvi 0.1.0 is the latest version.");
  expect((await fake.lastCall("cmdUpdateCheck")).startup).toBe(false);
  await notice(page).getByRole("button", { name: "Dismiss" }).click();
  await expect(notice(page)).toHaveCount(0);

  await fake.failNext("cmdUpdateCheck", "Could not check for updates: error sending request");
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type("check for updates");
  await page.keyboard.press("Enter");
  await expect(noticeText(page)).toHaveText("Could not check for updates: error sending request");
});

test("a failed check on start stays quiet", async ({ page }) => {
  const fake = await openApp(page, (_c, f) => f.failNext("cmdUpdateCheck", "Could not check for updates: offline"));
  await expect.poll(() => fake.calls("cmdUpdateCheck")).toHaveLength(1);
  await expect(notice(page)).toHaveCount(0);
  await expect(banner(page)).toHaveCount(0);
});

test("only the main window checks on start", async ({ page }) => {
  const fake = await openApp(page, (_c, f) => f.offerUpdate("0.2.0"), { url: "/test.html?window=cluster-1" });
  await expect(page.getByRole("navigation").getByRole("button", { name: "Pods", exact: true })).toBeVisible();
  // Give a start-up check time to happen if it were going to.
  await page.waitForTimeout(300);
  expect(await fake.calls("cmdUpdateCheck")).toEqual([]);
  await expect(banner(page)).toHaveCount(0);
});

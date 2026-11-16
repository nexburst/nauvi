// The Secret / ConfigMap data editor in the detail panel (#224).

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";

async function open(page: Page, kindLabel: string, name: string) {
  const fake = await openApp(page);
  await openKind(page, kindLabel);
  await row(page, name).click();
  const editor = page.getByTestId("data-editor");
  await expect(editor.locator("li").first()).toBeVisible();
  return { fake, editor };
}

function entry(editor: Locator, key: string): Locator {
  return editor.locator(`li[data-key="${key}"]`);
}

function btn(scope: Locator, name: string): Locator {
  return scope.getByRole("button", { name, exact: true });
}

/** Record clipboard writes instead of using the real clipboard. */
async function fakeClipboard(page: Page) {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (t: string) => void copied.push(t) },
      configurable: true,
    });
  });
}
const copied = (page: Page) => page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);

test("Secret values stay hidden until one key is revealed", async ({ page }) => {
  const { fake, editor } = await open(page, "Secrets", "db-creds");
  await expect(editor).toContainText("password");
  await expect(editor).toContainText("7 bytes");
  await expect(editor).toContainText("Values are hidden until you reveal them");
  // Nothing was read and nothing is on the page.
  expect(await fake.calls("cmdRevealDataValue")).toHaveLength(0);
  await expect(page.locator("body")).not.toContainText("hunter2");

  await btn(entry(editor, "password"), "Reveal").click();
  await expect(entry(editor, "password").getByTestId("data-value")).toHaveText("hunter2");
  expect(await fake.calls("cmdRevealDataValue")).toEqual([
    expect.objectContaining({ namespace: "demo", name: "db-creds", key: "password" }),
  ]);
  // Only that key.
  await expect(entry(editor, "tls.key").getByLabel("Hidden value")).toBeVisible();

  await btn(entry(editor, "password"), "Hide").click();
  await expect(page.locator("body")).not.toContainText("hunter2");
});

test("a binary Secret value shows as base64, read-only unless edited as base64", async ({ page }) => {
  const { editor } = await open(page, "Secrets", "db-creds");
  const key = entry(editor, "tls.key");
  await expect(key).toContainText("binary");
  await btn(key, "Reveal").click();
  await expect(key.getByTestId("data-value")).toHaveText("/w==");
  await expect(key).toContainText("Binary value, shown as base64.");
  await expect(key.getByRole("textbox")).toHaveCount(0);

  await btn(key, "Edit as base64").click();
  const box = key.getByRole("textbox", { name: "Value of tls.key" });
  await box.fill("not base64!");
  await expect(key).toContainText("Not valid base64.");
  await btn(editor, "Save").click();
  await expect(editor.getByRole("alert")).toContainText("Not valid base64: tls.key.");
});

test("copy reads a hidden value on the click only and keeps it hidden", async ({ page }) => {
  await fakeClipboard(page);
  const { fake, editor } = await open(page, "Secrets", "db-creds");
  expect(await copied(page)).toEqual([]);
  await btn(entry(editor, "password"), "Copy").click();
  await expect(editor.getByRole("status")).toHaveText('Copied the value of "password".');
  expect(await copied(page)).toEqual(["hunter2"]);
  expect(await fake.calls("cmdRevealDataValue")).toHaveLength(1);
  await expect(page.locator("body")).not.toContainText("hunter2");
});

test("editing a Secret key saves a patch of only that key", async ({ page }) => {
  const { fake, editor } = await open(page, "Secrets", "db-creds");
  const key = entry(editor, "password");
  await btn(key, "Edit").click();
  const box = key.getByRole("textbox", { name: "Value of password" });
  await expect(box).toHaveValue("hunter2");
  await box.fill("s3cret");
  await expect(editor).toContainText("1 changed");
  // Typing the old value back is no change.
  await box.fill("hunter2");
  await expect(btn(editor, "Save")).toHaveCount(0);
  await box.fill("s3cret");

  await btn(editor, "Save").click();
  await expect(editor.getByRole("status")).toHaveText("Saved.");
  const call = await fake.lastCall("cmdPatchData");
  expect(call.changes).toEqual([{ key: "password", field: "data", delete: false, value: "s3cret", encoding: "text" }]);
  expect(call.resourceVersion).toBe("1");
  // The saved value is hidden again.
  await expect(page.locator("body")).not.toContainText("s3cret");
  await btn(key, "Reveal").click();
  await expect(key.getByTestId("data-value")).toHaveText("s3cret");
});

test("a ConfigMap shows its values; add, edit and remove keys in one save", async ({ page }) => {
  const { fake, editor } = await open(page, "Config Maps", "settings");
  await expect(entry(editor, "mode").getByTestId("data-value")).toHaveText("dev");
  await expect(btn(editor, "Reveal")).toHaveCount(0);

  await btn(entry(editor, "mode"), "Edit").click();
  await entry(editor, "mode").getByRole("textbox").fill("prod");
  await editor.getByRole("button", { name: "Remove app.conf" }).click();
  await expect(entry(editor, "app.conf")).toContainText("Removed when you save.");
  await btn(editor, "Add key").click();
  await editor.getByRole("textbox", { name: "New key" }).fill("bad key");
  await expect(editor).toContainText('" " is not allowed');
  await editor.getByRole("textbox", { name: "New key" }).fill("mode");
  await expect(editor).toContainText('"mode" already exists.');
  await editor.getByRole("textbox", { name: "New key" }).fill("level");
  await editor.getByRole("textbox", { name: "New value" }).fill("debug");
  await btn(editor, "Add").click();
  await expect(editor).toContainText("1 changed, 1 added, 1 removed");

  await btn(editor, "Save").click();
  await expect(editor.getByRole("status")).toHaveText("Saved.");
  expect((await fake.lastCall("cmdPatchData")).changes).toEqual([
    { key: "app.conf", field: "data", delete: true, value: "", encoding: "text" },
    { key: "level", field: "data", delete: false, value: "debug", encoding: "text" },
    { key: "mode", field: "data", delete: false, value: "prod", encoding: "text" },
  ]);
  await expect(entry(editor, "level").getByTestId("data-value")).toHaveText("debug");
  await expect(entry(editor, "app.conf")).toHaveCount(0);
});

test("a conflict keeps the edits and can save them over the latest version", async ({ page }) => {
  const { fake, editor } = await open(page, "Config Maps", "settings");
  await btn(entry(editor, "mode"), "Edit").click();
  await entry(editor, "mode").getByRole("textbox").fill("prod");
  await page.evaluate(() => (window.__fake.cluster.resourceVersions["v1/configmaps|demo/settings"] = 5));
  await btn(editor, "Save").click();
  await expect(editor.getByRole("alert")).toContainText("This ConfigMap changed on the server since you loaded it.");
  await expect(entry(editor, "mode").getByRole("textbox")).toHaveValue("prod");

  await btn(editor, "Save my keys over it").click();
  await expect(editor.getByRole("status")).toHaveText("Saved.");
  expect((await fake.lastCall("cmdPatchData")).resourceVersion).toBe("5");
});

test("without permission to patch, the data is read-only", async ({ page }) => {
  const fake = await openApp(page);
  await page.evaluate(() => (window.__fake.cluster.deniedActions.edit = "cannot patch secrets in demo"));
  await openKind(page, "Secrets");
  await row(page, "db-creds").click();
  const editor = page.getByTestId("data-editor");
  await expect(editor.getByTestId("data-readonly")).toHaveText("Read-only: cannot patch secrets in demo");
  await expect(btn(entry(editor, "password"), "Edit")).toBeDisabled();
  await expect(editor.getByRole("button", { name: "Remove password" })).toBeDisabled();
  await expect(btn(editor, "Add key")).toBeDisabled();
  // Reveal and Copy still work: they only read.
  await btn(entry(editor, "password"), "Reveal").click();
  await expect(entry(editor, "password").getByTestId("data-value")).toHaveText("hunter2");
  expect(await fake.calls("cmdPatchData")).toHaveLength(0);
});

test("an immutable ConfigMap is read-only", async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => (window.__fake.cluster.data["v1/configmaps|demo/settings"].immutable = true));
  await openKind(page, "Config Maps");
  await row(page, "settings").click();
  const editor = page.getByTestId("data-editor");
  await expect(editor.getByTestId("data-readonly")).toContainText("This ConfigMap is immutable");
  await expect(btn(entry(editor, "mode"), "Edit")).toBeDisabled();
});

test("unsaved edits are guarded and kept across the YAML tab", async ({ page }) => {
  const { editor } = await open(page, "Config Maps", "settings");
  await btn(entry(editor, "mode"), "Edit").click();
  await entry(editor, "mode").getByRole("textbox").fill("prod");

  const aside = page.locator("aside");
  await aside.getByRole("tab", { name: "YAML" }).click();
  await aside.getByRole("tab", { name: "Overview" }).click();
  await expect(entry(page.getByTestId("data-editor"), "mode").getByRole("textbox")).toHaveValue("prod");

  const dialog = page.getByRole("alertdialog", { name: "Discard changes?" });
  await page.getByRole("button", { name: "Close details" }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(aside).toBeVisible();
  await page.getByRole("button", { name: "Close details" }).click();
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  await expect(page.getByTestId("detail-panel")).toHaveCount(0);

  // Reopened: the server's value, no leftover edit.
  await row(page, "settings").click();
  await expect(entry(page.getByTestId("data-editor"), "mode").getByTestId("data-value")).toHaveText("dev");
});

test("a kept draft does not follow the user to another context", async ({ page }) => {
  const { fake, editor } = await open(page, "Config Maps", "settings");
  await btn(entry(editor, "mode"), "Edit").click();
  await entry(editor, "mode").getByRole("textbox").fill("prod");
  // Kept while the editor is unmounted.
  const aside = page.locator("aside");
  await aside.getByRole("tab", { name: "YAML" }).click();

  const context = page.getByRole("combobox", { name: "Cluster context" });
  const dialog = page.getByRole("alertdialog", { name: "Discard changes?" });
  await context.selectOption("prod");
  await dialog.getByRole("button", { name: "Discard changes" }).click();
  expect(await fake.lastCall("cmdSetContext")).toEqual({ name: "prod" });

  // The same-named ConfigMap in the other context: the server's value.
  await openKind(page, "Config Maps");
  await row(page, "settings").click();
  const other = page.getByTestId("data-editor");
  await expect(entry(other, "mode").getByTestId("data-value")).toHaveText("dev");
  await expect(other.getByRole("textbox")).toHaveCount(0);
  await expect(btn(other, "Save")).toHaveCount(0);
});

test("revealed values are dropped when the panel closes", async ({ page }) => {
  const { fake, editor } = await open(page, "Secrets", "db-creds");
  await btn(entry(editor, "password"), "Reveal").click();
  await expect(entry(editor, "password").getByTestId("data-value")).toHaveText("hunter2");
  await page.getByRole("button", { name: "Close details" }).click();
  await expect(page.getByTestId("detail-panel")).toHaveCount(0);
  await row(page, "db-creds").click();
  await expect(entry(page.getByTestId("data-editor"), "password").getByLabel("Hidden value")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("hunter2");
  expect(await fake.calls("cmdRevealDataValue")).toHaveLength(1);
});

test("a failed reveal says why", async ({ page }) => {
  const { fake, editor } = await open(page, "Secrets", "db-creds");
  await fake.failNext("cmdRevealDataValue", 'Not allowed: cannot get secrets "db-creds"');
  await btn(entry(editor, "password"), "Reveal").click();
  await expect(editor.getByRole("alert")).toContainText('Could not read "password": Not allowed');
});

// The pod panel's Environment list with values (#447): ConfigMap values,
// Secret values revealed one key at a time, plain lines for sources that
// are missing or may not be read.

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { openApp, openKind, row } from "./helpers";
import type { Fake } from "./helpers";
import { envCount } from "../../lib/podEnv";
import { POD_ENV } from "../fixtures/pod-env";

const panel = (page: Page) => page.locator("aside");
const card = (page: Page) => panel(page).getByRole("region", { name: "Container app" });
/** The Environment list's summary: its number changes once the values load (#525). */
const envTitle = (page: Page) => card(page).locator("summary").filter({ hasText: /^Environment \(/ });
const envRow = (page: Page, name: string) => card(page).locator(`[data-testid="env-row"][data-name="${name}"]`);

async function openEnv(page: Page): Promise<Fake> {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(panel(page).locator(".title")).toHaveText("demo/web-1");
  // Nothing is loaded before the list is opened.
  expect(await fake.calls("cmdPodEnv")).toHaveLength(0);
  await envTitle(page).click();
  await expect(card(page).getByTestId("env-list")).toBeVisible();
  return fake;
}

test("opening the list loads the values: literals, ConfigMap values, fields, envFrom groups", async ({ page }) => {
  const fake = await openEnv(page);
  expect(await fake.calls("cmdPodEnv")).toEqual([
    expect.objectContaining({ namespace: "demo", pod: "web-1", container: "app" }),
  ]);
  await expect(envRow(page, "MODE").getByTestId("env-value")).toHaveText("production");
  await expect(envRow(page, "LOG_LEVEL").getByTestId("env-value")).toHaveText("dev");
  await expect(envRow(page, "LOG_LEVEL")).toContainText("from ConfigMap settings/mode");
  await expect(envRow(page, "POD_NAME").getByTestId("env-value")).toHaveText("web-1");
  await expect(envRow(page, "CPU_LIMIT").getByTestId("env-value")).toHaveText("resourceFieldRef(limits.cpu)");

  // envFrom: every key under its source, with the prefix; an overridden one says so.
  const groups = card(page).getByTestId("env-group");
  await expect(groups.first()).toContainText("all of ConfigMap settings (prefix CFG_)");
  await expect(groups.first().locator('[data-name="CFG_mode"]')).toContainText("(overridden)");

  // A long value starts folded, one click unfolds it.
  const java = envRow(page, "JAVA_OPTS").getByTestId("env-value");
  await expect(java).toHaveClass(/folded/);
  await envRow(page, "JAVA_OPTS").getByRole("button", { name: "Show all of JAVA_OPTS" }).click();
  await expect(java).not.toHaveClass(/folded/);
  expect(fake.errors).toEqual([]);
});

test("missing and forbidden sources give a plain line, not an empty value", async ({ page }) => {
  await openEnv(page);
  await expect(envRow(page, "FEATURE").getByTestId("env-error")).toHaveText("ConfigMap flags not found");
  await expect(card(page).getByTestId("env-group").nth(1)).toContainText(
    "not allowed to read Secret api-keys in demo",
  );
});

test("a Secret value is revealed one key at a time and hidden again", async ({ page }) => {
  const fake = await openEnv(page);
  const db = envRow(page, "DB_PASSWORD");
  await expect(db.getByTestId("env-value")).toHaveText("••••");
  await expect(db).toContainText("from Secret db-creds/password");
  // No Secret value was read or shown.
  expect(await fake.calls("cmdRevealDataValue")).toHaveLength(0);
  await expect(page.locator("body")).not.toContainText("hunter2");

  await db.getByRole("button", { name: "Reveal DB_PASSWORD" }).click();
  await expect(db.getByTestId("env-value")).toHaveText("hunter2");
  expect(await fake.calls("cmdRevealDataValue")).toEqual([
    expect.objectContaining({ namespace: "demo", name: "db-creds", key: "password" }),
  ]);
  // Only that one: the secret-looking literal stays hidden.
  await expect(envRow(page, "API_TOKEN").getByTestId("env-value")).toHaveText("••••");

  await db.getByRole("button", { name: "Hide DB_PASSWORD" }).click();
  await expect(page.locator("body")).not.toContainText("hunter2");

  // Revealed again, then the list is closed and reopened: hidden again.
  await db.getByRole("button", { name: "Reveal DB_PASSWORD" }).click();
  await expect(db.getByTestId("env-value")).toHaveText("hunter2");
  await envTitle(page).click();
  await envTitle(page).click();
  await expect(envRow(page, "DB_PASSWORD").getByTestId("env-value")).toHaveText("••••");
  await expect(page.locator("body")).not.toContainText("hunter2");
});

test("a secret-looking literal is masked and revealed through the pod", async ({ page }) => {
  const fake = await openEnv(page);
  const tok = envRow(page, "API_TOKEN");
  await expect(tok.getByTestId("env-value")).toHaveText("••••");
  await tok.getByRole("button", { name: "Reveal API_TOKEN" }).click();
  await expect(tok.getByTestId("env-value")).toHaveText("tok-123-literal");
  // Named by its position in the pod spec (env index 2), not only by name.
  expect(await fake.calls("cmdRevealPodEnv")).toEqual([
    expect.objectContaining({ namespace: "demo", pod: "web-1", container: "app", group: -1, index: 2, name: "API_TOKEN" }),
  ]);
});

test("a ConfigMap value that looks like a secret is masked and revealed by its row", async ({ page }) => {
  const fake = await openEnv(page);
  const row = envRow(page, "CFG_secret_token");
  await expect(row.getByTestId("env-value")).toHaveText("••••");
  await expect(row).toContainText("from ConfigMap settings/secret_token");
  await row.getByRole("button", { name: "Reveal CFG_secret_token" }).click();
  await expect(row.getByTestId("env-value")).toHaveText("cm-tok-777");
  expect(await fake.calls("cmdRevealPodEnv")).toEqual([
    expect.objectContaining({ group: 0, index: 2, name: "CFG_secret_token" }),
  ]);
  // Not through the Secret path.
  expect(await fake.calls("cmdRevealDataValue")).toHaveLength(0);
});

test("bidi overrides and zero-width characters are shown as escapes", async ({ page }) => {
  await openEnv(page);
  await expect(envRow(page, "TRICKY").getByTestId("env-value")).toHaveText("abc\\u{202E}def\\u{200B}ghi");
});

test("a reveal that answers after a reload is dropped", async ({ page }) => {
  await openEnv(page);
  // Hold the reveal back until the list has reloaded.
  await page.evaluate(() => {
    window.__podEnvRevealGate = new Promise((r) => ((window as unknown as { __release: () => void }).__release = () => r(null)));
  });
  const tok = envRow(page, "API_TOKEN");
  await tok.getByRole("button", { name: "Reveal API_TOKEN" }).click();
  await card(page).getByRole("button", { name: "Reload" }).click();
  await expect(card(page).getByRole("button", { name: "Reload" })).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as { __release: () => void }).__release();
    window.__podEnvRevealGate = undefined;
  });
  // Give the held answer time to arrive; it must not land on any row.
  await page.waitForTimeout(300);
  await expect(envRow(page, "API_TOKEN").getByTestId("env-value")).toHaveText("••••");
  await expect(page.locator("body")).not.toContainText("tok-123-literal");
  // A new reveal still works.
  await envRow(page, "API_TOKEN").getByRole("button", { name: "Reveal API_TOKEN" }).click();
  await expect(envRow(page, "API_TOKEN").getByTestId("env-value")).toHaveText("tok-123-literal");
});

test("a forbidden reveal says so on its row", async ({ page }) => {
  const fake = await openEnv(page);
  await fake.failNext("cmdRevealDataValue", 'Not allowed: cannot get secrets "db-creds"');
  const db = envRow(page, "DB_PASSWORD");
  await db.getByRole("button", { name: "Reveal DB_PASSWORD" }).click();
  await expect(db.getByTestId("env-reveal-error")).toContainText('Not allowed: cannot get secrets "db-creds"');
  await expect(db.getByTestId("env-value")).toHaveText("••••");
});

test("copy puts a shown value on the clipboard", async ({ page }) => {
  await page.addInitScript(() => {
    const copied: string[] = [];
    (window as unknown as { __copied: string[] }).__copied = copied;
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: async (t: string) => void copied.push(t) },
      configurable: true,
    });
  });
  await openEnv(page);
  await envRow(page, "LOG_LEVEL").getByRole("button", { name: "Copy LOG_LEVEL" }).click();
  await expect(card(page).getByRole("status")).toHaveText("Copied the value of LOG_LEVEL.");
  expect(await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)).toEqual(["dev"]);
  // A hidden value has no Copy until it is revealed.
  await expect(envRow(page, "DB_PASSWORD").getByRole("button", { name: "Copy DB_PASSWORD" })).toHaveCount(0);
});

test("when the values cannot be loaded, the names are still listed", async ({ page }) => {
  const fake = await openApp(page);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await fake.failNext("cmdPodEnv", "Not allowed: your account lacks permission for this action.");
  await envTitle(page).click();
  await expect(card(page).getByTestId("env-load-error")).toContainText("Not allowed");
  await expect(card(page).getByTestId("env-list")).toContainText("DB_PASSWORD");
  await card(page).getByRole("button", { name: "Try again" }).click();
  await expect(envRow(page, "MODE").getByTestId("env-value")).toHaveText("production");
});

test("with envFrom, the title counts the variables the list shows (#525)", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    const app = cluster.details["v1/pods|demo/web-1"].pod.containers.find((c) => c.name === "app")!;
    app.env.push({ name: "CFG_*", source: "configmap:settings" }, { name: "*", source: "secret:api-keys" });
  });
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  // Before the values load, the sources are counted apart.
  const summary = card(page).locator("summary").filter({ hasText: "Environment" });
  await expect(summary).toHaveText("Environment (2 + 2 sources)");
  expect(await fake.calls("cmdPodEnv")).toHaveLength(0);
  await summary.click();
  await expect(card(page).getByTestId("env-list")).toBeVisible();
  const { from, env } = POD_ENV["demo/web-1/app"];
  const n = envCount(from, env);
  await expect(summary).toHaveText(`Environment (${n})`);
  // As many as the list shows, overridden ones aside.
  const shown = card(page).locator('[data-testid="env-row"]');
  const overridden = shown.filter({ hasText: "(overridden)" });
  expect((await shown.count()) - (await overridden.count())).toBe(n);
  // Closed again, the number stays.
  await summary.click();
  await expect(summary).toHaveText(`Environment (${n})`);
});

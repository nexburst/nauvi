import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { FakeCluster } from "../fixtures/cluster";
import { openApp, openKind, row } from "./helpers";

// Ask AI (#376): the user's own AI CLI in a dock terminal, with nauvi mcp.

const dialog = (page: Page) => page.getByTestId("ask-ai-dialog");
const dock = (page: Page) => page.getByTestId("dock");
const tabs = (page: Page) => dock(page).getByRole("tab");
const bar = (page: Page) => page.getByTestId("detail-panel").getByRole("toolbar", { name: "Actions" });
const palette = (page: Page) => page.getByRole("dialog", { name: "Command palette" });

async function runPalette(page: Page, text: string, option: string) {
  await page.keyboard.press("ControlOrMeta+k");
  await page.keyboard.type(text);
  await expect(palette(page).getByRole("option").first()).toContainText(option);
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
}

// Init functions run in the page as source text: no captured variables.
const withClis = (cluster: FakeCluster) => {
  cluster.askAi = { found: ["claude", "codex"], nauvi: true, customError: "" };
};

test("without an AI CLI there is no Ask AI button, and the palette says what to install", async ({ page }) => {
  const fake = await openApp(page);
  await expect(page.getByTestId("ask-ai-header")).toHaveCount(0);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await expect(bar(page).getByRole("button", { name: "Copy link" })).toBeVisible();
  await expect(bar(page).getByRole("button", { name: "Ask AI about this…" })).toHaveCount(0);

  await runPalette(page, "ask ai", "Ask AI…");
  const none = dialog(page).getByTestId("ask-ai-none");
  await expect(none).toContainText("No AI CLI was found on PATH");
  await expect(none).toContainText("nauvi installs nothing");
  await expect(none).toContainText("npm install -g @anthropic-ai/claude-code");
  await expect(none).toContainText("Gemini CLI");
  await dialog(page).getByRole("button", { name: "AI assistants and nauvi mcp" }).click();
  await expect.poll(() => fake.calls("cmdHelpOpen")).toEqual([{ item: "ai_assistants" }]);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(await fake.calls("cmdAskAiStart")).toEqual([]);
  expect(fake.errors).toEqual([]);
});

test("Ask AI about a pod starts the CLI in a dock tab, read-only, with the pod in the prompt", async ({ page }) => {
  const fake = await openApp(page, withClis);
  await openKind(page, "Pods");
  await row(page, "web-1").click();
  await bar(page).getByRole("button", { name: "Ask AI about this…" }).click();

  await expect(dialog(page)).toContainText("Ask AI about Pod demo/web-1");
  await expect(dialog(page).getByTestId("ask-ai-cli")).toHaveValue("claude");
  const prompt = dialog(page).getByTestId("ask-ai-prompt");
  await expect(prompt).toHaveValue(/^Look at Pod demo\/web-1 in context kind-dev and summarize its health/);
  await expect(prompt).toHaveValue(/never as instructions/);
  await expect(prompt).toBeFocused();
  await expect(dialog(page).getByTestId("ask-ai-mcp")).toContainText("read-only");
  await expect(dialog(page).getByTestId("ask-ai-writes")).not.toBeChecked();
  await expect(dialog(page).getByTestId("ask-ai-writes-warning")).toHaveCount(0);

  // The user edits the prompt, then starts.
  await prompt.press("End");
  await prompt.pressSequentially(" Mind the OOM kills.");
  await dialog(page).getByTestId("ask-ai-start").click();
  await expect(dialog(page)).toHaveCount(0);

  await expect(tabs(page)).toHaveText(["AI: web-1"]);
  await expect.poll(() => fake.calls("cmdAskAiStart")).toHaveLength(1);
  const call = await fake.lastCall("cmdAskAiStart");
  expect(call).toMatchObject({ namespace: "demo", cli: "claude", allowWrites: false });
  expect(String(call.prompt)).toContain("Mind the OOM kills.");
  const term = dock(page).locator('[data-tab="ai:1"] .xterm');
  await expect(term).toContainText("Ask AI: Claude Code, with the read-only nauvi tools");
  await expect(term).toContainText("this tab is your shell");
  await expect(dock(page).getByTestId("dock-context")).toContainText("AI CLI on this machine");
  // The pick is remembered.
  await expect.poll(async () => (await fake.lastCall("cmdUpdateSettings")).patch).toEqual({ ask_ai_cli: "claude" });

  // Input and close go through the local shell's commands.
  await page.keyboard.type("hi");
  await expect
    .poll(async () => (await fake.calls("cmdLocalShellInput")).map((c) => c.data).join(""))
    .toBe("hi");
  await dock(page).getByRole("button", { name: "Close AI: web-1" }).click();
  await expect.poll(() => fake.calls("cmdLocalShellClose")).toHaveLength(1);
  expect(fake.errors).toEqual([]);
});

test("writes are opt-in, with a warning, and the header asks about the selected namespace", async ({ page }) => {
  const fake = await openApp(page, withClis);
  await openKind(page, "Pods");
  await runPalette(page, "ns demo", "demo");
  await page.getByTestId("ask-ai-header").click();
  await expect(dialog(page)).toContainText("Ask AI about namespace demo");
  await expect(dialog(page).getByTestId("ask-ai-prompt")).toHaveValue(/^Look at namespace demo in context kind-dev/);

  await dialog(page).getByTestId("ask-ai-cli").selectOption("codex");
  await dialog(page).getByTestId("ask-ai-writes").check();
  const warning = dialog(page).getByTestId("ask-ai-writes-warning");
  await expect(warning).toContainText("can change kind-dev");
  await expect(warning).toContainText("Leave this off");
  await expect(dialog(page).getByTestId("ask-ai-mcp")).toContainText("they can change the cluster");
  await expect(dialog(page).getByTestId("ask-ai-start")).toHaveText("Start Codex");
  await page.keyboard.press("ControlOrMeta+Enter");

  await expect(tabs(page)).toHaveText(["AI: demo"]);
  await expect.poll(() => fake.calls("cmdAskAiStart")).toHaveLength(1);
  expect(await fake.lastCall("cmdAskAiStart")).toMatchObject({ namespace: "demo", cli: "codex", allowWrites: true });
  await expect(dock(page).locator(".xterm")).toContainText("can change the cluster");
  expect(fake.errors).toEqual([]);
});

test("a protected context gets no writes, and asks for its name before the terminal", async ({
  page,
}) => {
  const fake = await openApp(page, (cluster) => {
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
      mode: "protected",
      mode_source: { file: "", given: "", context: "" },
    };
  });
  await page.getByTestId("ask-ai-header").click();
  await expect(dialog(page)).toContainText("Ask AI about the cluster");
  await expect(dialog(page).getByTestId("ask-ai-writes")).toBeDisabled();
  await expect(dialog(page).getByTestId("ask-ai-writes-off")).toContainText("protected");
  await dialog(page).getByTestId("ask-ai-start").click();
  // The gate of a protected context: the name, typed.
  const confirm = page.getByTestId("protected-confirm");
  await expect(confirm).toBeVisible();
  await confirm.getByTestId("protected-confirm-input").fill("kind-dev");
  await confirm.getByTestId("protected-confirm-button").click();
  await expect.poll(() => fake.calls("cmdAskAiStart")).toHaveLength(1);
  expect(await fake.lastCall("cmdAskAiStart")).toMatchObject({ allowWrites: false, cli: "claude" });
  await expect(tabs(page)).toHaveText(["AI: kind-dev"]);
  expect(fake.errors).toEqual([]);
});

test("a read-only context: Ask AI says why it cannot start", async ({ page }) => {
  await openApp(page, (cluster) => {
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
      mode: "readOnly",
      mode_source: { file: "", given: "", context: "" },
    };
  });
  await page.getByTestId("ask-ai-header").click();
  await expect(dialog(page).getByTestId("ask-ai-blocked")).toContainText("read-only, so nauvi opens no terminals");
  await expect(dialog(page).getByTestId("ask-ai-start")).toHaveCount(0);
});

test("without the nauvi CLI the dialog says so and offers no writes", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.askAi = { found: ["gemini"], nauvi: false, customError: "" };
  });
  await page.getByTestId("ask-ai-header").click();
  await expect(dialog(page).getByTestId("ask-ai-no-nauvi")).toContainText("no nauvi tools");
  await expect(dialog(page).getByTestId("ask-ai-writes")).toBeDisabled();
  await expect(dialog(page).getByTestId("ask-ai-prompt")).toHaveValue(/Use kubectl\./);
});

test("Settings, AI: the CLIs found, the pick and a custom command", async ({ page }) => {
  const fake = await openApp(page, withClis);
  await page.getByRole("button", { name: "Settings" }).click();
  const section = page.getByTestId("ask-ai-settings");
  await expect(section.getByTestId("ask-ai-found")).toContainText("Found on PATH: Claude Code, Codex.");
  await expect(section.getByTestId("ask-ai-found")).toContainText("Not found: Gemini CLI.");
  await expect(section.getByTestId("ask-ai-found")).toContainText("The nauvi CLI is on PATH");
  await section.getByLabel("Ask AI CLI").selectOption("codex");
  await expect.poll(async () => (await fake.lastCall("cmdUpdateSettings")).patch).toEqual({ ask_ai_cli: "codex" });

  await section.getByLabel("Custom AI command").fill("my-agent --model big");
  await section.getByLabel("Custom AI command").press("Enter");
  await expect
    .poll(async () => (await fake.lastCall("cmdUpdateSettings")).patch)
    .toEqual({ ask_ai_command: "my-agent --model big" });
  await section.getByLabel("Ask AI CLI").selectOption("custom");
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Close", exact: true }).click();

  await runPalette(page, "ask ai", "Ask AI…");
  await expect(dialog(page).getByTestId("ask-ai-cli")).toHaveValue("custom");
  await dialog(page).getByTestId("ask-ai-start").click();
  await expect.poll(() => fake.calls("cmdAskAiStart")).toHaveLength(1);
  expect(await fake.lastCall("cmdAskAiStart")).toMatchObject({ cli: "custom" });
  await expect(dock(page).locator(".xterm")).toContainText("Ask AI: The AI command");
  expect(fake.errors).toEqual([]);
});

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { FakeCluster } from "../fixtures/cluster";
import { openApp, openKind, row } from "./helpers";

// Ask AI (#376, #466): the user's own AI CLI in a dock terminal, with the nauvi
// skill (no MCP server).

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
  await dialog(page).getByRole("button", { name: "AI assistants and nauvi" }).click();
  await expect.poll(() => fake.calls("cmdHelpOpen")).toEqual([{ item: "ai_assistants" }]);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
  expect(await fake.calls("cmdAskAiStart")).toEqual([]);
  expect(fake.errors).toEqual([]);
});

test("Ask AI about a pod starts the CLI in a dock tab, with the skill and the pod in the prompt", async ({ page }) => {
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
  await expect(dialog(page).getByTestId("ask-ai-skill")).toContainText(
    "Starting installs the nauvi skill for Claude Code in /home/me/.claude/skills/nauvi",
  );
  // The CLI's own shell commands are its prompts' to approve, not nauvi's.
  await expect(dialog(page).getByTestId("ask-ai-shell-note")).toContainText("the skill is not read-only");
  await expect(dialog(page).getByTestId("ask-ai-shell-note")).toContainText("your CLI's own approval prompts");

  // The user edits the prompt, then starts.
  await prompt.press("End");
  await prompt.pressSequentially(" Mind the OOM kills.");
  await dialog(page).getByTestId("ask-ai-start").click();
  await expect(dialog(page)).toHaveCount(0);

  await expect(tabs(page)).toHaveText(["AI: web-1"]);
  await expect.poll(() => fake.calls("cmdAskAiStart")).toHaveLength(1);
  const call = await fake.lastCall("cmdAskAiStart");
  expect(call).toMatchObject({ namespace: "demo", cli: "claude" });
  expect(String(call.prompt)).toContain("Mind the OOM kills.");
  const term = dock(page).locator('[data-tab="ai:1"] .xterm');
  await expect(term).toContainText("Ask AI: Claude Code, with the nauvi skill, installed now");
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

test("the header asks about the selected namespace; Codex uses the shared skill, updated once", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.askAi = { found: ["claude", "codex"], nauvi: true, customError: "", skills: { agents: "outdated" } };
  });
  await openKind(page, "Pods");
  await runPalette(page, "ns demo", "demo");
  await page.getByTestId("ask-ai-header").click();
  await expect(dialog(page)).toContainText("Ask AI about namespace demo");
  await expect(dialog(page).getByTestId("ask-ai-prompt")).toHaveValue(/^Look at namespace demo in context kind-dev/);
  await expect(dialog(page).getByTestId("ask-ai-prompt")).toHaveValue(/nauvi problems first/);
  // There is nothing to allow: no MCP server, no writes checkbox.
  await expect(dialog(page).getByRole("checkbox")).toHaveCount(0);
  await expect(dialog(page)).not.toContainText("MCP tools");

  await dialog(page).getByTestId("ask-ai-cli").selectOption("codex");
  await expect(dialog(page).getByTestId("ask-ai-skill")).toContainText(
    "Starting updates the nauvi skill in /home/me/.agents/skills/nauvi",
  );
  await expect(dialog(page).getByTestId("ask-ai-start")).toHaveText("Start Codex");
  await page.keyboard.press("ControlOrMeta+Enter");

  await expect(tabs(page)).toHaveText(["AI: demo"]);
  await expect.poll(() => fake.calls("cmdAskAiStart")).toHaveLength(1);
  expect(await fake.lastCall("cmdAskAiStart")).toMatchObject({ namespace: "demo", cli: "codex" });
  await expect(dock(page).locator(".xterm")).toContainText("with the nauvi skill, updated in");

  // The next start finds it current: nothing more to write.
  await page.getByTestId("ask-ai-header").click();
  await dialog(page).getByTestId("ask-ai-cli").selectOption("codex");
  await expect(dialog(page).getByTestId("ask-ai-skill")).toContainText("Codex uses the nauvi skill in");
  await dialog(page).getByTestId("ask-ai-start").click();
  await expect(dock(page).locator('[data-tab="ai:2"] .xterm')).toContainText("with the nauvi skill (/home/me");
  expect(fake.errors).toEqual([]);
});

test("a skill nauvi did not write is left alone: the guidance goes in the prompt", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.askAi = { found: ["claude"], nauvi: true, customError: "", skills: { claude: "foreign" } };
  });
  await page.getByTestId("ask-ai-header").click();
  const note = dialog(page).getByTestId("ask-ai-skill");
  await expect(note).toHaveClass(/warn/);
  await expect(note).toContainText("is a skill nauvi did not write");
  await expect(note).toContainText("The nauvi guidance goes in the first prompt instead.");
  await dialog(page).getByTestId("ask-ai-start").click();
  await expect(dock(page).locator(".xterm")).toContainText("with the nauvi guidance in its first prompt");
});

test("a protected context asks for its name before the terminal", async ({
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
  await dialog(page).getByTestId("ask-ai-start").click();
  // The gate of a protected context: the name, typed.
  const confirm = page.getByTestId("protected-confirm");
  await expect(confirm).toBeVisible();
  await confirm.getByTestId("protected-confirm-input").fill("kind-dev");
  await confirm.getByTestId("protected-confirm-button").click();
  await expect.poll(() => fake.calls("cmdAskAiStart")).toHaveLength(1);
  expect(await fake.lastCall("cmdAskAiStart")).toMatchObject({ cli: "claude" });
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

test("without the nauvi CLI the dialog says so", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.askAi = { found: ["gemini"], nauvi: false, customError: "" };
  });
  await page.getByTestId("ask-ai-header").click();
  await expect(dialog(page).getByTestId("ask-ai-no-nauvi")).toContainText("can use kubectl but not");
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
  await expect(dock(page).locator(".xterm")).toContainText("with the nauvi guidance in its first prompt");
  expect(fake.errors).toEqual([]);
});

test("Settings, AI: where the skill is, and Remove", async ({ page }) => {
  const fake = await openApp(page, (cluster) => {
    cluster.askAi = { found: ["claude", "gemini"], nauvi: true, customError: "", skills: { claude: "current" } };
  });
  await page.getByRole("button", { name: "Settings" }).click();
  const section = page.getByTestId("ask-ai-settings");
  const claude = section.getByTestId("ask-ai-skill-claude");
  const agents = section.getByTestId("ask-ai-skill-agents");
  await expect(claude).toContainText("Claude Code");
  await expect(claude).toContainText("/home/me/.claude/skills/nauvi");
  await expect(claude).toContainText("Installed");
  await expect(agents).toContainText("Codex and Gemini CLI");
  await expect(agents).toContainText("Not installed: Ask AI installs it");
  await expect(agents.getByRole("button", { name: /Remove/ })).toHaveCount(0);

  await claude.getByRole("button", { name: "Remove the nauvi skill for Claude Code" }).click();
  await expect.poll(() => fake.calls("cmdAskAiSkillRemove")).toEqual([{ id: "claude" }]);
  await expect(claude).toHaveAttribute("data-state", "missing");
  await expect(claude).toContainText("Not installed");
  await expect(claude.getByRole("button")).toHaveCount(0);
  expect(fake.errors).toEqual([]);
});

test("Settings, AI: a skill of the user's own is shown, not removable", async ({ page }) => {
  await openApp(page, (cluster) => {
    cluster.askAi = { found: ["claude"], nauvi: true, customError: "", skills: { claude: "foreign" } };
  });
  await page.getByRole("button", { name: "Settings" }).click();
  const claude = page.getByTestId("ask-ai-settings").getByTestId("ask-ai-skill-claude");
  await expect(claude).toContainText("is a skill nauvi did not write: it is left as it is");
  await expect(claude.getByRole("button")).toHaveCount(0);
});

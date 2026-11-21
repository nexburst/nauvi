// Ask AI (`commands/ask_ai.rs`, #376): the CLIs "on PATH" and the terminal
// it starts, which is a local shell session.

import type { AskAiCli } from "../../lib/bindings";
import type { FakeAskAi } from "../fixtures/cluster";
import { startTerm } from "./state";
import type { AreaHandlers, FakeState } from "./state";

const KNOWN = [
  { id: "claude", label: "Claude Code", install: "npm install -g @anthropic-ai/claude-code" },
  { id: "codex", label: "Codex", install: "npm install -g @openai/codex" },
  { id: "gemini", label: "Gemini CLI", install: "npm install -g @google/gemini-cli" },
];

// No CLI by default, so the other tests see no Ask AI.
const DEFAULT: FakeAskAi = { found: [], nauvi: true, customError: "" };

export function askAiHandlers(s: FakeState) {
  const config = () => s.cluster.askAi ?? DEFAULT;
  const setup = () => {
    const c = config();
    const cli = (k: (typeof KNOWN)[number], found: boolean): AskAiCli => ({
      ...k,
      path: found ? `/usr/local/bin/${k.id}` : "",
    });
    const found = KNOWN.filter((k) => c.found.includes(k.id)).map((k) => cli(k, true));
    const missing = KNOWN.filter((k) => !c.found.includes(k.id)).map((k) => cli(k, false));
    const command = s.cluster.settings.ask_ai_command;
    let customError = "";
    if (command) {
      if (c.customError) customError = c.customError;
      else
        found.push({
          id: "custom",
          label: "Custom command",
          path: `/home/me/bin/${command.split(" ")[0]}`,
          install: "",
        });
    }
    const chosen = (found.find((f) => f.id === s.cluster.settings.ask_ai_cli) ?? found[0])?.id ?? "";
    return { found, missing, chosen, nauvi: c.nauvi ? "/usr/local/bin/nauvi" : "", custom_error: customError };
  };
  return {
    cmdAskAiSetup: () => setup(),
    // Like the backend: writes only on a normal context.
    cmdAskAiStart: (namespace, cli, _prompt, allowWrites, _cols, _rows, onOutput) => {
      const context = s.cluster.contexts.find((c) => c.current)?.name ?? "";
      const mode = s.cluster.settings.contexts[context]?.mode ?? "normal";
      if (allowWrites && mode !== "normal")
        throw `${context} is ${mode === "readOnly" ? "read-only" : mode}: the assistant gets only the read-only tools`;
      const found = setup().found.find((f) => f.id === cli);
      if (!found) throw `${cli} is not on PATH. Install it, or pick another CLI in Settings, AI.`;
      return {
        session: startTerm(s, `local-${++s.sessionSeq}`, onOutput),
        context,
        namespace: namespace ?? "default",
        cli: cli === "custom" ? "The AI command" : found.label,
        mcp: config().nauvi ? (allowWrites ? "writes" : "read-only") : "",
        kubectl: "",
      };
    },
  } satisfies AreaHandlers;
}

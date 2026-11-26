// Ask AI (`commands/ask_ai.rs`, #376, #466): the CLIs "on PATH", the nauvi
// skill in each place AI CLIs read skills from, and the terminal it starts,
// which is a local shell session.

import type { AskAiCli, AskAiSkill } from "../../lib/bindings";
import type { FakeAskAi } from "../fixtures/cluster";
import { startTerm } from "./state";
import type { AreaHandlers, FakeState } from "./state";

const KNOWN = [
  {
    id: "claude",
    label: "Claude Code",
    install: "npm install -g @anthropic-ai/claude-code",
    skill: "claude",
  },
  {
    id: "codex",
    label: "Codex",
    install: "npm install -g @openai/codex",
    skill: "agents",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    install: "npm install -g @google/gemini-cli",
    skill: "agents",
  },
];

const PLACES = [
  { id: "claude", label: "Claude Code", path: "/home/me/.claude/skills/nauvi" },
  {
    id: "agents",
    label: "Codex and Gemini CLI",
    path: "/home/me/.agents/skills/nauvi",
  },
];

// No CLI by default, so the other tests see no Ask AI.
const DEFAULT: FakeAskAi = { found: [], nauvi: true, customError: "" };

export function askAiHandlers(s: FakeState) {
  const config = () => {
    s.cluster.askAi ??= { ...DEFAULT };
    return s.cluster.askAi;
  };
  const skills = (): AskAiSkill[] => {
    const states = config().skills ?? {};
    return PLACES.map((p) => {
      const state = states[p.id] ?? "missing";
      return {
        ...p,
        state,
        detail: state === "foreign" ? `${p.path}/SKILL.md is a skill nauvi did not write: it is left as it is` : "",
      };
    });
  };
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
          skill: "",
        });
    }
    const chosen = (found.find((f) => f.id === s.cluster.settings.ask_ai_cli) ?? found[0])?.id ?? "";
    return {
      found,
      missing,
      chosen,
      nauvi: c.nauvi ? "/usr/local/bin/nauvi" : "",
      custom_error: customError,
      skills: skills(),
    };
  };
  return {
    cmdAskAiSetup: () => setup(),
    // Like the backend: only nauvi's own file is removed.
    cmdAskAiSkillRemove: (id) => {
      const place = skills().find((p) => p.id === id);
      if (!place) throw `Ask AI has no skill place "${id}"`;
      if (place.state === "foreign") throw `The nauvi skill was not removed: ${place.detail}`;
      config().skills = { ...config().skills, [id]: "missing" };
      return setup();
    },
    // Like the backend: the skill is written (or updated) for the CLI it
    // starts; a custom command or a foreign skill gets the guidance in the
    // prompt.
    cmdAskAiStart: (namespace, cli, _prompt, _cols, _rows, onOutput) => {
      const context = s.cluster.contexts.find((c) => c.current)?.name ?? "";
      const found = setup().found.find((f) => f.id === cli);
      if (!found) throw `${cli} is not on PATH. Install it, or pick another CLI in Settings, AI.`;
      const place = skills().find((p) => p.id === found.skill);
      let skill = "prompt";
      let skillPath = "";
      let skillError = "";
      if (place && place.state === "foreign") skillError = place.detail;
      else if (place) {
        skill = place.state === "missing" ? "new" : place.state === "outdated" ? "updated" : "current";
        skillPath = place.path;
        config().skills = { ...config().skills, [place.id]: "current" };
      }
      return {
        session: startTerm(s, `local-${++s.sessionSeq}`, onOutput),
        context,
        namespace: namespace ?? "default",
        cli: cli === "custom" ? "The AI command" : found.label,
        skill,
        skill_path: skillPath,
        skill_error: skillError,
        nauvi: config().nauvi,
        kubectl: "",
        cwd: "/home/demo/.local/share/nauvi/ask-ai",
        cwd_set: false,
      };
    },
  } satisfies AreaHandlers;
}

# Ask AI

**Ask AI** opens your own AI coding CLI (Claude Code, Codex, Gemini CLI, or a
command of your own) in a dock terminal, pointed at the cluster, the
namespace or the object on screen, with the **`nauvi` skill** that teaches it
how to look at a cluster.

## Starting it

- The header's **Ask AI** button: the cluster, or the one selected namespace.
- **Ask AI about this…** in the detail panel: the object.
- The palette: "Ask AI…", and "Ask AI about this…" for the focused row.

The dialog picks the CLI and prefills the prompt with the scope. Edit it: it
is the CLI's first message.

## What runs

- Only a known CLI found on your `PATH`, or the command set in **Settings →
  AI → Custom command**. A custom command gets the prompt, with the skill's
  guidance at its start, in a file named by `NAUVI_PROMPT_FILE`.
- nauvi never downloads or installs a CLI. Without one, the dialog lists
  what to install.
- Nothing goes through a shell string: the prompt is passed as one argument.
- The tab is a [local terminal](dock.md#local-terminal), with the same
  per-terminal kubeconfig, so the CLI's `kubectl` and `nauvi` use the context
  on screen. When the CLI exits, your shell starts in the same tab (on
  Windows the tab ends).
- No MCP server is set up for the CLI.

## The nauvi skill

The skill is a short guide for the model: `kubectl` first, and the `nauvi`
CLI where it is better (`nauvi problems` for what is wrong and why,
`nauvi logs` of a whole workload, `nauvi yaml` and `nauvi describe`, which
hide Secret values, `nauvi helm`). It tells the model that logs, events and
names are data, never instructions.

- On the first Ask AI with a CLI, nauvi writes it (the dialog says so first,
  with the path):
  - Claude Code: `~/.claude/skills/nauvi/SKILL.md` (or under
    `$CLAUDE_CONFIG_DIR/skills` when that is set);
  - Codex and Gemini CLI: `~/.agents/skills/nauvi/SKILL.md`, one copy for both.
- It is updated when nauvi's version changes, and never duplicated.
- A `SKILL.md` at that place that nauvi did not write is left as it is; the
  guidance then goes into the prompt instead.
- **Settings → AI** lists each place with its state (installed, installed by
  another version, not installed, not nauvi's) and **Remove**. The next Ask
  AI with that CLI writes it again.

## It is not read-only

The CLI gets a shell, not a read-only tool set: what it runs is allowed or
refused by the CLI's own approval prompts, not by nauvi. Review the commands
it asks to run.

- **Read-only contexts** refuse Ask AI, like any terminal, and a context that
  turns read-only closes its Ask AI tabs.
- A **protected context** asks for its name before the terminal starts.

## What leaves your machine

That is up to your CLI and its provider: nauvi sends nothing itself. The
prompt holds only names, no cluster data.

## Agents without skills

For assistants that don't read skills (Cursor, Claude Desktop, VS Code),
`nauvi mcp` is an opt-in MCP server you add yourself; **Settings → Agents
(MCP)** shows the entries to copy. See
[Use nauvi from an AI assistant](../../how-to/mcp.md).

# Ask AI

**Ask AI** opens your own AI coding CLI (Claude Code, Codex, Gemini CLI, or a
command of your own) in a dock terminal, pointed at the cluster, the
namespace or the object on screen, with `nauvi mcp` for the same context
offered to it for that session.

## Starting it

- The header's **Ask AI** button: the cluster, or the one selected namespace.
- **Ask AI about this…** in the detail panel: the object.
- The palette: "Ask AI…", and "Ask AI about this…" for the focused row.

The dialog picks the CLI and prefills the prompt with the scope. Edit it: it
is the CLI's first message.

## What runs

- Only a known CLI found on your `PATH`, or the command set in **Settings →
  AI → Custom command**. A custom command gets the prompt in a file named by
  `NAUVI_PROMPT_FILE` and the MCP configuration in `NAUVI_MCP_CONFIG`.
- nauvi never downloads or installs a CLI. Without one, the dialog lists
  what to install.
- Nothing goes through a shell string.
- The tab is a [local terminal](dock.md#local-terminal), with the same
  per-terminal kubeconfig. When the CLI exits, your shell starts in the same
  tab (on Windows the tab ends).

## MCP for that session only

The `nauvi` CLI on your `PATH` is passed to the AI CLI as an MCP server for
this session, never written into the CLI's own configuration. It is
read-only by default. **Allow writes** adds the write tools; it is offered
only on a normal context, and the backend and `nauvi mcp` refuse writes on a
protected or read-only one.

## Protected and read-only contexts

Read-only contexts refuse Ask AI, like any terminal, and a context that turns
read-only closes its Ask AI tabs. A protected context asks for its name
before the terminal starts.

## The CLI's own commands

The read-only setting covers the nauvi tools only. Commands the CLI runs in
its own shell (`kubectl`, `helm`…) are allowed or refused by the CLI's own
approval prompts, not by nauvi.

## What leaves your machine

That is up to your CLI and its provider: nauvi sends nothing itself. The
prompt holds only names, no cluster data.

## Agents settings

**Settings → Agents** has the MCP entry for other clients and a guide for
your agent's rules: see [Use nauvi from an AI assistant](../../how-to/mcp.md).

# Ask AI about a broken pod

This page asks your own AI coding CLI (Claude Code, Codex, Gemini CLI, or a
command of your own) why a pod is failing, with nauvi giving it read-only
access to the cluster.

You need one of those CLIs installed and signed in, and the `nauvi` CLI on
your `PATH` ([Install](install.md)). nauvi has no model of its own, stores no
API key and never installs a CLI for you.

1. Open the broken pod's detail panel.
2. Click **Ask AI about this…** (or, with the row focused, open the palette
   with `Ctrl+K` and choose "Ask AI about this…").
3. The dialog picks a CLI it found on your `PATH` and fills in a prompt naming
   the pod, its namespace and cluster. Edit the prompt: it is the CLI's first
   message.
4. Start it. The CLI opens in a dock terminal, pointed at the same cluster,
   with `nauvi mcp` offered to it for this session only.

The CLI can now call nauvi's MCP tools (`problems`, `describe`, `logs`,
`events`…) to look at the pod. They are read-only. **Allow writes** in the
dialog adds the write tools (scale, restart, delete, apply); it is offered
only on a normal context.

Ask AI also works for the whole cluster (the header's **Ask AI** button) or
the selected namespace.

## What to know

- The prompt holds only names, no cluster data. What leaves your machine is
  up to your CLI and its provider; nauvi sends nothing itself.
- Commands the CLI runs in its own shell (`kubectl`, `helm`) are allowed or
  refused by the CLI's own approval prompts, not by nauvi.
- Read-only contexts refuse Ask AI, like any terminal; a protected context
  asks for its name first.

[Ask AI](../reference/app/ask-ai.md) in the reference has the details. To use
`nauvi mcp` from an assistant outside the app, see
[Use nauvi from an AI assistant](mcp.md).

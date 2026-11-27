# Ask AI about a broken pod

This page asks your own AI coding CLI (Claude Code, Codex, Gemini CLI, or a
command of your own) why a pod is failing, in a terminal pointed at the
pod's cluster.

You need one of those CLIs installed and signed in. nauvi has no model of its
own, stores no API key and never installs a CLI for you. With the `nauvi` CLI
on your `PATH` too ([Install](install.md)), the model can use
`nauvi problems` and the other nauvi commands.

1. Open the broken pod's detail panel.
2. Click **Ask AI about this…** (or, with the row focused, open the palette
   with `Ctrl+K` and choose "Ask AI about this…").
3. The dialog picks a CLI it found on your `PATH` and fills in a prompt naming
   the pod, its namespace and cluster. Edit the prompt: it is the CLI's first
   message. The first time, the dialog also says where it will write the
   `nauvi` skill for that CLI.
4. Start it. The CLI opens in a dock terminal, with `kubectl` and `nauvi`
   pointed at the same cluster and namespace.

The skill teaches the model to start with `nauvi problems`, read the pod's
`describe` and logs, and ask before it changes anything. The model runs
commands in its own shell, so **your CLI's approval prompts decide what
runs**: read each command before you allow it.

Ask AI also works for the whole cluster (the header's **Ask AI** button) or
the selected namespace.

## What to know

- The prompt holds only names, no cluster data. What leaves your machine is
  up to your CLI and its provider; nauvi sends nothing itself.
- Read-only contexts refuse Ask AI, like any terminal; a protected context
  asks for its name first.
- Settings → AI shows the skill files nauvi wrote, and removes them.
- The CLI runs in a folder of its own, not your home folder. The session's
  first lines name it.
- The AI follows each object it names with a `nauvi://` link: click it to
  open the object. With **Let Ask AI open views** on, it can open panels and
  tables itself.

[Ask AI](../reference/app/ask-ai.md) in the reference has the details. To use
nauvi from an assistant outside the app, see
[Use nauvi from an AI assistant](mcp.md).

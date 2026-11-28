# Use nauvi from an AI assistant (MCP)

This page connects an AI assistant (Claude Code, Codex, Cursor, Claude
Desktop, VS Code, Gemini CLI, Windsurf…) to your cluster through `nauvi mcp`,
a [Model Context Protocol](https://modelcontextprotocol.io) server.

nauvi has no model of its own and stores no API key: it works with the
coding agent you already have, which signs in itself. You need the `nauvi`
CLI ([Install](install.md)).

`nauvi mcp` is opt-in, for agents that don't read skills. Inside the app,
[Ask AI](../reference/app/ask-ai.md) uses the `nauvi` skill instead and sets
up no MCP server; the app never adds `nauvi mcp` to an agent for you.

## The easy way: copy it from the app

In the desktop app, **Settings → Agents (MCP)** shows the entry for Claude Code,
Codex, VS Code and the clients that share the `mcpServers` form (Cursor,
Claude Desktop, Gemini CLI, Windsurf), pinned to the cluster on screen and
ready to copy. It also has a short guide to paste into your agent's rules
(AGENTS.md, CLAUDE.md or a skill).

**Copy prompt for your AI** (`A` on a row, or the row menu) puts a prompt about that
object on the clipboard: its kind, name, cluster and what the table says is
wrong, never its logs or manifest.

## By hand

Claude Code:

```sh
claude mcp add nauvi -- nauvi mcp
# a fixed context, with the write tools:
claude mcp add nauvi-staging -- nauvi --context staging mcp --allow-writes
```

Claude Desktop (`claude_desktop_config.json`), Cursor (`.cursor/mcp.json`)
and other clients take the same command (VS Code's `.vscode/mcp.json` puts
it under `"servers"`):

```json
{
  "mcpServers": {
    "nauvi": { "command": "nauvi", "args": ["mcp"] }
  }
}
```

- Use the full path to `nauvi` if the client does not see your shell's
  `PATH`.
- Desktop clients often start without your shell's environment: add
  `"env": { "KUBECONFIG": "..." }` if your kubeconfig is not
  `~/.kube/config`.
- Login commands (EKS, GKE, AKS) must log in without a prompt, so sign in
  once in a terminal first.

## What the assistant can do

`nauvi mcp` uses the CLI's kubeconfig and current context (or `--context`,
`--kubeconfig`; never the app's added kubeconfigs) and acts as that user, so
RBAC applies. It connects on the first tool call.

- It is **read-only by default**. `--allow-writes` adds `scale`, `restart`,
  `delete` and `apply`. Turn it on only for a context you would let the
  assistant change: `apply` can create a workload that reads Secrets, and
  `delete` of a Namespace or a CRD deletes everything in it.
- A context set to read-only or protected in the app refuses the write tools,
  even with `--allow-writes`.
- **Secret values are never returned**, only their keys.

Ask it to start a health check with the `problems` tool. [MCP tools](../reference/mcp-tools.md)
lists every tool and its limits.

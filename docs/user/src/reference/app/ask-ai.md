# Ask AI

**Ask AI** opens your own AI coding CLI (Claude Code, Codex, Gemini CLI, or a
command of your own) in a dock terminal, pointed at the cluster, the
namespace or the object on screen, with the **`nauvi` skill** that teaches it
how to look at a cluster.

## Starting it

- The header's **Ask AI** button: the cluster, or the one selected namespace.
- **Ask AI** on a [Problem group or Warning group](overview.md#problem-groups)
  row of the Overview, and on the Problem workloads and Warning groups of
  **Workloads → Overview**: that workload or object, with its reason and
  counts ("18 of 20 pods are in CrashLoopBackOff (171 restarts)").
- **Ask AI about this…** in every table's row menu: the row's object.
- **Ask AI** in the detail panel's action bar: the object.
- **Ask AI about these N** on a table selection: the selected rows.
- The palette: "Ask AI…", and "Ask AI about this…" for the focused row.
- **Ask AI about these N** in the [Ask AI list](#the-ask-ai-list): every
  object you collected.

The dialog picks the CLI and prefills the prompt with the scope. Edit it: it
is the CLI's first message. Without an AI CLI, and on read-only contexts,
only the header's button and the palette offer Ask AI (the dialog then says
why it cannot start); the buttons on rows and panels are hidden.

## The Ask AI list

The Ask AI list (the AI context list) collects several objects, so one Ask
AI looks at them together: say a crash-looping Deployment, the Service in
front of it and a Pending pod.

To add an object:

- **+** on a Problem group or Warning group row, on the Overview and on
  **Workloads → Overview**;
- **Add to Ask AI** in a table's row menu, right after "Ask AI about this…";
- **Add to Ask AI** in the detail panel's action bar;
- `Alt`+click (`Option`+click on macOS) on a table row's name. Some Linux
  window managers take `Alt`+click for themselves; use the row menu there.

Once the list has objects, the header's button reads **Ask AI | 3**. Click
the count to open the list: each object with the reason nauvi showed, a
button to remove it, **Clear**, and **Ask AI about these 3**.

- There is one list per context: switching contexts keeps each list.
- It is kept in memory until the app closes.
- It holds at most 20 objects. An object already in it, or a 21st, cannot
  be added; the button says why.
- Starting an Ask AI from the list empties it. **Cancel** in the dialog
  keeps it.
- **Ask AI about these N** on a table selection does not use or change the
  list.
- An object deleted from the cluster stays in the list until you remove it.

The prompt names each object (kind, namespace/name) with a short reason
("CrashLoopBackOff, 18 of 20 pods"), nothing more.

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

## Where it runs

Ask AI starts the CLI in a folder of its own, `ask-ai` in the app's data
folder ([where](../../explanations/storage.md#the-apps-folders)), not in
your home folder. If the cluster's Settings set a working directory for the
local terminal, it runs there instead. The session's first lines name the
folder.

On macOS, a program nauvi starts (the AI CLI, or a command you type in a
local terminal) that reads Photos, Desktop, Documents or Downloads makes
macOS ask whether **nauvi** may access that folder. nauvi itself never reads
them. **Don't Allow** is safe: nauvi and Ask AI work without that access. If
you set a working directory inside one of those folders, the prompt is
expected. The local terminal starts in your home folder, like any terminal
app, and macOS counts the commands you run there as nauvi's too.

## Links to objects

The AI follows each object it names with its [`nauvi://` link](links.md).
Click one in the Ask AI terminal to open the object in the same window;
hover it to see where it goes. Links printed in pod shells, logs or other
terminals are not opened.

## Let Ask AI open views

With **Settings → AI → Let Ask AI open views** on (it is off by default), the
AI can run `nauvi show` to open an object's panel or a table in the window
of its Ask AI terminal, at most one every 3 seconds.

- It only opens views: no action, no dialog. The panel says **Opened by Ask
  AI**, and Back returns to where you were.
- It applies to Ask AI sessions started after you turn it on.
- Anywhere else, `nauvi show` prints the link
  ([`nauvi show`](../cli/inspect.md#nauvi-show)).

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
prompt holds only names, reasons and counts: no logs, no YAML and no event
messages.

## Agents without skills

For assistants that don't read skills (Cursor, Claude Desktop, VS Code),
`nauvi mcp` is an opt-in MCP server you add yourself; **Settings → Agents
(MCP)** shows the entries to copy. See
[Use nauvi from an AI assistant](../../how-to/mcp.md).
